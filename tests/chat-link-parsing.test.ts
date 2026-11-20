import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { messageLinks, previewUrls, recordRef, recordRefs } from "@/lib/chat/links";
import { forgetRecordCards, loadRecordCards, RECORD_CARD_FRESH_MS } from "@/lib/chat/record-cards";
import type { ChatRecordCard } from "@/lib/chat/links";
import { applyPreviews, chatReducer, EMPTY_CHAT, type ChatState } from "@/lib/chat/timeline";
import type { ChatLinkPreview, ChatMessage } from "@/lib/chat/types";
import { fetchLinkPreview, IMAGE_MAX_BYTES, PAGE_MAX_BYTES, parsePreview, previewsOf, sniffImageType } from "@/lib/crm/chat-link-previews";

const PUBLIC = async () => ["93.184.216.34"];
const COMPANY = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const DEAL = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const DOC = "55555555-5555-4555-8555-555555555555";

function site(pages: Record<string, { body?: string | Uint8Array; type?: string; status?: number; location?: string }>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const page = pages[url];
    if (!page) return new Response("missing", { status: 404 });
    return new Response(page.body ? Buffer.from(page.body) : null, {
      status: page.status ?? 200,
      headers: { "content-type": page.type ?? "text/html; charset=utf-8", ...(page.location ? { location: page.location } : {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("links in a message", () => {
  it("finds written links in plain and markdown messages and ignores code", () => {
    const plain = "See https://a.test/one, then (https://b.test/two) and https://a.test/one again.";
    assert.deepEqual(messageLinks(plain, "plain").map((url) => url.href), ["https://a.test/one", "https://b.test/two"]);
    const markdown = "Read [the notes](https://notes.test/x) or `https://code.test/inline`\n\n```\nhttps://fenced.test/y\n```\n\n**https://bold.test/z**\n\n- https://list.test/1";
    assert.deepEqual(
      messageLinks(markdown, "markdown").map((url) => url.href),
      ["https://notes.test/x", "https://bold.test/z", "https://list.test/1"],
    );
  });

  it("skips mentions, mail links, other schemes, credentials and very long addresses", () => {
    const body = `@[Sam](member:${COMPANY}) mailto:sam@a.test ftp://old.test/file javascript:alert(1) https://user:pass@secret.test/ https://ok.test/${"a".repeat(2100)} https://fine.test/`;
    assert.deepEqual(messageLinks(body, "plain").map((url) => url.href), ["https://fine.test/"]);
  });

  it("previews only the first two https addresses that are not Orbit's own", () => {
    const body = "http://plain.test/a https://one.test/ https://orbit.test/companies/x https://two.test/ https://three.test/";
    assert.deepEqual(previewUrls(body, "plain", "https://orbit.test"), ["https://one.test/", "https://two.test/"]);
    assert.deepEqual(previewUrls(body, "plain", null), ["https://one.test/", "https://orbit.test/companies/x"]);
  });

  it("recognises Orbit record links by origin and path only", () => {
    const origin = "https://orbit.test";
    assert.deepEqual(recordRef(new URL(`${origin}/companies/${COMPANY}`)), { kind: "company", id: COMPANY });
    assert.deepEqual(recordRef(new URL(`${origin}/contacts/${CONTACT.toUpperCase()}/`)), { kind: "contact", id: CONTACT });
    assert.deepEqual(recordRef(new URL(`${origin}/opportunities/${DEAL}`)), { kind: "opportunity", id: DEAL });
    assert.deepEqual(recordRef(new URL(`${origin}/tasks?who=tagged&task=${TASK}`)), { kind: "task", id: TASK });
    assert.deepEqual(recordRef(new URL(`${origin}/docs/${DOC}?in=daily`)), { kind: "doc", id: DOC });
    for (const other of ["/companies", "/companies/not-an-id", `/companies/${COMPANY}/edit`, "/tasks?task=nope", "/tasks", `/mail/${COMPANY}`]) {
      assert.equal(recordRef(new URL(`${origin}${other}`)), null, other);
    }
    const body = `${origin}/companies/${COMPANY} https://evil.test/companies/${CONTACT} ${origin}/contacts/${CONTACT} ${origin}/companies/${COMPANY} ${origin}/docs/${DOC}`;
    assert.deepEqual(recordRefs(body, "plain", origin), [
      { kind: "company", id: COMPANY },
      { kind: "contact", id: CONTACT },
    ]);
    assert.deepEqual(recordRefs(body, "plain", null), []);
    assert.deepEqual(recordRefs(`http://orbit.test/companies/${COMPANY}`, "plain", origin), []);
  });
});

describe("reading Open Graph markup", () => {
  const page = new URL("https://news.example/story/1");

  it("reads the usual tags, decodes entities and resolves a relative image", () => {
    const html = `<!doctype html><html><head>
      <meta charset="utf-8">
      <title>Ignored &amp; later</title>
      <meta property="og:title" content="Q3 results &amp; outlook &eacute;t&#233; &#x2019;26&nbsp;now">
      <meta property='og:description' content='Revenue up 12%. &quot;Strong&quot; quarter.'>
      <meta property="og:site_name" content="The Daily">
      <meta property="og:image" content="/img/cover.jpg?x=1&amp;y=2">
    </head><body><meta property="og:title" content="From the body"></body></html>`;
    assert.deepEqual(parsePreview(html, page), {
      title: "Q3 results & outlook été ’26 now",
      description: 'Revenue up 12%. "Strong" quarter.',
      site: "The Daily",
      image_url: "https://news.example/img/cover.jpg?x=1&y=2",
    });
  });

  it("copes with attribute order, quoting, case and whitespace", () => {
    const html = `<HTML><HEAD><META CONTENT=Bare-title PROPERTY=og:title><meta
      content = "Spaced description"
      name = "description" /><meta name="twitter:image" content="//cdn.example/pic.png"></HEAD>`;
    assert.deepEqual(parsePreview(html, page), { title: "Bare-title", description: "Spaced description", site: "news.example", image_url: "https://cdn.example/pic.png" });
  });

  it("falls back from Open Graph to Twitter tags, the description meta and the title element", () => {
    assert.equal(parsePreview(`<meta name="twitter:title" content="Tweet title"><meta name="twitter:description" content="Tweet text">`, page)?.title, "Tweet title");
    const titled = parsePreview(`<head><title>\n  Just   a\ttitle \n</title></head>`, new URL("https://www.example.org/x"));
    assert.deepEqual(titled, { title: "Just a title", description: null, site: "example.org", image_url: null });
    assert.equal(parsePreview(`<meta name="description" content="Only text">`, page)?.description, "Only text");
  });

  it("returns nothing when there is no title or description, and never keeps unsafe images", () => {
    assert.equal(parsePreview(`<head><meta property="og:image" content="https://x.test/a.png"></head>`, page), null);
    assert.equal(parsePreview("", page), null);
    for (const image of ["data:image/png;base64,AAAA", "javascript:alert(1)", "ftp://x.test/a.png", "https://user:pw@x.test/a.png", ""]) {
      assert.equal(parsePreview(`<title>T</title><meta property="og:image" content="${image}">`, page)?.image_url, null, image);
    }
    assert.equal(parsePreview(`<title>T</title><meta property="og:image" content="https://x.test/${"a".repeat(2100)}"><meta name="twitter:image" content="/ok.png">`, page)?.image_url, "https://news.example/ok.png");
  });

  it("ignores tags in comments, scripts and styles and stops at the body", () => {
    const html = `<head><!-- <meta property="og:title" content="Commented"> --><script>var s = '<meta property="og:title" content="Scripted">';</script><style>/* <title>Styled</title> */</style>
      <meta property="og:title" content="Real"></head><body><title>Body title</title></body>`;
    assert.equal(parsePreview(html, page)?.title, "Real");
  });

  it("strips control and direction characters and shortens long text", () => {
    const html = `<meta property="og:title" content="A‮b​c\u0007d"><meta property="og:description" content="${"word ".repeat(200)}">`;
    const found = parsePreview(html, page)!;
    assert.equal(found.title, "A b c d");
    assert.ok(found.description!.length <= 300);
    assert.ok(found.description!.endsWith("…"));
  });

  it("stays fast on hostile markup", () => {
    const started = Date.now();
    parsePreview("<script ".repeat(60_000), page);
    parsePreview("<meta a=\"".repeat(40_000), page);
    parsePreview("<title ".repeat(60_000), page);
    parsePreview("<!--".repeat(60_000), page);
    parsePreview(`<meta ${'x="y" '.repeat(5_000)} property="og:title" content="late">${"<meta name=a content=b>".repeat(5_000)}`, page);
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
  });
});

describe("fetching a page for its preview", () => {
  const html = `<head><title>Acme</title><meta property="og:description" content="Widgets"></head><body>Hi</body>`;

  it("reads a public page and returns the address that was written, not where it redirected", async () => {
    const { fetchImpl, seen } = site({ "https://short.test/a": { status: 301, location: "https://acme.test/home" }, "https://acme.test/home": { body: html } });
    const found = await fetchLinkPreview("https://short.test/a", { fetchImpl, lookup: PUBLIC });
    assert.deepEqual(found, { url: "https://short.test/a", title: "Acme", description: "Widgets", site: "acme.test", image_url: null });
    assert.deepEqual(seen, ["https://short.test/a", "https://acme.test/home"]);
  });

  it("refuses private and loopback addresses, and redirects into them, without asking them anything", async () => {
    const { fetchImpl, seen } = site({ "https://hop.test/x": { status: 302, location: "http://169.254.169.254/latest/meta-data" } });
    assert.equal(await fetchLinkPreview("https://hop.test/x", { fetchImpl, lookup: PUBLIC }), null);
    assert.deepEqual(seen, ["https://hop.test/x"]);
    for (const url of ["https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://10.0.0.5/admin", "https://internal.local/", "https://printer.internal/", "https://[::ffff:7f00:1]/"]) {
      const none = site({});
      assert.equal(await fetchLinkPreview(url, { fetchImpl: none.fetchImpl, lookup: PUBLIC }), null, url);
      assert.deepEqual(none.seen, [], url);
    }
    const rebinding = site({ "https://rebind.test/": { body: html } });
    assert.equal(await fetchLinkPreview("https://rebind.test/", { fetchImpl: rebinding.fetchImpl, lookup: async () => ["93.184.216.34", "192.168.1.4"] }), null);
    assert.deepEqual(rebinding.seen, []);
  });

  it("refuses redirect loops, errors, timeouts and pages that aren't HTML", async () => {
    const loop = site({ "https://a.test/": { status: 302, location: "https://b.test/" }, "https://b.test/": { status: 302, location: "https://a.test/" } });
    assert.equal(await fetchLinkPreview("https://a.test/", { fetchImpl: loop.fetchImpl, lookup: PUBLIC }), null);
    const errors = site({ "https://gone.test/": { status: 404, body: html }, "https://blocked.test/": { status: 403, body: html } });
    assert.equal(await fetchLinkPreview("https://gone.test/", { fetchImpl: errors.fetchImpl, lookup: PUBLIC }), null);
    assert.equal(await fetchLinkPreview("https://blocked.test/", { fetchImpl: errors.fetchImpl, lookup: PUBLIC }), null);
    const aborted = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    assert.equal(await fetchLinkPreview("https://slow.test/", { fetchImpl: aborted, lookup: PUBLIC }), null);
    const files = site({
      "https://files.test/a.pdf": { body: "%PDF-1.7 <title>Pdf</title>", type: "application/pdf" },
      "https://files.test/a.png": { body: html, type: "image/png" },
      "https://files.test/a.json": { body: `{"title":"x"}`, type: "application/json" },
      "https://files.test/none": { body: html, type: "" },
    });
    for (const name of ["a.pdf", "a.png", "a.json", "none"]) assert.equal(await fetchLinkPreview(`https://files.test/${name}`, { fetchImpl: files.fetchImpl, lookup: PUBLIC }), null, name);
  });

  it("reads at most 512KB of a page and still finds tags in the head", async () => {
    let sent = 0;
    const fetchImpl = (async () => {
      const head = new TextEncoder().encode(`<head><title>Big page</title></head><body>`);
      const filler = new Uint8Array(64 * 1024).fill(97);
      let step = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            const chunk = step === 0 ? head : filler;
            step += 1;
            sent += chunk.byteLength;
            controller.enqueue(chunk);
            if (step > 400) controller.close();
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    const found = await fetchLinkPreview("https://big.test/", { fetchImpl, lookup: PUBLIC });
    assert.equal(found?.title, "Big page");
    assert.ok(sent <= PAGE_MAX_BYTES + 3 * 64 * 1024, `read ${sent} bytes`);
  });

  it("decodes the page's own character set", async () => {
    const latin1 = Buffer.from(`<head><title>Café menu</title></head>`, "latin1");
    const labelled = site({ "https://cafe.test/": { body: latin1, type: "text/html; charset=iso-8859-1" } });
    assert.equal((await fetchLinkPreview("https://cafe.test/", { fetchImpl: labelled.fetchImpl, lookup: PUBLIC }))?.title, "Café menu");
    const metaLabelled = site({ "https://cafe.test/m": { body: Buffer.from(`<head><meta charset="windows-1252"><title>Café</title></head>`, "latin1"), type: "text/html" } });
    assert.equal((await fetchLinkPreview("https://cafe.test/m", { fetchImpl: metaLabelled.fetchImpl, lookup: PUBLIC }))?.title, "Café");
  });
});

describe("recognising image bytes", () => {
  it("accepts only the four image types, judged from the bytes", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const gif = new TextEncoder().encode("GIF89a\u0001\u0000");
    const webp = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
    assert.equal(sniffImageType(png), "image/png");
    assert.equal(sniffImageType(jpeg), "image/jpeg");
    assert.equal(sniffImageType(gif), "image/gif");
    assert.equal(sniffImageType(webp), "image/webp");
    for (const text of ["<svg xmlns='http://www.w3.org/2000/svg'></svg>", "<!doctype html><html></html>", "<?xml version='1.0'?><svg/>", "RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "%PDF-1.7", ""]) {
      assert.equal(sniffImageType(new TextEncoder().encode(text)), null, text);
    }
    assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8])), null);
    assert.ok(IMAGE_MAX_BYTES === 2 * 1024 * 1024);
  });
});

describe("previews shown on a message", () => {
  const row = (url: string, id = url) => ({ id, url, title: "T", description: null, site: "s", image_url: null as string | null });

  it("shows only previews for addresses the message still contains, in the message's order", () => {
    const rows = [row("https://b.test/"), row("https://a.test/"), row("https://gone.test/")];
    assert.deepEqual(
      previewsOf(rows, "https://a.test/ then https://b.test/", "plain").map((item) => item.url),
      ["https://a.test/", "https://b.test/"],
    );
    assert.deepEqual(previewsOf(rows, "No links now", "plain"), []);
    assert.deepEqual(previewsOf(null, "https://a.test/", "plain"), []);
  });

  it("tells the browser there is an image without handing out its address", () => {
    const [shown] = previewsOf([{ ...row("https://a.test/"), image_url: "https://a.test/i.png" }], "https://a.test/", "plain");
    assert.equal(shown.image, true);
    assert.ok(!("image_url" in shown));
  });
});

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    conversationId: "c1",
    parentId: null,
    kind: "message",
    author: { id: "u1", name: "Sam" },
    via: null,
    clientKey: null,
    body: "https://a.test/",
    format: "plain",
    mentions: [],
    replyCount: 0,
    lastReplyAt: null,
    replyAuthors: [],
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-11-20T10:00:00.000Z",
    hook: null,
    attachments: [],
    previews: [],
    quotedId: null,
    reactions: [],
    ...overrides,
  };
}

const PREVIEW: ChatLinkPreview = { id: "p1", url: "https://a.test/", title: "A", description: null, site: "a.test", image: false };

describe("previews arriving live", () => {
  it("lands on the message in a room, in a thread and on a thread's root, and leaves other messages alone", () => {
    const root = chatMessage({ id: "root", replyCount: 1 });
    const reply = chatMessage({ id: "reply", parentId: "root" });
    const other = chatMessage({ id: "other" });
    const state: ChatState = {
      ...EMPTY_CHAT,
      timelines: { c1: { messages: [root, other], hasOlder: false, hasNewer: false, firstUnreadId: null, lastReadAt: null, status: "ready", error: null, stale: false, after: null, gone: [] } },
      threads: {
        root: {
          conversation: null,
          root,
          following: false,
          timeline: { messages: [reply], hasOlder: false, hasNewer: false, firstUnreadId: null, lastReadAt: null, status: "ready", error: null, stale: false, after: null, gone: [] },
        },
      },
    };
    const inRoom = chatReducer(state, { type: "previews", conversationId: "c1", messageId: "root", parentId: null, previews: [PREVIEW] });
    assert.deepEqual(inRoom.timelines.c1.messages.map((item) => item.previews.length), [1, 0]);
    assert.equal(inRoom.threads.root.root?.previews.length, 1);
    const inThread = chatReducer(state, { type: "previews", conversationId: "c1", messageId: "reply", parentId: "root", previews: [PREVIEW] });
    assert.equal(inThread.threads.root.timeline.messages[0].previews.length, 1);
    assert.equal(inThread.timelines.c1.messages[0].previews.length, 0);
    const removed = chatReducer(inRoom, { type: "previews", conversationId: "c1", messageId: "root", parentId: null, previews: [] });
    assert.equal(removed.timelines.c1.messages[0].previews.length, 0);
  });

  it("ignores a message that was deleted and keeps lists that don't hold it", () => {
    const gone = chatMessage({ deletedAt: "2026-11-20T11:00:00.000Z" });
    assert.deepEqual(applyPreviews([gone], "m1", [PREVIEW]), [gone]);
    const list = [chatMessage()];
    assert.equal(applyPreviews(list, "missing", [PREVIEW]), list);
  });
});

describe("record cards in the browser", () => {
  afterEach(() => forgetRecordCards());

  const card = (kind: ChatRecordCard["kind"], id: string, title: string): ChatRecordCard => ({ kind, id, title, subtitle: null, pill: null, figure: null, dueAt: null, href: `/x/${id}` });

  it("asks for each record once while a request is in flight and again after it goes stale", async () => {
    const calls: string[][] = [];
    let clock = 1_000;
    const load = async (refs: { kind: ChatRecordCard["kind"]; id: string }[]) => {
      calls.push(refs.map((ref) => ref.id));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return refs.map((ref) => card(ref.kind, ref.id, `Record ${ref.id.slice(0, 2)}`));
    };
    const options = { load, now: () => clock };
    const refs = [{ kind: "company" as const, id: COMPANY }];
    const [first, second] = await Promise.all([loadRecordCards(refs, options), loadRecordCards(refs, options)]);
    assert.equal(first[0].title, "Record 11");
    assert.deepEqual(second, first);
    assert.deepEqual(calls, [[COMPANY]]);
    await loadRecordCards([...refs, { kind: "contact", id: CONTACT }], options);
    assert.deepEqual(calls, [[COMPANY], [CONTACT]]);
    clock += RECORD_CARD_FRESH_MS + 1;
    await loadRecordCards(refs, options);
    assert.deepEqual(calls.at(-1), [COMPANY]);
  });

  it("shows nothing for a record the server would not show, and nothing when the request fails", async () => {
    const options = { load: async () => [] as ChatRecordCard[] };
    assert.deepEqual(await loadRecordCards([{ kind: "task", id: TASK }], options), []);
    forgetRecordCards();
    const failing = { load: async (): Promise<ChatRecordCard[]> => Promise.reject(new Error("offline")) };
    assert.deepEqual(await loadRecordCards([{ kind: "doc", id: DOC }], failing), []);
    let calls = 0;
    const recovered = { load: async () => (calls += 1, [card("doc", DOC, "Back")]) };
    assert.equal((await loadRecordCards([{ kind: "doc", id: DOC }], recovered))[0].title, "Back");
    assert.equal(calls, 1);
  });

  it("stops showing a card once access is lost on the next fresh load", async () => {
    let clock = 0;
    let visible = true;
    const load = async () => (visible ? [card("task", TASK, "Chase Acme")] : []);
    const options = { load, now: () => clock };
    assert.equal((await loadRecordCards([{ kind: "task", id: TASK }], options)).length, 1);
    visible = false;
    clock += RECORD_CARD_FRESH_MS + 1;
    assert.equal((await loadRecordCards([{ kind: "task", id: TASK }], options)).length, 0);
  });
});
