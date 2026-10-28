import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { EXTERNAL_NOTICE, runTool } from "@/lib/assistant/tools";
import { createPersonalToken } from "@/lib/auth/personal";
import { createCompany } from "@/lib/crm/companies";
import { DEFAULT_STEPS, syncTargets } from "@/lib/crm/scheduler";
import { scopesForRole } from "@/lib/crm/scopes";
import { removeMember } from "@/lib/crm/team";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { indexKnowledgeItem } from "@/lib/knowledge/indexing";
import { listReaderDocuments, listReaderTags, readerText, validateReadwiseToken, type ReaderDocument } from "@/lib/readwise";
import { READER_PART_CHARS, readerParts } from "@/lib/readwise/reader";
import { readwiseStatus, readwiseToken, removeReadwiseToken, saveReadwiseToken } from "@/lib/readwise/keys";
import { matchCompany, syncReaderToKnowledge } from "@/lib/readwise/sync";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const GOOD = "rw_owner_token_abcdef123456";
const MEMBER_TOKEN = "rw_member_token_zyxwvu654321";
const HOUR = 60 * 60 * 1000;

type FakeDocument = Partial<ReaderDocument> & { id: string; updated_at: string };
type Request = { method: string; url: URL; auth: string | null; body: unknown };

function ago(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function tags(...keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, { name: key, type: "manual", created: 1 }]));
}

function fakeReader(tokens: string[] = [GOOD, MEMBER_TOKEN]) {
  const documents = new Map<string, FakeDocument>();
  const requests: Request[] = [];
  let limited = 0;
  let limitedHighlights = 0;
  let malformed = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ method, url, auth, body: init?.body ?? null });
    if (limited > 0) {
      limited -= 1;
      return new Response(null, { status: 429, headers: { "retry-after": "2" } });
    }
    if (limitedHighlights > 0 && url.searchParams.get("category") === "highlight") {
      limitedHighlights -= 1;
      return new Response(null, { status: 429, headers: { "retry-after": "2" } });
    }
    if (!tokens.some((token) => auth === `Token ${token}`)) return Response.json({ detail: "Invalid token." }, { status: 401 });
    if (url.pathname === "/api/v2/auth/") return new Response(null, { status: 204 });
    if (url.pathname === "/api/v3/tags/") {
      const keys = new Set<string>();
      for (const document of documents.values()) for (const key of Object.keys((document.tags as object) ?? {})) keys.add(key);
      return Response.json({ count: keys.size, nextPageCursor: null, results: [...keys].map((key) => ({ key, name: key })) });
    }
    if (url.pathname !== "/api/v3/list/") return Response.json({ detail: "Not found." }, { status: 404 });
    if (malformed > 0) {
      malformed -= 1;
      return Response.json({ count: 0, nextPageCursor: null, results: null });
    }
    const query = url.searchParams;
    let list = [...documents.values()];
    if (query.get("id")) list = list.filter((item) => item.id === query.get("id"));
    const updatedAfter = query.get("updatedAfter");
    if (updatedAfter) list = list.filter((item) => Date.parse(item.updated_at) > Date.parse(updatedAfter));
    if (query.get("category")) list = list.filter((item) => item.category === query.get("category"));
    if (query.get("location")) list = list.filter((item) => item.location === query.get("location"));
    for (const tag of query.getAll("tag")) list = list.filter((item) => Object.keys((item.tags as object) ?? {}).includes(tag));
    const limit = Number(query.get("limit") ?? 100);
    const offset = Number(query.get("pageCursor") ?? 0);
    const page = list.slice(offset, offset + limit).map((item) => {
      const copy = { ...item };
      if (query.get("withHtmlContent") !== "true") delete copy.html_content;
      return copy;
    });
    return Response.json({ count: list.length, nextPageCursor: offset + limit < list.length ? String(offset + limit) : null, results: page });
  };
  return {
    documents,
    requests,
    fetchImpl,
    limit(count: number) {
      limited = count;
    },
    limitHighlights(count: number) {
      limitedHighlights = count;
    },
    malform(count: number) {
      malformed = count;
    },
    put(document: Partial<ReaderDocument> & { id: string }, updatedAt = new Date().toISOString()) {
      documents.set(document.id, {
        url: `https://read.readwise.io/read/${document.id}`,
        source_url: null,
        title: null,
        author: null,
        category: "article",
        location: "later",
        tags: {},
        parent_id: null,
        notes: "",
        saved_at: ago(30 * 24 * HOUR),
        created_at: ago(30 * 24 * HOUR),
        ...documents.get(document.id),
        ...document,
        updated_at: updatedAt,
      });
    },
  };
}

async function items(workspaceId: string) {
  const result = await getAdminPool().query<{
    id: string;
    source_ref: string;
    scope: string;
    company_id: string | null;
    title: string;
    content: string | null;
    kind: string;
    status: string;
    archived_at: Date | null;
  }>("select id, source_ref, scope, company_id, title, content, kind, status, archived_at from crm.knowledge_items where workspace_id = $1 and source_ref like 'reader:%' order by created_at", [workspaceId]);
  return result.rows;
}

describe("readwise reader", () => {
  let owner: UserActor;
  let member: UserActor;
  let acme: string;
  const reader = fakeReader();
  const indexed: string[][] = [];
  const index = (_actor: UserActor, ids: string[]) => {
    indexed.push(ids);
  };

  before(async () => {
    await resetDatabase();
    owner = await createUser("reader-owner@orbit.test", "Mark Ridgeon");
    const created = await getAdminPool().query<{ id: string }>("select private.create_local_user($1, $2, $3) as id", [
      "reader-member@orbit.test",
      "password-123",
      "Sam Member",
    ]);
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [
      owner.workspaceId,
      created.rows[0].id,
    ]);
    member = { ...owner, userId: created.rows[0].id, email: "reader-member@orbit.test", fullName: "Sam Member", role: "member", scopes: scopesForRole("member") };
    acme = (await createCompany(owner, { name: "Acme Reader", domain: "acme-reader.test" })).body.company.id;

    reader.put(
      {
        id: "doc-acme",
        title: "How Acme plans its rollout",
        author: "Jane Writer",
        source_url: "https://blog.example.test/acme-rollout",
        tags: tags("orbit", "acme-reader"),
        html_content: "<h1>Rollout</h1><p>Acme will roll out to 40 sites in spring.</p><p>Budget &amp; timing are set.</p>",
        summary: "Acme's rollout plan.",
      },
      ago(2 * HOUR),
    );
    reader.put(
      {
        id: "doc-eclipse",
        title: "Notes on AI visibility",
        author: "Sam Analyst",
        source_url: "https://essays.example.test/ai-visibility",
        tags: tags("orbit", "research"),
        html_content: "<p>Answer engines cite sources they trust.</p>",
      },
      ago(2 * HOUR),
    );
    reader.put(
      { id: "doc-private", title: "My private reading", tags: tags("personal"), html_content: "<p>Something only for me about holidays.</p>" },
      ago(2 * HOUR),
    );
    reader.put({ id: "hl-1", category: "highlight", parent_id: "doc-acme", content: "40 sites in spring", highlight_offset: 20 }, ago(2 * HOUR));
    reader.put(
      { id: "hl-2", category: "highlight", parent_id: "doc-acme", content: "Budget and timing are set", notes: "Ask about the budget owner", highlight_offset: 50 },
      ago(2 * HOUR),
    );
    reader.put({ id: "hl-3", category: "highlight", parent_id: "doc-private", content: "only for me about holidays", notes: "secret note" }, ago(2 * HOUR));
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("checks a token with Readwise", async () => {
    assert.equal(await validateReadwiseToken(GOOD, reader.fetchImpl), true);
    assert.equal(await validateReadwiseToken("rw_wrong_token_000000", reader.fetchImpl), false);
    const tagList = await listReaderTags(GOOD, reader.fetchImpl);
    assert.ok(tagList.some((tag) => tag.key === "orbit"));
    const page = await listReaderDocuments(GOOD, { category: "highlight", limit: 2, pages: 5 }, reader.fetchImpl);
    assert.equal(page.results.length, 3);
    assert.equal(page.nextPageCursor, null);
  });

  it("saves the token encrypted and private to its owner", async () => {
    await assert.rejects(saveReadwiseToken(owner, "rw_wrong_token_000000", reader), /Readwise didn't accept that token/);
    await assert.rejects(saveReadwiseToken(owner, "short", reader), /Paste the whole Readwise access token/);
    await saveReadwiseToken(owner, `  ${GOOD} `, reader);
    assert.equal(await readwiseToken(owner), GOOD);
    const raw = await getAdminPool().query<{ row: string }>("select row_to_json(k)::text as row from crm.readwise_keys k");
    assert.equal(raw.rows.length, 1);
    assert.ok(!raw.rows[0].row.includes(GOOD));
    const status = await readwiseStatus(owner);
    assert.equal(status.connected, true);
    assert.equal(status.hint, "3456");
    assert.equal((await readwiseStatus(member)).connected, false);
    assert.equal(await readwiseToken(member), null);
    const peek = await queryAsUser<{ total: number }>(member.userId, "select count(*)::int as total from crm.readwise_keys");
    assert.equal(peek[0].total, 0);
    await assert.rejects(
      queryAsUser(member.userId, "update crm.readwise_keys set token_hint = 'x' where user_id = $1 returning id", [owner.userId]).then((rows) => {
        if (rows.length === 0) throw new Error("no rows");
      }),
    );
    await removeReadwiseToken(owner);
    assert.equal((await readwiseStatus(owner)).connected, false);
    await saveReadwiseToken(owner, GOOD, reader);
    const { targets } = await syncTargets();
    assert.equal(targets.find((target) => target.actor.userId === owner.userId)?.readwise, true);
    assert.ok(!targets.find((target) => target.actor.userId === member.userId)?.readwise);
    assert.ok(DEFAULT_STEPS.some((step) => step.name === "readwise"));
  });

  it("matches a tag to a company by name or domain, ignoring case", () => {
    const list = [
      { id: "a", name: "Acme Reader", domain: "acme-reader.test" },
      { id: "b", name: "Globex", domain: "globex.test" },
    ];
    assert.equal(matchCompany([{ key: "orbit", name: "orbit" }, { key: "acme-reader", name: "acme-reader" }], list), "a");
    assert.equal(matchCompany([{ key: "globex.test", name: "GLOBEX.TEST" }], list), "b");
    assert.equal(matchCompany([{ key: "acme reader", name: "Acme Reader" }], list), "a");
    assert.equal(matchCompany([{ key: "orbit", name: "orbit" }, { key: "research", name: "research" }], list), null);
  });

  it("adds documents tagged orbit to Knowledge with their highlights and nothing else", async () => {
    const result = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(result.error, undefined);
    assert.equal(result.added, 2);
    assert.equal(result.complete, true);
    const stored = await items(owner.workspaceId);
    assert.equal(stored.length, 2);
    const acmeItem = stored.find((item) => item.source_ref === "reader:doc-acme")!;
    assert.equal(acmeItem.kind, "reader");
    assert.equal(acmeItem.scope, "company");
    assert.equal(acmeItem.company_id, acme);
    assert.equal(acmeItem.title, "How Acme plans its rollout");
    assert.equal(acmeItem.status, "pending");
    for (const part of ["By Jane Writer", "Source: https://blog.example.test/acme-rollout", "Acme will roll out to 40 sites in spring.", "Budget & timing are set.", "- 40 sites in spring", "Note: Ask about the budget owner"]) {
      assert.ok(acmeItem.content!.includes(part), part);
    }
    assert.ok(acmeItem.content!.indexOf("40 sites in spring\n") < acmeItem.content!.indexOf("Budget and timing"));
    const eclipseItem = stored.find((item) => item.source_ref === "reader:doc-eclipse")!;
    assert.equal(eclipseItem.scope, "eclipse");
    assert.equal(eclipseItem.company_id, null);
    assert.ok(eclipseItem.content!.includes("Answer engines cite sources they trust."));
    const everything = await getAdminPool().query<{ text: string }>(
      `select coalesce(string_agg(row_to_json(i)::text, ' '), '') || ' ' || coalesce((select string_agg(row_to_json(d)::text, ' ') from crm.readwise_documents d), '') as text
       from crm.knowledge_items i`,
    );
    for (const secret of ["My private reading", "holidays", "secret note", "doc-private"]) assert.ok(!everything.rows[0].text.includes(secret), secret);
    assert.deepEqual(indexed.at(-1)?.sort(), [acmeItem.id, eclipseItem.id].sort());
    const audit = await getAdminPool().query<{ source: string; operation: string }>(
      "select source, operation from crm.audit_events where entity_type = 'knowledge' and entity_id = $1",
      [acmeItem.id],
    );
    assert.deepEqual(audit.rows, [{ source: "readwise", operation: "sync_readwise" }]);
    const status = await readwiseStatus(owner);
    assert.equal(status.documents, 2);
    assert.ok(status.lastSyncedAt);
    const key = await getAdminPool().query<{ updated_after: Date | null; full_sync_at: Date | null }>("select updated_after, full_sync_at from crm.readwise_keys where user_id = $1", [owner.userId]);
    assert.ok(key.rows[0].updated_after);
    assert.ok(key.rows[0].full_sync_at);
  });

  it("indexes Reader items from their stored text, including a forced re-index", async () => {
    const llm = "https://llm.test/v1";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_API_BASE_URL = llm;
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === `${llm}/embeddings`) {
        const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
        return Response.json({ data: texts.map((_text, position) => ({ index: position, embedding: new Array(1536).fill(0.01) })) });
      }
      if (url === `${llm}/chat/completions`) {
        return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ summary: "An essay on AI visibility." }) }, finish_reason: "stop" }] });
      }
      throw new Error(`Unexpected ${url}`);
    };
    try {
      const item = (await items(owner.workspaceId)).find((row) => row.source_ref === "reader:doc-eclipse")!;
      assert.equal((await indexKnowledgeItem(owner, item.id, { fetchImpl }))?.status, "ready");
      assert.equal((await indexKnowledgeItem(owner, item.id, { fetchImpl, force: true }))?.status, "ready");
      assert.ok(calls.every((url) => url.startsWith(llm)));
      const indexedRow = (await items(owner.workspaceId)).find((row) => row.id === item.id)!;
      assert.ok(indexedRow.content!.includes("Answer engines cite sources they trust."));
    } finally {
      delete process.env.LLM_API_KEY;
      delete process.env.LLM_API_BASE_URL;
    }
  });

  it("updates the same item on a re-sync when highlights change, and moves the cursor on", async () => {
    const before = await getAdminPool().query<{ updated_after: Date }>("select updated_after from crm.readwise_keys where user_id = $1", [owner.userId]);
    const ids = (await items(owner.workspaceId)).map((item) => item.id);
    reader.put({ id: "hl-4", category: "highlight", parent_id: "doc-eclipse", content: "cite sources they trust", notes: "Use in the pitch" });
    const seen = reader.requests.length;
    const result = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(result.error, undefined);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 1);
    const stored = await items(owner.workspaceId);
    assert.deepEqual(stored.map((item) => item.id), ids);
    const eclipseItem = stored.find((item) => item.source_ref === "reader:doc-eclipse")!;
    assert.ok(eclipseItem.content!.includes("- cite sources they trust\n  Note: Use in the pitch"));
    assert.equal(eclipseItem.status, "pending");
    assert.deepEqual(indexed.at(-1), [eclipseItem.id]);
    const listed = reader.requests.slice(seen).filter((request) => request.url.pathname === "/api/v3/list/");
    assert.ok(listed.every((request) => request.url.searchParams.get("updatedAfter") || request.url.searchParams.get("id")));
    assert.ok(listed.some((request) => request.url.searchParams.get("id") === "doc-eclipse"));
    const afterSync = await getAdminPool().query<{ updated_after: Date }>("select updated_after from crm.readwise_keys where user_id = $1", [owner.userId]);
    assert.ok(afterSync.rows[0].updated_after.getTime() > before.rows[0].updated_after.getTime());

    const quiet = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(quiet.updated + quiet.added, 0);
    assert.deepEqual(indexed.at(-1), []);
  });

  it("picks up older highlights when a document is tagged later", async () => {
    reader.put({ id: "hl-5", category: "highlight", parent_id: "doc-private", content: "an older highlight" }, ago(10 * 24 * HOUR));
    reader.put({ id: "doc-private", title: "Tagged at last", tags: tags("orbit"), html_content: "<p>Now shared.</p>" });
    const result = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(result.added, 1);
    const item = (await items(owner.workspaceId)).find((row) => row.source_ref === "reader:doc-private")!;
    assert.ok(item.content!.includes("- an older highlight"));
    assert.ok(item.content!.includes("- only for me about holidays\n  Note: secret note"));
  });

  it("removes items from Knowledge when the orbit tag goes or the document is deleted", async () => {
    reader.put({ id: "doc-acme", tags: tags("acme-reader") });
    reader.documents.delete("doc-private");
    const result = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined, full: true });
    assert.equal(result.error, undefined);
    assert.equal(result.archived, 2);
    const stored = await items(owner.workspaceId);
    assert.ok(stored.find((item) => item.source_ref === "reader:doc-acme")!.archived_at);
    assert.ok(stored.find((item) => item.source_ref === "reader:doc-private")!.archived_at);
    assert.equal(stored.find((item) => item.source_ref === "reader:doc-acme")!.content, null);
    assert.equal(stored.find((item) => item.source_ref === "reader:doc-eclipse")!.archived_at, null);
    const rows = await getAdminPool().query<{ document_id: string }>("select document_id from crm.readwise_documents order by document_id");
    assert.deepEqual(rows.rows.map((row) => row.document_id), ["doc-eclipse"]);
    assert.equal((await readwiseStatus(owner)).documents, 1);

    reader.put({ id: "doc-acme", tags: tags("orbit", "acme-reader") });
    const again = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(again.added, 1);
    const live = (await items(owner.workspaceId)).filter((item) => item.source_ref === "reader:doc-acme" && !item.archived_at);
    assert.equal(live.length, 1);
  });

  it("waits once when Readwise rate limits, then stops with a clear error", async () => {
    const waits: number[] = [];
    reader.limit(1);
    const once = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async (ms) => void waits.push(ms) });
    assert.equal(once.error, undefined);
    assert.deepEqual(waits, [2000]);
    reader.limit(2);
    const twice = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async (ms) => void waits.push(ms) });
    assert.match(twice.error ?? "", /Readwise is limiting requests \(20 a minute\)\. Try again in 2 seconds\./);
    const status = await readwiseStatus(owner);
    assert.match(status.lastError ?? "", /limiting requests/);
    assert.ok(status.lastErrorAt);
    const recovered = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(recovered.error, undefined);
    assert.equal((await readwiseStatus(owner)).lastError, null);

    reader.limitHighlights(2);
    const midScan = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.match(midScan.error ?? "", /limiting requests/);
    const paused = await getAdminPool().query<{ scan_started_at: Date | null }>("select scan_started_at from crm.readwise_keys where user_id = $1", [owner.userId]);
    assert.ok(paused.rows[0].scan_started_at);
    const resumed = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.complete, true);
    const cleared = await getAdminPool().query<{ scan_started_at: Date | null }>("select scan_started_at from crm.readwise_keys where user_id = $1", [owner.userId]);
    assert.equal(cleared.rows[0].scan_started_at, null);
  });

  it("carries on a long highlight scan in the next sync when it runs out of requests", async () => {
    for (let index = 0; index < 150; index += 1) {
      reader.put({ id: `hl-bulk-${index}`, category: "highlight", parent_id: "doc-eclipse", content: `Bulk point ${index}`, highlight_offset: 1000 + index });
    }
    const cursorBefore = await getAdminPool().query<{ updated_after: Date }>("select updated_after from crm.readwise_keys where user_id = $1", [owner.userId]);
    const partial = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined, maxRequests: 2 });
    assert.equal(partial.error, undefined);
    assert.equal(partial.complete, false);
    const state = await getAdminPool().query<{ scan_cursor: string | null; updated_after: Date }>("select scan_cursor, updated_after from crm.readwise_keys where user_id = $1", [owner.userId]);
    assert.equal(state.rows[0].scan_cursor, "100");
    assert.equal(state.rows[0].updated_after.getTime(), cursorBefore.rows[0].updated_after.getTime());
    const seen = reader.requests.length;
    const rest = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(rest.error, undefined);
    assert.equal(rest.complete, true);
    assert.ok(reader.requests.slice(seen).some((request) => request.url.searchParams.get("pageCursor") === "100"));
    const item = (await items(owner.workspaceId)).find((row) => row.source_ref === "reader:doc-eclipse")!;
    assert.ok(item.content!.includes("- Bulk point 0\n") && item.content!.includes("- Bulk point 149"));
    const done = await getAdminPool().query<{ scan_cursor: string | null }>("select scan_cursor from crm.readwise_keys where user_id = $1", [owner.userId]);
    assert.equal(done.rows[0].scan_cursor, null);
  });

  it("carries a long document list on over several syncs and removes untagged items only once the whole list is read", async () => {
    reader.put({ id: "doc-stale", title: "Old news", tags: tags("orbit"), html_content: "<p>Out of date.</p>" });
    assert.equal((await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined })).added, 1);
    reader.put({ id: "doc-stale", tags: tags("archive-me") });
    for (let index = 0; index < 320; index += 1) {
      reader.put({ id: `doc-many-${index}`, title: `Market note ${index}`, tags: tags("orbit", "bulk"), html_content: `<p>Note number ${index}.</p>` });
    }
    const key = async () =>
      (
        await getAdminPool().query<{ list_cursor: string | null; list_done: boolean; list_full: boolean; scan_started_at: Date | null; updated_after: Date }>(
          "select list_cursor, list_done, list_full, scan_started_at, updated_after from crm.readwise_keys where user_id = $1",
          [owner.userId],
        )
      ).rows[0];
    const before = await key();
    const first = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined, full: true, maxRequests: 2 });
    assert.equal(first.error, undefined);
    assert.equal(first.complete, false);
    assert.equal(first.archived, 0);
    const cut = await key();
    assert.equal(cut.list_cursor, "200");
    assert.equal(cut.list_done, false);
    assert.equal(cut.list_full, true);
    assert.equal(cut.updated_after.getTime(), before.updated_after.getTime());
    const stale = () => items(owner.workspaceId).then((rows) => rows.find((row) => row.source_ref === "reader:doc-stale")!);
    assert.equal((await stale()).archived_at, null);

    const seen = reader.requests.length;
    let archived = 0;
    let runs = 1;
    let last = first;
    while (!last.complete && runs < 10) {
      last = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined, maxRequests: 2 });
      assert.equal(last.error, undefined);
      archived += last.archived;
      runs += 1;
    }
    assert.equal(last.complete, true);
    assert.equal(archived, 1);
    assert.ok((await stale()).archived_at);
    assert.ok(reader.requests.slice(seen).some((request) => request.url.searchParams.get("pageCursor") === "200" && request.url.searchParams.get("tag") === "orbit"));
    const live = (await items(owner.workspaceId)).filter((row) => row.source_ref.startsWith("reader:doc-many-") && !row.archived_at);
    assert.equal(live.length, 320);
    const done = await key();
    assert.equal(done.list_cursor, null);
    assert.equal(done.scan_started_at, null);
    assert.ok(done.updated_after.getTime() > before.updated_after.getTime());

    const original = globalThis.fetch;
    globalThis.fetch = reader.fetchImpl;
    try {
      const tagged = (await runTool(owner, "reader_highlights", { tag: "bulk" })) as { complete: boolean; documentsTruncated: boolean };
      assert.equal(tagged.documentsTruncated, true);
      assert.equal(tagged.complete, false);
      const research = (await runTool(owner, "reader_highlights", { tag: "research", limit: 200 })) as { complete: boolean; documentsTruncated: boolean };
      assert.equal(research.documentsTruncated, false);
    } finally {
      globalThis.fetch = original;
    }

    for (let index = 0; index < 320; index += 1) reader.documents.delete(`doc-many-${index}`);
    reader.documents.delete("doc-stale");
    const cleared = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined, full: true });
    assert.equal(cleared.error, undefined);
    assert.equal(cleared.archived, 320);
  });

  it("never removes anything when Readwise sends a list it can't read", async () => {
    const liveBefore = (await items(owner.workspaceId)).filter((row) => !row.archived_at).length;
    assert.ok(liveBefore > 0);
    reader.malform(1);
    const broken = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined, full: true });
    assert.match(broken.error ?? "", /Readwise sent a reply Orbit couldn't read/);
    assert.equal(broken.archived, 0);
    assert.equal((await items(owner.workspaceId)).filter((row) => !row.archived_at).length, liveBefore);
    const rows = await getAdminPool().query<{ total: number }>("select count(*)::int as total from crm.readwise_documents where user_id = $1", [owner.userId]);
    assert.ok(rows.rows[0].total >= liveBefore);
    const recovered = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.complete, true);
    assert.equal(recovered.archived, 0);
    assert.equal((await items(owner.workspaceId)).filter((row) => !row.archived_at).length, liveBefore);
  });

  it("keeps an item archived in Knowledge out until the document is tagged orbit again", async () => {
    reader.put({ id: "doc-return", title: "Come back later", tags: tags("orbit"), html_content: "<p>Worth another look.</p>" });
    assert.equal((await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined })).added, 1);
    const first = (await items(owner.workspaceId)).find((row) => row.source_ref === "reader:doc-return" && !row.archived_at)!;
    await getAdminPool().query("update crm.knowledge_items set archived_at = now() where id = $1", [first.id]);
    reader.put({ id: "doc-return", location: "archive" });
    const removed = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(removed.added + removed.updated, 0);
    const link = async () =>
      (await getAdminPool().query<{ knowledge_item_id: string | null }>("select knowledge_item_id from crm.readwise_documents where document_id = 'doc-return'")).rows[0];
    assert.equal((await link()).knowledge_item_id, null);
    const again = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined, full: true });
    assert.equal(again.added + again.updated, 0);
    const live = () => items(owner.workspaceId).then((rows) => rows.filter((row) => row.source_ref === "reader:doc-return" && !row.archived_at));
    assert.equal((await live()).length, 0);

    reader.put({ id: "doc-return", tags: { orbit: { name: "orbit", type: "manual", created: 2 } } });
    const retagged = await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined });
    assert.equal(retagged.added, 1);
    const back = await live();
    assert.equal(back.length, 1);
    assert.notEqual(back[0].id, first.id);
    assert.equal((await link()).knowledge_item_id, back[0].id);
    reader.documents.delete("doc-return");
    await syncReaderToKnowledge(owner, { fetchImpl: reader.fetchImpl, index, sleep: async () => undefined, full: true });
  });

  it("reads a long document in parts that together give the whole text, and checks highlights only on part 1", async () => {
    const paragraphs: string[] = [];
    for (let index = 0; paragraphs.join("").length < 750_000; index += 1) {
      const sentences = Array.from({ length: 3 + (index % 9) }, (_, sentence) => `Chapter ${Math.floor(index / 40) + 1} paragraph ${index} line ${sentence} says something “worth” keeping.`);
      paragraphs.push(`<p>${sentences.join(" ")}</p>`);
    }
    reader.put({ id: "doc-book", title: "A long book", category: "epub", tags: tags("books"), notes: "Read for the board meeting", html_content: paragraphs.join("") });
    reader.put({ id: "hl-book-1", category: "highlight", parent_id: "doc-book", content: "worth keeping", notes: "Quote this" });
    const book = reader.documents.get("doc-book")!;
    const full = readerText({ content: book.content ?? null, html_content: book.html_content ?? null });
    assert.ok(full.length > 700_000);
    const original = globalThis.fetch;
    globalThis.fetch = reader.fetchImpl;
    try {
      const texts: string[] = [];
      let part: number | null = 1;
      let parts = 0;
      while (part !== null) {
        const seen = reader.requests.length;
        const read = (await runTool(owner, "reader_read", { id: "doc-book", part })) as {
          part: number;
          parts: number;
          characters: number;
          nextPart: number | null;
          text: string;
          notes?: string | null;
          highlights?: { text: string; note: string | null }[];
        };
        const sent = reader.requests.slice(seen);
        assert.equal(read.part, part);
        assert.equal(read.characters, full.length);
        assert.ok(read.text.length <= READER_PART_CHARS);
        if (part === 1) {
          parts = read.parts;
          assert.equal(read.notes, "Read for the board meeting");
          assert.deepEqual(read.highlights!.map((item) => [item.text, item.note]), [["worth keeping", "Quote this"]]);
          assert.ok(sent.some((request) => request.url.searchParams.get("category") === "highlight"));
        } else {
          assert.equal(read.parts, parts);
          assert.equal(read.notes, undefined);
          assert.equal(read.highlights, undefined);
          assert.equal(sent.length, 1);
          assert.equal(sent[0].url.searchParams.get("id"), "doc-book");
          assert.ok(!sent.some((request) => request.url.searchParams.get("category") === "highlight"));
        }
        if (read.nextPart !== null) assert.match(read.text, /(\n|[.!?”’]\s)$/);
        texts.push(read.text);
        part = read.nextPart;
      }
      assert.ok(parts >= 13);
      assert.equal(texts.length, parts);
      assert.equal(texts.join(""), full);
      assert.deepEqual(readerParts(full), texts);
    } finally {
      globalThis.fetch = original;
      reader.documents.delete("doc-book");
      reader.documents.delete("hl-book-1");
    }
  });

  it("splits text without breaks into parts that lose nothing", () => {
    const solid = "x".repeat(READER_PART_CHARS * 2 + 5);
    assert.deepEqual(readerParts(solid).map((part) => part.length), [READER_PART_CHARS, READER_PART_CHARS, 5]);
    const sentences = "One idea here. ".repeat(10_000).trim();
    const split = readerParts(sentences);
    assert.equal(split.join(""), sentences);
    assert.ok(split.slice(0, -1).every((part) => part.endsWith(". ") && part.length <= READER_PART_CHARS));
    assert.deepEqual(readerParts(""), [""]);
    assert.deepEqual(readerParts("Short."), ["Short."]);
  });

  it("lets only the person who connected read their Reader through the assistant", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = reader.fetchImpl;
    try {
      const list = (await runTool(owner, "reader_list", { tags: ["research"], limit: 10 })) as {
        notice: string;
        documents: { id: string; title: string; author: string; url: string; tags: string[]; location: string }[];
      };
      assert.equal(list.notice, EXTERNAL_NOTICE);
      assert.deepEqual(
        list.documents.map((item) => ({ id: item.id, title: item.title, author: item.author, url: item.url, location: item.location })),
        [{ id: "doc-eclipse", title: "Notes on AI visibility", author: "Sam Analyst", url: "https://essays.example.test/ai-visibility", location: "later" }],
      );
      reader.put({ id: "doc-later", title: "Unsaved idea", tags: tags("ideas"), html_content: `<p>${"Long text. ".repeat(30_000)}</p>` });
      reader.put({ id: "hl-6", category: "highlight", parent_id: "doc-later", content: "Long text", notes: "Worth a look" });
      const read = (await runTool(owner, "reader_read", { id: "doc-later" })) as {
        notice: string;
        text: string;
        part: number;
        parts: number;
        characters: number;
        nextPart: number | null;
        highlights: { text: string; note: string | null }[];
        highlightsComplete: boolean;
      };
      assert.equal(read.notice, EXTERNAL_NOTICE);
      assert.equal(read.part, 1);
      assert.ok(read.characters > 300_000);
      assert.ok(read.parts >= 6);
      assert.equal(read.nextPart, 2);
      assert.ok(read.text.length <= READER_PART_CHARS);
      assert.deepEqual(read.highlights.map((item) => [item.text, item.note]), [["Long text", "Worth a look"]]);
      assert.equal(read.highlightsComplete, true);
      const last = (await runTool(owner, "reader_read", { id: "doc-later", part: read.parts })) as { nextPart: number | null; highlights?: unknown };
      assert.equal(last.nextPart, null);
      assert.equal(last.highlights, undefined);
      const beyond = (await runTool(owner, "reader_read", { id: "doc-later", part: read.parts + 1 })) as { error: string };
      assert.equal(beyond.error, `That document has ${read.parts} parts. Ask for part 1 to ${read.parts}.`);
      const highlights = (await runTool(owner, "reader_highlights", { tag: "research" })) as { highlights: { id: string; documentTitle: string | null }[] };
      assert.equal(highlights.highlights.length, 50);
      assert.equal(highlights.highlights[0].id, "hl-4");
      assert.ok(highlights.highlights.every((item) => item.documentTitle === "Notes on AI visibility"));
      assert.deepEqual(await runTool(owner, "reader_list", { highlights: true, tags: ["research"] }), highlights);
      const tooMany = (await runTool(owner, "reader_list", { highlights: true, tags: ["research", "orbit"] })) as { error: string };
      assert.equal(tooMany.error, "Highlights can be filtered by one tag at a time.");
      const recent = (await runTool(owner, "reader_highlights", { limit: 100 })) as { highlights: { id: string }[] };
      assert.ok(recent.highlights.length >= 4);
      assert.equal(((await runTool(owner, "reader_read", { id: "missing" })) as { error: string }).error, "That document isn't in your Reader.");

      const before = reader.requests.length;
      for (const name of ["reader_list", "reader_read", "reader_highlights"]) {
        const refused = (await runTool(member, name, { id: "doc-eclipse" })) as { error?: string };
        assert.match(refused.error ?? "", /Readwise Reader isn't connected/);
      }
      assert.equal(reader.requests.length, before);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives the same read-only Reader tools over MCP to the token's owner only", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = reader.fetchImpl;
    try {
      const rpc = async (token: string, method: string, params: Record<string, unknown> = {}) => {
        const response = await mcpRoute(
          new Request("http://crm.test/api/mcp", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          }),
        );
        return (await response.json()) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
      };
      const ownerToken = (await createPersonalToken(owner, "Claude")).token;
      const memberToken = (await createPersonalToken(member, "Claude")).token;
      const names = (await rpc(ownerToken, "tools/list")).result!.tools!.map((tool) => tool.name).filter((name) => name.startsWith("reader_"));
      assert.deepEqual(names.sort(), ["reader_highlights", "reader_list", "reader_read"]);
      const read = await rpc(ownerToken, "tools/call", { name: "reader_read", arguments: { id: "doc-eclipse" } });
      assert.ok(!read.result!.isError);
      assert.ok(read.result!.content![0].text.includes("Answer engines cite sources they trust."));
      const second = await rpc(ownerToken, "tools/call", { name: "reader_read", arguments: { id: "doc-later", part: 2 } });
      assert.ok(!second.result!.isError);
      const secondBody = JSON.parse(second.result!.content![0].text) as { part: number; parts: number; nextPart: number | null; text: string; highlights?: unknown };
      assert.equal(secondBody.part, 2);
      assert.equal(secondBody.nextPart, 3);
      assert.ok(secondBody.text.length > 0 && secondBody.text.length <= READER_PART_CHARS);
      assert.equal(secondBody.highlights, undefined);
      const refused = await rpc(memberToken, "tools/call", { name: "reader_list", arguments: {} });
      assert.equal(refused.result!.isError, true);
      assert.match(refused.result!.content![0].text, /isn't connected/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("only ever reads from Readwise", () => {
    assert.ok(reader.requests.length > 20);
    for (const request of reader.requests) {
      assert.equal(request.method, "GET", `${request.method} ${request.url}`);
      assert.equal(request.body, null);
      assert.equal(request.url.origin, "https://readwise.io");
      assert.ok(["/api/v2/auth/", "/api/v3/list/", "/api/v3/tags/"].includes(request.url.pathname), request.url.pathname);
    }
    assert.ok(!reader.requests.some((request) => ["POST", "PATCH", "PUT", "DELETE"].includes(request.method)));
  });

  it("deletes a member's Readwise token when they are removed", async () => {
    await saveReadwiseToken(member, MEMBER_TOKEN, reader);
    assert.equal((await readwiseStatus(member)).connected, true);
    await removeMember(owner, member.userId);
    const keys = await getAdminPool().query<{ total: number }>("select count(*)::int as total from crm.readwise_keys where user_id = $1", [member.userId]);
    assert.equal(keys.rows[0].total, 0);
    assert.equal((await readwiseStatus(owner)).connected, true);
  });
});
