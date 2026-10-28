import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { EXTERNAL_NOTICE, findTool, runTool, TOOL_BY_NAME } from "@/lib/assistant/tools";
import { scopesForRole } from "@/lib/crm/scopes";
import { removeMember } from "@/lib/crm/team";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { RECALL_REJECTED, recallDetail, recallTags } from "@/lib/recall";
import { recallKey, recallStatus, removeRecallKey, saveRecallKey } from "@/lib/recall/keys";
import { orderChunks, recallRead, recallSearch, TAG_IDS_ONLY, type RecallLiveOptions } from "@/lib/recall/live";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const OWNER_KEY = "sk_owner_recall_key_abcd1234";
const MEMBER_KEY = "sk_member_recall_key_wxyz9876";
const RESEARCH = "6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
const PROJECTS = "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
const ARTICLE_URL = "https://essays.example.test/answer-engines";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const lookup = async () => ["93.184.216.34"];
const noWait = async () => {};

type Logged = { method: string; url: URL; auth: string | null; body: unknown };
type FakeChunk = { chunk_id: string; content: string; source?: string; timestamps?: string[] };
type FakeCard = { id: string; title: string; created_at: string; source_url?: string; tags: string[]; chunks: FakeChunk[] };

const CARDS: FakeCard[] = [
  {
    id: "card-article",
    title: "How answer engines pick sources",
    created_at: "Jan 15, 2025",
    source_url: ARTICLE_URL,
    tags: [RESEARCH],
    chunks: [
      { chunk_id: "a-3", content: "Third, they favour pages that are cited elsewhere.", source: "reader" },
      { chunk_id: "a-1", content: "First, answer engines read the page itself.", source: "reader" },
      { chunk_id: "a-n", content: "My note: send this to Acme.", source: "notebook" },
      { chunk_id: "a-2", content: "Second, they weigh the site's reputation.", source: "reader" },
    ],
  },
  {
    id: "card-video",
    title: "A long talk on AI search",
    created_at: "Feb 2, 2025",
    source_url: VIDEO_URL,
    tags: [PROJECTS],
    chunks: [
      { chunk_id: "v-b", content: "Later in the talk, citations.", source: "reader", timestamps: ["12:05"] },
      { chunk_id: "v-s", content: "Summary: the talk argues for trusted sources.", source: "notebook" },
      { chunk_id: "v-c", content: "Near the end, what to do next.", source: "reader", timestamps: ["1:02:10"] },
      { chunk_id: "v-a", content: "The opening, why it matters.", source: "reader", timestamps: ["0:30"] },
    ],
  },
  {
    id: "card-note",
    title: "Thoughts from the offsite",
    created_at: "Mar 3, 2025",
    tags: [],
    chunks: [
      { chunk_id: "n-1", content: "We should test answer engines monthly.", source: "reader" },
      { chunk_id: "n-2", content: "Ask Sam about the budget.", source: "notebook" },
    ],
  },
];

const ARTICLE_TEXT = Array.from({ length: 2600 }, (_, index) => `Paragraph ${index + 1} explains how answer engines choose which sources to cite in their replies.`).join("\n\n");

function fakeRecall(options: { tagList?: boolean; keys?: string[] } = {}) {
  const keys = new Set(options.keys ?? [OWNER_KEY, MEMBER_KEY]);
  const requests: Logged[] = [];
  const web: string[] = [];
  let limited = 0;
  let broken = 0;
  let articleMissing = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin !== "https://backend.getrecall.ai") {
      web.push(`${method} ${url.href}`);
      if (url.href === ARTICLE_URL) {
        if (articleMissing) return new Response("Gone", { status: 404 });
        const html = `<html><head><title>How answer engines pick sources</title></head><body><article>${ARTICLE_TEXT.split("\n\n").map((line) => `<p>${line}</p>`).join("")}</article></body></html>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.href.startsWith("https://www.youtube.com/youtubei/v1/player")) {
        return Response.json({
          playabilityStatus: { status: "OK" },
          videoDetails: { title: "A long talk on AI search", author: "Search Talks", shortDescription: "The whole talk." },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en", languageCode: "en" }] } },
        });
      }
      if (url.href === "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en") {
        return new Response(
          `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="30000">The opening, why it matters.</p><p t="725000">Later in the talk, citations.</p><p t="1500000">The middle part Recall left out.</p><p t="3730000">Near the end, what to do next.</p></body></timedtext>`,
          { headers: { "content-type": "text/xml" } },
        );
      }
      throw new Error(`Unexpected ${method} ${url.href}`);
    }
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ method, url, auth, body: init?.body ?? null });
    if (limited > 0) {
      limited -= 1;
      return Response.json({ detail: "Too many requests" }, { status: 429, headers: { "retry-after": "1" } });
    }
    if (broken > 0) {
      broken -= 1;
      return Response.json({ detail: { message: "Internal error" }, request_id: "req_123" }, { status: 500 });
    }
    if (!keys.has((auth ?? "").replace(/^Bearer /, ""))) return Response.json({ detail: { message: "Invalid API key" } }, { status: 401 });
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const query = url.searchParams;
    const filtered = () => {
      let list = [...CARDS];
      const tags = query.getAll("tags");
      if (tags.length) list = list.filter((card) => card.tags.some((tag) => tags.includes(tag)));
      const site = query.get("source_url_contains");
      if (site) list = list.filter((card) => card.source_url?.includes(site));
      const from = query.get("date_from");
      if (from && Date.parse(from) > Date.now() - 24 * 60 * 60 * 1000) list = [];
      return list;
    };
    const summary = (card: FakeCard) => ({ id: card.id, title: card.title, created_at: card.created_at, ...(card.source_url ? { source_url: card.source_url } : {}) });
    if (path === "/tags" && options.tagList) {
      return Response.json({
        tags: [
          { tag_id: RESEARCH, name: "Research", card_count: 1 },
          { tag_id: "8b3c4d5e-6f7a-4b2c-8d3e-4f5a6b7c8d9e", name: "Work", children: [{ tag_id: PROJECTS, name: "Projects", card_count: 1 }] },
        ],
      });
    }
    if (path === "/cards") return Response.json({ results: filtered().map(summary), total_count: filtered().length });
    if (path.startsWith("/cards/")) {
      const card = CARDS.find((item) => item.id === decodeURIComponent(path.slice("/cards/".length)));
      if (!card) return Response.json({ detail: { message: "Card not found" }, request_id: "req_404" }, { status: 404 });
      let chunks = [...card.chunks];
      if (query.get("focus_query")) chunks = chunks.reverse();
      chunks = chunks.slice(0, Number(query.get("max_chunks") ?? 20));
      return Response.json({ card_id: card.id, title: card.title, created_at: card.created_at, ...(card.source_url ? { source_url: card.source_url } : {}), chunks });
    }
    if (path === "/search") {
      const q = query.get("q") ?? "";
      if (!q) return Response.json({ detail: [{ loc: ["query", "q"], msg: "Field required", type: "missing" }] }, { status: 422 });
      if (q === "trigger 422") {
        return Response.json({ detail: [{ loc: ["query", "q"], msg: "String should have at most 1000 characters", type: "string_too_long" }] }, { status: 422 });
      }
      let list = filtered();
      if (query.get("card_id")) list = list.filter((card) => card.id === query.get("card_id"));
      const words = q.toLowerCase().split(/\s+/);
      const documents = list
        .map((card) => ({
          card_id: card.id,
          title: card.title,
          created_at: card.created_at,
          ...(card.source_url ? { source_url: card.source_url } : {}),
          chunks: card.chunks.filter((chunk) => words.some((word) => chunk.content.toLowerCase().includes(word))),
        }))
        .filter((document) => document.chunks.length > 0);
      return Response.json({ documents, total_cards: documents.length, total_chunks: documents.reduce((sum, item) => sum + item.chunks.length, 0) });
    }
    return Response.json({ detail: "Not Found" }, { status: 404 });
  };
  return {
    requests,
    web,
    fetchImpl,
    limit(count: number) {
      limited = count;
    },
    breakFor(count: number) {
      broken = count;
    },
    revoke(key: string) {
      keys.delete(key);
    },
    allow(key: string) {
      keys.add(key);
    },
    missingArticle(value: boolean) {
      articleMissing = value;
    },
  };
}

describe("recall", () => {
  let owner: UserActor;
  let member: UserActor;
  const recall = fakeRecall();
  const named = fakeRecall({ tagList: true });
  const live = (fake = recall): RecallLiveOptions => ({ fetchImpl: fake.fetchImpl, lookup, render: null, sleep: noWait, deadline: Date.now() + 60_000 });
  const logged: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };

  before(async () => {
    for (const name of ["log", "warn", "error", "info"] as const) {
      console[name] = (...args: unknown[]) => {
        logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
        originals[name](...args);
      };
    }
    await resetDatabase();
    owner = await createUser("recall-owner@orbit.test", "Mark Ridgeon");
    const created = await getAdminPool().query<{ id: string }>("select private.create_local_user($1, $2, $3) as id", [
      "recall-member@orbit.test",
      "password-123",
      "Sam Member",
    ]);
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, created.rows[0].id]);
    member = { ...owner, userId: created.rows[0].id, email: "recall-member@orbit.test", fullName: "Sam Member", role: "member", scopes: scopesForRole("member") };
  });

  after(async () => {
    Object.assign(console, originals);
    await getPool().end();
    await getAdminPool().end();
  });

  it("checks the key with a narrow read before saving it, encrypted and private to its owner", async () => {
    await assert.rejects(saveRecallKey(owner, "short", recall), /Paste the whole Recall API key/);
    await assert.rejects(saveRecallKey(owner, "pk_not_a_recall_key_123", recall), /start with sk_/);
    await assert.rejects(saveRecallKey(owner, "sk_wrong_recall_key_0000", recall), /Recall didn't accept that key/);
    const validation = recall.requests.at(-1)!;
    assert.equal(validation.url.pathname, "/api/v1/cards");
    const span = Date.parse(validation.url.searchParams.get("date_to")!) - Date.parse(validation.url.searchParams.get("date_from")!);
    assert.ok(span > 0 && span <= 5 * 60 * 1000);
    assert.equal((await recallStatus(owner)).connected, false);

    await saveRecallKey(owner, `  ${OWNER_KEY} `, recall);
    assert.equal(await recallKey(owner), OWNER_KEY);
    const raw = await getAdminPool().query<{ row: string }>("select row_to_json(k)::text as row from crm.recall_keys k");
    assert.equal(raw.rows.length, 1);
    assert.ok(!raw.rows[0].row.includes(OWNER_KEY));
    assert.ok(!raw.rows[0].row.includes("recall_key"));
    const status = await recallStatus(owner);
    assert.equal(status.connected, true);
    assert.equal(status.hint, "1234");

    assert.equal((await recallStatus(member)).connected, false);
    assert.equal(await recallKey(member), null);
    const peek = await queryAsUser<{ total: number }>(member.userId, "select count(*)::int as total from crm.recall_keys");
    assert.equal(peek[0].total, 0);
    const changed = await queryAsUser(member.userId, "update crm.recall_keys set key_hint = 'x' where user_id = $1 returning id", [owner.userId]);
    assert.equal(changed.length, 0);
    await assert.rejects(
      queryAsUser(member.userId, "insert into crm.recall_keys (workspace_id, user_id, key_cipher) values ($1, $2, 'x')", [owner.workspaceId, owner.userId]),
      /row-level security/,
    );

    await removeRecallKey(owner);
    assert.equal((await recallStatus(owner)).connected, false);
    await saveRecallKey(owner, OWNER_KEY, recall);
  });

  it("probes for a tag list on connect, and takes tag ids only when there is none", async () => {
    const probes = recall.requests.filter((request) => /\/tags\/?$/.test(request.url.pathname));
    assert.deepEqual(
      probes.slice(-3).map((request) => request.url.pathname),
      ["/api/v1/tags", "/api/v1/tags/", "/api/v1/cards/tags"],
    );
    assert.equal((await recallStatus(owner)).tags, "ids");

    const before = recall.requests.length;
    await assert.rejects(recallSearch(owner, { query: "answer engines", tags: ["Research"] }, live()), (error: Error) => error.message === TAG_IDS_ONLY);
    assert.equal(recall.requests.length, before);

    const byId = await recallSearch(owner, { query: "answer engines", tags: [RESEARCH] }, live());
    assert.deepEqual(byId.cards.map((card) => card.cardId), ["card-article"]);
    assert.deepEqual(recall.requests.at(-1)!.url.searchParams.getAll("tags"), [RESEARCH]);
    assert.equal(recall.requests.length, before + 1);

    await getAdminPool().query("update crm.recall_keys set tags_checked_at = now() - interval '2 days' where user_id = $1", [owner.userId]);
    const again = recall.requests.length;
    await recallSearch(owner, { query: "answer engines", tags: [RESEARCH] }, live());
    assert.deepEqual(
      recall.requests.slice(again).map((request) => request.url.pathname),
      ["/api/v1/tags", "/api/v1/tags/", "/api/v1/cards/tags", "/api/v1/search"],
    );
    const checked = await getAdminPool().query<{ fresh: boolean }>("select tags_checked_at > now() - interval '1 minute' as fresh from crm.recall_keys where user_id = $1", [owner.userId]);
    assert.equal(checked.rows[0].fresh, true);
  });

  it("resolves tag names to ids when Recall lists tags", async () => {
    await saveRecallKey(member, MEMBER_KEY, named);
    assert.equal((await recallStatus(member)).tags, "names");
    const result = await recallSearch(member, { query: "talk", tags: ["research", "Work/Projects"] }, live(named));
    assert.deepEqual(named.requests.at(-1)!.url.searchParams.getAll("tags").sort(), [PROJECTS, RESEARCH].sort());
    assert.deepEqual(result.cards.map((card) => card.cardId), ["card-video"]);
    const short = await recallSearch(member, { tags: ["Projects"] }, live(named));
    assert.deepEqual(short.cards.map((card) => card.cardId), ["card-video"]);
    await assert.rejects(recallSearch(member, { query: "talk", tags: ["Holidays"] }, live(named)), /Recall has no tag called Holidays\. Its tags are: Research, Work, Work\/Projects\./);
    assert.deepEqual(recallTags([{ id: "x" }]), null);
    assert.deepEqual(recallTags({ results: [] }), []);
  });

  it("searches with several phrasings and groups the passages by card, with the notebook apart", async () => {
    const result = await recallSearch(owner, { query: ["answer engines", "budget", "answer engines"], mode: "exhaustive", from: "2025-01-01", to: "2025-12-31", site: "example" }, live());
    const searches = recall.requests.filter((request) => request.url.pathname === "/api/v1/search").slice(-2);
    assert.deepEqual(searches.map((request) => request.url.searchParams.get("q")), ["answer engines", "budget"]);
    assert.equal(searches[0].url.searchParams.get("mode"), "exhaustive");
    assert.equal(searches[0].url.searchParams.get("date_from"), "2025-01-01T00:00:00Z");
    assert.equal(searches[0].url.searchParams.get("date_to"), "2025-12-31T23:59:59Z");
    assert.equal(searches[0].url.searchParams.get("source_url_contains"), "example");
    assert.match(result.note, /not whole cards/);
    assert.deepEqual(result.cards, [
      {
        cardId: "card-article",
        title: "How answer engines pick sources",
        createdAt: "Jan 15, 2025",
        sourceUrl: ARTICLE_URL,
        passages: [{ text: "First, answer engines read the page itself." }],
      },
    ]);

    const notes = await recallSearch(owner, { query: ["answer engines", "budget"] }, live());
    const note = notes.cards.find((card) => card.cardId === "card-note")!;
    assert.equal(note.sourceUrl, null);
    assert.deepEqual(note.passages, [{ text: "We should test answer engines monthly." }]);
    assert.deepEqual(note.notebook, [{ text: "Ask Sam about the budget." }]);

    const inside = await recallSearch(owner, { query: "citations", cardId: "card-video" }, live());
    assert.equal(recall.requests.at(-1)!.url.searchParams.get("card_id"), "card-video");
    assert.deepEqual(inside.cards[0].passages, [{ text: "Later in the talk, citations.", timestamps: ["12:05"] }]);

    await assert.rejects(recallSearch(owner, { query: ["a", "b", "c", "d"] }, live()), /up to 3 phrasings/);
    await assert.rejects(recallSearch(owner, { query: "x", mode: "deep" }, live()), /focused or exhaustive/);
    await assert.rejects(recallSearch(owner, { query: "x", from: "2025-05-01", to: "2025-01-01" }, live()), /from must be on or before to/);
    await assert.rejects(recallSearch(owner, { cardId: "card-video" }, live()), /use recall_read/);
  });

  it("lists cards without a query, with the same filters", async () => {
    const all = await recallSearch(owner, {}, live());
    assert.equal(all.total, 3);
    assert.deepEqual(all.cards[0], { cardId: "card-article", title: "How answer engines pick sources", createdAt: "Jan 15, 2025", sourceUrl: ARTICLE_URL });
    assert.equal(all.cards[2].sourceUrl, null);
    assert.equal(recall.requests.at(-1)!.url.pathname, "/api/v1/cards");
    const videos = await recallSearch(owner, { site: "youtube.com" }, live());
    assert.equal(recall.requests.at(-1)!.url.searchParams.get("source_url_contains"), "youtube.com");
    assert.deepEqual(videos.cards.map((card) => card.cardId), ["card-video"]);
    const capped = await recallSearch(owner, { limit: 2 }, live());
    assert.equal(capped.shown, 2);
    assert.equal(capped.truncated, true);
  });

  it("reads a card's excerpts in order, with the notebook apart and the source link", async () => {
    const video = await recallRead(owner, { cardId: "card-video" }, live());
    assert.equal(recall.requests.at(-1)!.url.searchParams.get("max_chunks"), "50");
    assert.equal(video.excerpts, true);
    assert.match(video.note, /not the full text/);
    assert.ok(video.note.includes(VIDEO_URL));
    assert.equal(video.order, "time");
    assert.deepEqual(video.content!.map((item) => item.timestamps?.[0]), ["0:30", "12:05", "1:02:10"]);
    assert.deepEqual(video.notebook, [{ text: "Summary: the talk argues for trusted sources." }]);
    assert.equal(video.card.sourceUrl, VIDEO_URL);

    const focused = await recallRead(owner, { cardId: "card-video", focusQuery: "citations", maxChunks: 3 }, live());
    assert.equal(recall.requests.at(-1)!.url.searchParams.get("focus_query"), "citations");
    assert.equal(recall.requests.at(-1)!.url.searchParams.get("max_chunks"), "3");
    assert.equal(focused.order, "relevance");

    const article = await recallRead(owner, { cardId: "card-article" }, live());
    assert.equal(article.order, "relevance");
    assert.equal(article.content!.length, 3);
    assert.deepEqual(article.notebook, [{ text: "My note: send this to Acme." }]);

    const pages = orderChunks([
      { content: "b", source: "page 7" },
      { content: "a", source: "page 2" },
    ]);
    assert.equal(pages.order, "page");
    assert.deepEqual(pages.chunks.map((chunk) => chunk.content), ["a", "b"]);

    await assert.rejects(recallRead(owner, { cardId: "card-missing" }, live()), /Recall has no card with that id/);
  });

  it("reads an article's original live in 100,000 character windows, without storing it", async () => {
    const pagesBefore = recall.web.filter((entry) => entry === `GET ${ARTICLE_URL}`).length;
    const first = await recallRead(owner, { cardId: "card-article", full: true }, live());
    assert.equal(first.full, true);
    assert.ok("original" in first);
    assert.deepEqual(first.original, { url: ARTICLE_URL, kind: "article", title: "How answer engines pick sources" });
    assert.equal(first.offset, 0);
    assert.equal(first.text!.length, 100_000);
    assert.equal(first.nextOffset, 100_000);
    assert.ok(first.characters! > 200_000);
    assert.deepEqual(first.notebook, [{ text: "My note: send this to Acme." }]);
    assert.match(first.note, /not stored/);
    let text = first.text!;
    let next: number | null = first.nextOffset ?? null;
    while (next !== null) {
      const part = await recallRead(owner, { cardId: "card-article", full: true, offset: next }, live());
      assert.ok("original" in part);
      assert.equal(recall.requests.at(-1)!.url.searchParams.get("max_chunks"), "1");
      assert.equal(part.notebook, undefined);
      text += part.text!;
      next = part.nextOffset ?? null;
    }
    assert.equal(text.length, first.characters);
    assert.ok(text.startsWith("Paragraph 1 explains"));
    assert.ok(text.includes("Paragraph 2600 explains"));
    assert.equal(recall.web.filter((entry) => entry === `GET ${ARTICLE_URL}`).length - pagesBefore, 3);
    await assert.rejects(recallRead(owner, { cardId: "card-article", full: true, offset: 5_000_000 }, live()), /Give an offset below/);

    const stored = await getAdminPool().query<{ total: number }>(
      "select (select count(*)::int from crm.knowledge_items where workspace_id = $1) + (select count(*)::int from crm.activities where workspace_id = $1) as total",
      [owner.workspaceId],
    );
    assert.equal(stored.rows[0].total, 0);

    recall.missingArticle(true);
    const failed = await recallRead(owner, { cardId: "card-article", full: true }, live());
    recall.missingArticle(false);
    assert.equal(failed.full, false);
    assert.ok("originalError" in failed);
    assert.match(failed.originalError as string, /Couldn't open the original.*Only Recall's excerpts/);
    assert.equal(failed.content!.length, 3);
  });

  it("reads a YouTube card's whole transcript, and says when a card has only excerpts", async () => {
    const video = await recallRead(owner, { cardId: "card-video", full: true }, live());
    assert.ok("original" in video);
    assert.equal(video.original!.kind, "youtube");
    assert.match(video.text!, /Transcript:/);
    assert.match(video.text!, /The middle part Recall left out\./);
    assert.match(video.text!, /\[1:02:10\] Near the end/);
    assert.equal(video.nextOffset, null);
    assert.ok(recall.web.some((entry) => entry.startsWith("POST https://www.youtube.com/youtubei/v1/player")));

    const note = await recallRead(owner, { cardId: "card-note", full: true }, live());
    assert.equal(note.full, false);
    assert.ok("content" in note);
    assert.match(note.note, /no source link/);
    assert.match(note.note, /only excerpts are available/);
  });

  it("explains rejected keys, bad requests and rate limits, retrying once", async () => {
    await assert.rejects(recallSearch(owner, { query: "trigger 422" }, live()), (error: Error) => {
      assert.equal(error.message, "Recall couldn't use that request: q: String should have at most 1000 characters.");
      return true;
    });
    assert.equal(recallDetail({ detail: { message: "date_from must be before or equal to date_to" } }), "date_from must be before or equal to date_to");

    let count = recall.requests.length;
    recall.limit(1);
    const retried = await recallSearch(owner, { query: "answer engines" }, live());
    assert.ok(retried.cards.length > 0);
    assert.equal(recall.requests.length - count, 2);

    count = recall.requests.length;
    recall.limit(2);
    await assert.rejects(recallSearch(owner, { query: "answer engines" }, live()), /Recall is limiting requests right now\. Try again in a minute\./);
    assert.equal(recall.requests.length - count, 2);

    recall.breakFor(1);
    assert.ok((await recallSearch(owner, {}, live())).cards.length > 0);
    recall.breakFor(2);
    await assert.rejects(recallSearch(owner, {}, live()), /Recall had a problem on its side \(500\).*req_123/);

    recall.revoke(OWNER_KEY);
    await assert.rejects(recallSearch(owner, { query: "x" }, live()), (error: Error) => error.message === RECALL_REJECTED);
    recall.allow(OWNER_KEY);
  });

  it("runs as two read-only assistant tools, marked as outside text, refused without a key before any request", async () => {
    for (const name of ["recall_search", "recall_read"]) {
      const tool = TOOL_BY_NAME.get(name);
      assert.ok(tool, name);
      assert.notEqual(tool.write, true);
      assert.match(tool.description, /Only when the user asks/);
    }
    const original = globalThis.fetch;
    globalThis.fetch = recall.fetchImpl;
    try {
      const found = (await runTool(owner, "recall_search", { query: ["answer engines"] })) as { notice: string; cards: { cardId: string }[] };
      assert.equal(found.notice, EXTERNAL_NOTICE);
      assert.ok(found.cards.some((card) => card.cardId === "card-article"));
      const read = (await runTool(owner, "recall_read", { cardId: "card-video" })) as { notice: string; order: string };
      assert.equal(read.notice, EXTERNAL_NOTICE);
      assert.equal(read.order, "time");

      const outsider = await createUser("recall-outsider@orbit.test", "No Key");
      const before = recall.requests.length;
      for (const name of ["recall_search", "recall_read"]) {
        const refused = (await runTool(outsider, name, { query: ["x"], cardId: "card-video" })) as { error?: string };
        assert.equal(refused.error, "Recall isn't connected. Add your Recall API key in Settings, Integrations.");
      }
      assert.equal(recall.requests.length, before);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the folded Reader highlights tool working under its old name", () => {
    assert.equal(TOOL_BY_NAME.has("reader_highlights"), false);
    assert.equal(findTool("reader_highlights")?.name, "reader_list");
  });

  it("deletes a member's Recall key when they are removed", async () => {
    assert.equal((await recallStatus(member)).connected, true);
    await removeMember(owner, member.userId);
    const keys = await getAdminPool().query<{ total: number }>("select count(*)::int as total from crm.recall_keys where user_id = $1", [member.userId]);
    assert.equal(keys.rows[0].total, 0);
    assert.equal((await recallStatus(owner)).connected, true);
  });

  it("only ever sends GET requests to Recall, and never logs a key", () => {
    for (const fake of [recall, named]) {
      assert.ok(fake.requests.length > 5);
      for (const request of fake.requests) {
        assert.equal(request.method, "GET", `${request.method} ${request.url}`);
        assert.equal(request.body, null);
        assert.equal(request.url.origin, "https://backend.getrecall.ai");
        assert.match(request.auth ?? "", /^Bearer sk_/);
      }
    }
    for (const line of logged) {
      assert.ok(!line.includes(OWNER_KEY) && !line.includes(MEMBER_KEY), line);
    }
  });
});
