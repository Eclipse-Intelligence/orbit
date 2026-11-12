import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { learnNow } from "@/lib/learning/nightly";
import { mailHelpSettings, prepareMail, setMailHelp } from "@/lib/mail/prepare";
import {
  listSubscriptions,
  researchMail,
  routeArrivedMail,
  setSubscription,
  unopenedSenders,
  unsubscribe,
  unsubscribeMany,
  unsubscribePreview,
} from "@/lib/mail/subscriptions";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads, threadKey } from "@/lib/mail/threads";
import { chooseMethod, parseListUnsubscribe, postOneClick, UnsubscribeRefused, type Lookup } from "@/lib/mail/unsubscribe";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DESTINATIONS: Record<string, string> = { archive: "f-archive", deleteditems: "f-trash" };

type Msg = Record<string, unknown> & { id: string };
type Header = { name: string; value: string };
type Call = { method: string; url: string; body: unknown };

function ago(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function message(id: string, from: string, overrides: Record<string, unknown> = {}): Msg {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: "Hello",
    body: { contentType: "text", content: "Our latest news. Unsubscribe or manage your preferences." },
    from: { emailAddress: { name: from.split("@")[0], address: from } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: ago(3),
    receivedDateTime: ago(3),
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
    ...overrides,
  };
}

function oneClick(url: string, mailto?: string): Header[] {
  return [
    { name: "List-Unsubscribe", value: [mailto ? `<mailto:${mailto}>` : "", `<${url}>`].filter(Boolean).join(", ") },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ];
}

function llmReply(body: { messages: { content: string }[] }) {
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  if (/morning brief/.test(system)) return { brief: "### In your market\n- Insights says agencies are buying." };
  if (/"pitches": number\[\]/.test(system)) {
    const numbers = [...user.matchAll(/\[(\d+)\] From: [^\n]*(growth@agency\.test|cold@vendor\.test)/g)].map((match) => Number(match[1]));
    return { pitches: numbers };
  }
  if (/prepare email replies/.test(system)) {
    return { needsReply: false, pitch: /"pitch": boolean/.test(system) && /We help companies like yours/.test(user), body: null };
  }
  if (/expectReply/.test(system)) return { expectReply: [] };
  return { emails: [] };
}

type World = { inbox: Msg[]; sent?: Msg[]; headers: Record<string, Header[]>; failMoves?: Set<string>; llmDown?: boolean };

function world(state: World) {
  const calls: Call[] = [];
  const prompts: { system: string; user: string }[] = [];
  let drafts = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    calls.push({ method, url, body });
    if (!url.startsWith(GRAPH)) {
      if (state.llmDown) return Response.json({ error: { message: "Gateway down" } }, { status: 500 });
      const parsed = body as { messages: { content: string }[] };
      prompts.push({ system: parsed.messages[0].content, user: parsed.messages[1].content });
      return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify(llmReply(parsed)) }, finish_reason: "stop" }] });
    }
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", archive: "f-archive", deleteditems: "f-trash" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: [
          { id: "f-inbox", displayName: "Inbox", childFolderCount: 0 },
          { id: "f-sent", displayName: "Sent Items", childFolderCount: 0 },
          { id: "f-archive", displayName: "Archive", childFolderCount: 0 },
          { id: "f-trash", displayName: "Deleted Items", childFolderCount: 0 },
        ],
      });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$filter=`)) return Response.json({ value: [] });
    if (method === "POST" && url === `${GRAPH}/me/mailFolders`) return Response.json({ id: "f-research", displayName: "Research" }, { status: 201 });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    if (folder) {
      const value = folder === "f-inbox" ? state.inbox : folder === "f-sent" ? (state.sent ?? []) : [];
      return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${Math.random()}` });
    }
    const headers = url.match(/\/me\/messages\/([^/?]+)\?\$select=internetMessageHeaders$/);
    if (headers) return Response.json({ internetMessageHeaders: state.headers[decodeURIComponent(headers[1])] ?? [] });
    const move = url.match(/\/me\/messages\/([^/]+)\/move$/);
    if (move && method === "POST") {
      const id = decodeURIComponent(move[1]);
      if (state.failMoves?.has(id)) return Response.json({ error: { code: "ErrorAccessDenied", message: "Outlook refused the move." } }, { status: 500 });
      state.inbox = state.inbox.filter((item) => item.id !== id);
      const destination = (body as { destinationId: string }).destinationId;
      return Response.json({ id, parentFolderId: DESTINATIONS[destination] ?? destination });
    }
    if (method === "POST" && url === `${GRAPH}/me/messages`) {
      drafts += 1;
      return Response.json({ id: `draft-${drafts}`, conversationId: `conv-draft-${drafts}`, subject: "" }, { status: 201 });
    }
    if (method === "PATCH") return Response.json({ id: "x" });
    if (url.endsWith("/send")) return new Response(null, { status: 202 });
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls, prompts };
}

const lookup: Lookup = async (host) => (host === "evil.test" ? ["127.0.0.1"] : host === "sneaky.test" ? ["93.184.216.34", "10.0.0.9"] : ["93.184.216.34"]);

function oneClickServer() {
  const posts: { url: string; method: string; body: unknown; type: string | null; redirect: string | undefined }[] = [];
  const postFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    posts.push({ url, method: init?.method ?? "GET", body: init?.body, type: new Headers(init?.headers).get("content-type"), redirect: init?.redirect });
    if (url.includes("oneclick.test")) return new Response("broken", { status: 500 });
    return new Response("You're unsubscribed", { status: 200 });
  };
  return { posts, postFetch };
}

async function folderOf(id: string) {
  const result = await getAdminPool().query<{ role: string; name: string }>(
    "select f.role, f.name from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where m.provider_message_id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

describe("unsubscribe headers", () => {
  it("reads List-Unsubscribe and List-Unsubscribe-Post", () => {
    const parsed = parseListUnsubscribe(
      "<mailto:leave@list.test?subject=Remove%20me&body=Please%20remove>,\r\n <https://list.test/u?id=1>, <http://list.test/old>",
      "List-Unsubscribe=One-Click",
    );
    assert.equal(parsed.oneClick, true);
    assert.deepEqual(parsed.https, ["https://list.test/u?id=1"]);
    assert.deepEqual(parsed.pages, ["https://list.test/u?id=1", "http://list.test/old"]);
    assert.deepEqual(parsed.mailto, [{ address: "leave@list.test", subject: "Remove me", body: "unsubscribe" }]);
    assert.equal(chooseMethod(parsed), "one_click");
  });

  it("sends one fixed message to the first address only, whatever the mailto asks for", () => {
    const parsed = parseListUnsubscribe(
      "<mailto:first@list.test,second@list.test?to=third@list.test&cc=boss@corp.test&bcc=all@corp.test&subject=Stop%0D%0ABcc:%20evil@corp.test%20a=b?c&body=Wire%20%C2%A3500>",
    );
    assert.deepEqual(parsed.mailto, [{ address: "first@list.test", subject: "Stop Bcc: evil@corp.test a=b?c", body: "unsubscribe" }]);
    assert.deepEqual(parseListUnsubscribe("<mailto:?to=only@list.test&subject=x>").mailto, [{ address: "only@list.test", subject: "x", body: "unsubscribe" }]);
    assert.equal(parseListUnsubscribe(`<mailto:a@list.test?subject=${"x".repeat(500)}>`).mailto[0].subject.length, 200);
  });

  it("falls back from one-click to mailto, then a page, then nothing", () => {
    const mailto = parseListUnsubscribe("<mailto:Leave@List.test>, <https://list.test/u>");
    assert.equal(mailto.oneClick, false);
    assert.deepEqual(mailto.mailto, [{ address: "leave@list.test", subject: "unsubscribe", body: "unsubscribe" }]);
    assert.equal(chooseMethod(mailto), "mailto");
    assert.equal(chooseMethod(parseListUnsubscribe("<https://list.test/u>", "List-Unsubscribe=One-Click-Not")), "page");
    assert.equal(chooseMethod(parseListUnsubscribe("<http://list.test/u>", "List-Unsubscribe=One-Click")), "page");
    assert.equal(chooseMethod(parseListUnsubscribe("https://bare.test/u")), "page");
    assert.equal(chooseMethod(parseListUnsubscribe("<mailto:not-an-address>, <javascript:alert(1)>, <https://user:pw@list.test/u>")), "none");
    assert.equal(chooseMethod(parseListUnsubscribe(null)), "none");
  });
});

describe("one-click unsubscribe POST", () => {
  it("posts List-Unsubscribe=One-Click to the https link without following redirects itself", async () => {
    const { posts, postFetch } = oneClickServer();
    const result = await postOneClick("https://brand.test/u/abc", { fetchImpl: postFetch, lookup });
    assert.deepEqual(result, { ok: true, status: 200, host: "brand.test" });
    assert.equal(posts[0].method, "POST");
    assert.equal(posts[0].body, "List-Unsubscribe=One-Click");
    assert.equal(posts[0].type, "application/x-www-form-urlencoded");
    assert.equal(posts[0].redirect, "manual");
  });

  it("refuses anything but public https addresses", async () => {
    const { posts, postFetch } = oneClickServer();
    for (const url of [
      "http://brand.test/u",
      "https://localhost/u",
      "https://127.0.0.1/u",
      "https://10.0.0.5/u",
      "https://192.168.1.4/u",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/u",
      "https://[fd00:ec2::254]/u",
      "https://metadata.google.internal/u",
      "https://printer.local/u",
      "https://evil.test/u",
      "https://sneaky.test/u",
      "https://brand.test:8443/u",
      "https://user:pw@brand.test/u",
    ]) {
      await assert.rejects(() => postOneClick(url, { fetchImpl: postFetch, lookup }), UnsubscribeRefused, url);
    }
    assert.equal(posts.length, 0);
  });

  it("checks every redirect and refuses one that points inside", async () => {
    const hops: { url: string; method: string }[] = [];
    const redirecting: typeof fetch = async (input, init) => {
      const url = String(input);
      hops.push({ url, method: init?.method ?? "GET" });
      if (url === "https://brand.test/a") return new Response(null, { status: 302, headers: { location: "https://done.test/thanks" } });
      if (url === "https://brand.test/b") return new Response(null, { status: 307, headers: { location: "/c" } });
      if (url === "https://brand.test/evil") return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } });
      if (url === "https://brand.test/plain") return new Response(null, { status: 301, headers: { location: "http://brand.test/x" } });
      return new Response("ok");
    };
    assert.equal((await postOneClick("https://brand.test/a", { fetchImpl: redirecting, lookup })).host, "done.test");
    assert.deepEqual(hops.splice(0), [
      { url: "https://brand.test/a", method: "POST" },
      { url: "https://done.test/thanks", method: "GET" },
    ]);
    await postOneClick("https://brand.test/b", { fetchImpl: redirecting, lookup });
    assert.deepEqual(hops.splice(0).map((hop) => hop.method), ["POST", "POST"]);
    await assert.rejects(() => postOneClick("https://brand.test/evil", { fetchImpl: redirecting, lookup }), UnsubscribeRefused);
    await assert.rejects(() => postOneClick("https://brand.test/plain", { fetchImpl: redirecting, lookup }), /only unsubscribes over https/);
    assert.ok(!hops.some((hop) => hop.url.includes("169.254")));
  });

  it("refuses a connection the public-only resolver blocks, times out and caps what it reads", async () => {
    const guarded: typeof fetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Private and local addresses can't be opened."), { code: "EPRIVATE" }) });
    };
    await assert.rejects(() => postOneClick("https://brand.test/u", { fetchImpl: guarded, lookup }), UnsubscribeRefused);
    const slow: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const alive = setTimeout(() => undefined, 5_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(alive);
          reject(new Error("aborted"));
        });
      });
    await assert.rejects(() => postOneClick("https://brand.test/u", { fetchImpl: slow, lookup, timeoutMs: 50 }), /didn't answer in time/);
    let pulled = 0;
    const huge: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(16 * 1024));
            if (pulled > 1_000) controller.close();
          },
        }),
      );
    await postOneClick("https://brand.test/u", { fetchImpl: huge, lookup });
    assert.ok(pulled < 10, `read ${pulled} chunks`);
  });
});

describe("unsubscribing in Mail", () => {
  let owner: UserActor;
  let other: UserActor;
  let sourceId: string;
  const server = oneClickServer();
  const state: World = {
    inbox: [
      message("n1", "news@brand.test", { from: { emailAddress: { name: "Brand News", address: "news@brand.test" } } }),
      message("n2", "news@brand.test", { from: { emailAddress: { name: "Brand News", address: "news@brand.test" } }, receivedDateTime: ago(30) }),
      message("d1", "digest@list.test"),
      message("p1", "hello@pageonly.test"),
      message("x1", "updates@nolink.test", { isRead: true }),
      message("j1", "jane@acme.test", { from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } } }),
      message("c1", "news@client.test"),
      message("l1", "offers@leadco.test"),
      message("s1", "sam@initech.test", { body: { contentType: "text", content: "Are we still on for Thursday?" } }),
      message("r1", "research@insights.test", { body: { contentType: "text", content: "Agencies are moving budget to AI search. Unsubscribe here." } }),
      message("f1", "fail@oneclick.test"),
      message("v1", "private@ssrf.test"),
      message("o1", "old@boundary.test", { receivedDateTime: ago(24 * 89) }),
      message("o2", "old@boundary.test", { receivedDateTime: ago(24 * 91) }),
      message("k1", "cold@vendor.test", {
        receivedDateTime: ago(1),
        body: { contentType: "text", content: "Hi Mark, We help companies like yours book 30 more demos a month. Worth a quick call?" },
      }),
    ],
    headers: {
      n1: oneClick("https://brand.test/u/abc", "leave@brand.test"),
      n2: oneClick("https://brand.test/u/abc", "leave@brand.test"),
      d1: [{ name: "List-Unsubscribe", value: "<mailto:leave@list.test?subject=Remove%20me>" }],
      p1: [{ name: "List-Unsubscribe", value: "<https://pageonly.test/preferences>" }],
      j1: oneClick("https://acme.test/u"),
      c1: oneClick("https://client.test/u"),
      l1: oneClick("https://leadco.test/u"),
      r1: oneClick("https://insights.test/u"),
      f1: oneClick("https://oneclick.test/u", "leave@oneclick.test"),
      v1: oneClick("https://10.0.0.5/u", "leave@ssrf.test"),
    },
  };
  const graph = world(state);
  const options = { fetchImpl: graph.fetchImpl, postFetch: server.postFetch, lookup };

  before(async () => {
    delete process.env.LLM_API_KEY;
    await resetDatabase();
    owner = await createUser("unsub@orbit.test", "Mark Ridgeon");
    other = await createUser("other@orbit.test", "Sam Other");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" });
    await createCompany(owner, { name: "Client Co", domain: "client.test", lifecycle: "customer" });
    await createCompany(owner, { name: "Lead Co", domain: "leadco.test" });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    sourceId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [owner.userId])).rows[0].id;
  });

  after(async () => {
    await getPool().end();
  });

  it("lists bulk senders with open counts, protects CRM relationships and picks the unopened ones", async () => {
    const listed = await listSubscriptions(owner);
    const bySender = new Map(listed.senders.map((sender) => [sender.sender, sender]));
    assert.equal(listed.days, 90);
    assert.deepEqual([bySender.get("news@brand.test")?.emails, bySender.get("news@brand.test")?.opened, bySender.get("news@brand.test")?.name], [2, 0, "Brand News"]);
    assert.equal(bySender.get("updates@nolink.test")?.opened, 1);
    assert.ok(!bySender.has("sam@initech.test"));
    assert.ok(!bySender.has("cold@vendor.test"));
    assert.equal(bySender.get("jane@acme.test")?.protection?.reason, "Jane Doe is a contact in Orbit.");
    assert.equal(bySender.get("news@client.test")?.protection?.reason, "Client Co is a client in Orbit.");
    assert.equal(bySender.get("offers@leadco.test")?.protection, null);
    assert.equal(bySender.get("old@boundary.test")?.emails, 1);
    assert.deepEqual(
      unopenedSenders(listed.senders).map((sender) => sender.sender).sort(),
      ["digest@list.test", "fail@oneclick.test", "hello@pageonly.test", "news@brand.test", "offers@leadco.test", "old@boundary.test", "private@ssrf.test", "research@insights.test"],
    );
    const theirs = await listSubscriptions(other);
    assert.deepEqual(theirs.senders, []);
  });

  it("unsubscribes with one click and archives what the sender already sent, across the thread list", async () => {
    const thread = threadKey(sourceId, "conv-n1");
    const preview = await unsubscribePreview(owner, { thread }, graph.fetchImpl);
    assert.equal(preview.method, "one_click");
    assert.equal(preview.target, "brand.test");
    assert.deepEqual(preview.existing, { inbox: 2, total: 2 });
    const result = await unsubscribe(owner, { thread, existing: "archive" }, options);
    assert.equal(result.outcome, "unsubscribed");
    assert.equal(result.method, "one_click");
    assert.equal(result.moved, 2);
    assert.equal(server.posts.at(-1)?.url, "https://brand.test/u/abc");
    assert.equal(server.posts.at(-1)?.body, "List-Unsubscribe=One-Click");
    assert.equal((await folderOf("n1"))?.role, "archive");
    assert.equal((await folderOf("n2"))?.role, "archive");
    const moves = graph.calls.filter((call) => call.url.endsWith("/move"));
    assert.deepEqual(moves.map((call) => (call.body as { destinationId: string }).destinationId), ["archive", "archive"]);
    const logged = await getAdminPool().query<{ method: string; outcome: string; existing: string }>(
      "select method, outcome, existing from crm.mail_unsubscribes where user_id = $1 and sender = 'news@brand.test'",
      [owner.userId],
    );
    assert.deepEqual(logged.rows, [{ method: "one_click", outcome: "unsubscribed", existing: "archive" }]);
    const listed = await listSubscriptions(owner);
    assert.equal(listed.senders.find((sender) => sender.sender === "news@brand.test")?.status, "unsubscribed");
    const audit = await getAdminPool().query("select 1 from crm.audit_events where event_type like 'mail%'");
    assert.equal(audit.rowCount, 0);
  });

  it("sends a mailto unsubscribe from the same mailbox with the given subject", async () => {
    const contact = await createContact(owner, { firstName: "List", lastName: "Robot", email: "leave@list.test" });
    const before = graph.calls.length;
    const result = await unsubscribe(owner, { sender: "digest@list.test", existing: "leave" }, options);
    assert.equal(result.outcome, "requested");
    assert.equal(result.method, "mailto");
    assert.equal(result.moved, 0);
    const calls = graph.calls.slice(before);
    const patch = calls.find((call) => call.method === "PATCH")?.body as { subject: string; toRecipients: { emailAddress: { address: string } }[]; body: { content: string } };
    assert.equal(patch.subject, "Remove me");
    assert.deepEqual(patch.toRecipients.map((item) => item.emailAddress.address), ["leave@list.test"]);
    assert.match(patch.body.content, /unsubscribe/);
    const contactId = (contact as { contact?: { id: string }; id?: string }).contact?.id ?? (contact as { id?: string }).id;
    const logged = await getAdminPool().query("select 1 from crm.activities where contact_id = $1", [contactId]);
    assert.equal(logged.rowCount, 0);
    assert.doesNotMatch(patch.body.content, /\/api\/mail\/open\//);
    assert.ok(calls.some((call) => call.url.endsWith("/draft-1/send")));
    assert.equal((await folderOf("d1"))?.role, "inbox");
  });

  it("opens the page when that is all there is, and offers Block when there is nothing", async () => {
    const preview = await unsubscribePreview(owner, { sender: "hello@pageonly.test" }, graph.fetchImpl);
    assert.deepEqual([preview.method, preview.pageUrl], ["page", "https://pageonly.test/preferences"]);
    const page = await unsubscribe(owner, { sender: "hello@pageonly.test", existing: "leave" }, options);
    assert.deepEqual([page.outcome, page.url], ["needs_you", "https://pageonly.test/preferences"]);
    assert.ok(!server.posts.some((post) => post.url.includes("pageonly")));
    const none = await unsubscribe(owner, { sender: "updates@nolink.test" }, options);
    assert.deepEqual([none.method, none.outcome, none.moved, none.status], ["none", "none", 0, "subscribed"]);
    const blocked = await setSubscription(owner, { sender: "updates@nolink.test", action: "block" }, options);
    assert.deepEqual([blocked.status, blocked.moved], ["blocked", 1]);
    assert.equal((await folderOf("x1"))?.role, "archive");
  });

  it("falls back to mailto when one-click fails, and never posts or emails when the link points inside", async () => {
    const failing = await unsubscribe(owner, { sender: "fail@oneclick.test", existing: "leave" }, options);
    assert.deepEqual([failing.method, failing.outcome], ["mailto", "requested"]);
    assert.ok(server.posts.some((post) => post.url === "https://oneclick.test/u"));
    const before = server.posts.length;
    const sends = graph.calls.filter((call) => call.url.endsWith("/send")).length;
    const preview = await unsubscribePreview(owner, { sender: "private@ssrf.test" }, graph.fetchImpl);
    assert.equal(preview.mailto, "leave@ssrf.test");
    const refused = await unsubscribe(owner, { sender: "private@ssrf.test", existing: "archive" }, options);
    assert.equal(graph.calls.filter((call) => call.url.endsWith("/send")).length, sends);
    assert.equal(refused.outcome, "failed");
    assert.match(refused.detail ?? "", /private address/);
    assert.equal(refused.moved, 0);
    assert.equal(server.posts.length, before);
    assert.equal((await folderOf("v1"))?.role, "inbox");
  });

  it("asks before unsubscribing from a contact or a client and leaves them out of the bulk action", async () => {
    await assert.rejects(() => unsubscribe(owner, { sender: "jane@acme.test" }, options), /Jane Doe is a contact in Orbit\. Confirm to unsubscribe anyway\./);
    await assert.rejects(() => setSubscription(owner, { sender: "@client.test", action: "block" }, options), /Client Co is a client in Orbit/);
    const bulk = await unsubscribeMany(owner, ["news@client.test", "offers@leadco.test"], { existing: "leave" }, options);
    assert.match((bulk[0] as { error: string }).error, /Client Co is a client/);
    assert.equal((bulk[1] as { outcome: string }).outcome, "unsubscribed");
    const confirmed = await unsubscribe(owner, { sender: "jane@acme.test", existing: "leave", confirmed: true }, options);
    assert.equal(confirmed.outcome, "unsubscribed");
  });

  it("refuses your own domain and protects every contact at a domain", async () => {
    await assert.rejects(() => setSubscription(owner, { sender: "@eclipse.test", action: "block" }, options), /your own domain/);
    await assert.rejects(() => setSubscription(owner, { sender: "@orbit.test", action: "research" }, options), /your own domain/);
    await assert.rejects(() => unsubscribe(owner, { sender: "@acme.test" }, options), /Jane Doe at @acme\.test is a contact in Orbit/);
    await assert.rejects(() => setSubscription(owner, { sender: "@acme.test", action: "block" }, options), /Jane Doe at @acme\.test is a contact/);
  });

  it("moves what a sender already sent to Trash when asked", async () => {
    const result = await unsubscribe(owner, { sender: "offers@leadco.test", existing: "trash" }, options);
    assert.deepEqual([result.outcome, result.moved, result.moveError], ["unsubscribed", 1, null]);
    assert.equal((await folderOf("l1"))?.role, "trash");
    const logged = await getAdminPool().query<{ moved: number; existing: string }>(
      "select moved, existing from crm.mail_unsubscribes where sender = 'offers@leadco.test' order by created_at desc limit 1",
    );
    assert.deepEqual(logged.rows[0], { moved: 1, existing: "trash" });
  });

  it("archives mail from a sender who keeps sending more than 7 days after an unsubscribe and marks them", async () => {
    const pool = getAdminPool();
    state.inbox.push(message("n3", "news@brand.test", { receivedDateTime: ago(0.5) }));
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    assert.equal((await folderOf("n3"))?.role, "inbox");
    await pool.query("update crm.mail_subscriptions set unsubscribed_at = now() - interval '10 days' where sender = 'news@brand.test'");
    state.inbox.push(message("n4", "news@brand.test", { receivedDateTime: ago(0.2) }), message("x2", "updates@nolink.test", { receivedDateTime: ago(0.2) }));
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    assert.equal(report.routed, 2);
    assert.equal((await folderOf("n4"))?.role, "archive");
    assert.equal((await folderOf("x2"))?.role, "archive");
    const listed = await listSubscriptions(owner);
    const brand = listed.senders.find((sender) => sender.sender === "news@brand.test");
    assert.equal(brand?.status, "ignored");
    assert.ok(brand?.ignoredAt);
    const detail = await getThread(owner, threadKey(sourceId, "conv-n4"));
    assert.equal(detail.subscription?.status, "ignored");
    assert.deepEqual(await routeArrivedMail(owner, ["not-an-id"], { fetchImpl: graph.fetchImpl }), []);
  });

  it("counts the 7 days from the unsubscribe, skips your own conversations and only marks a sender once the move works", async () => {
    const pool = getAdminPool();
    await pool.query("update crm.mail_subscriptions set unsubscribed_at = now() - interval '10 days', ignored_at = null where sender in ('fail@oneclick.test', 'digest@list.test')");
    state.inbox.push(
      message("f-early", "fail@oneclick.test", { receivedDateTime: ago(24 * 3.1) }),
      message("f-late", "fail@oneclick.test", { receivedDateTime: ago(24 * 2.9) }),
    );
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    assert.equal((await folderOf("f-early"))?.role, "inbox");
    assert.equal((await folderOf("f-late"))?.role, "archive");

    state.failMoves = new Set(["d2"]);
    state.inbox.push(message("d2", "digest@list.test", { receivedDateTime: ago(0.1) }));
    state.headers.d2 = state.headers.d1;
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    state.failMoves = undefined;
    assert.equal((await folderOf("d2"))?.role, "inbox");
    const digest = await pool.query<{ ignored_at: Date | null }>("select ignored_at from crm.mail_subscriptions where sender = 'digest@list.test'");
    assert.equal(digest.rows[0].ignored_at, null);

    state.sent = [message("me-1", "mark@eclipse.test", { conversationId: "conv-talk", toRecipients: [{ emailAddress: { name: "Help", address: "help@talk.test" } }], isRead: true })];
    await pool.query(
      `insert into crm.mail_subscriptions (workspace_id, user_id, sender, status, unsubscribed_at) values ($1, $2, 'news@talk.test', 'unsubscribed', now() - interval '30 days')`,
      [owner.workspaceId, owner.userId],
    );
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    state.inbox.push(message("t1", "news@talk.test", { conversationId: "conv-talk", receivedDateTime: ago(0.05) }));
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    assert.equal((await folderOf("t1"))?.role, "inbox");
  });

  it("keeps research senders out of the inbox but readable, and only for their owner", async () => {
    const kept = await setSubscription(owner, { sender: "research@insights.test", action: "research" }, options);
    assert.deepEqual([kept.status, kept.moved], ["research", 1]);
    assert.ok(graph.calls.some((call) => call.method === "POST" && call.url === `${GRAPH}/me/mailFolders` && (call.body as { displayName: string }).displayName === "Research"));
    assert.deepEqual(await folderOf("r1"), { role: "other", name: "Research" });
    state.inbox.push(message("r2", "research@insights.test", { receivedDateTime: ago(0.1), body: { contentType: "text", content: "Second issue: buyers ask for proof." } }));
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    assert.equal((await folderOf("r2"))?.name, "Research");
    const inbox = (await listThreads(owner, { view: { role: "inbox" } })).threads.map((thread) => thread.from?.address);
    assert.ok(!inbox.includes("research@insights.test"));
    const read = await researchMail(owner, { hours: 24 });
    assert.deepEqual(read.map((email) => email.from), ["research@insights.test", "research@insights.test"]);
    assert.match(read.map((email) => email.text).join(" "), /moving budget to AI search/);
    assert.deepEqual(await researchMail(other, { hours: 24 }), []);
    const keep = await setSubscription(owner, { sender: "offers@leadco.test", action: "keep" }, options);
    assert.equal(keep.status, "kept");
    assert.ok(!unopenedSenders((await listSubscriptions(owner)).senders).some((sender) => sender.sender === "offers@leadco.test"));
  });

  it("lets a domain block win over a kept or subscribed address, and undoes back to subscribed", async () => {
    const blocked = await setSubscription(owner, { sender: "@leadco.test", action: "block", existing: "leave" }, options);
    assert.deepEqual([blocked.status, blocked.moved], ["blocked", 0]);
    const listed = await listSubscriptions(owner);
    assert.equal(listed.senders.find((sender) => sender.sender === "@leadco.test")?.status, "blocked");
    assert.ok(!listed.senders.some((sender) => sender.sender === "offers@leadco.test"));
    state.inbox.push(message("l2", "offers@leadco.test", { receivedDateTime: ago(0.05) }));
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
    assert.equal((await folderOf("l2"))?.role, "archive");
    const undone = await setSubscription(owner, { sender: "@leadco.test", action: "subscribe" }, options);
    assert.equal(undone.status, "subscribed");
    assert.equal((await listSubscriptions(owner)).senders.find((sender) => sender.sender === "offers@leadco.test")?.status, "kept");
  });

  it("puts the research mail in the morning brief", async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    try {
      const before = graph.prompts.length;
      await learnNow(owner, { deadline: Date.now() + 120_000, fetchImpl: graph.fetchImpl, kinds: ["brief"] });
      const brief = graph.prompts.slice(before).find((prompt) => /morning brief/.test(prompt.system));
      assert.ok(brief);
      assert.match(brief.user, /Research mail/);
      assert.match(brief.user, /buyers ask for proof/);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("lets the assistant list subscriptions and act on senders through the existing mail tools", async () => {
    const listed = (await runTool(owner, "search_email", { folder: "subscriptions" })) as {
      subscriptions: { sender: string; opened: number; status: string; protected?: string }[];
      unopened: string[];
    };
    assert.equal(listed.subscriptions.find((row) => row.sender === "jane@acme.test")?.protected, "Jane Doe is a contact in Orbit.");
    assert.equal(listed.subscriptions.find((row) => row.sender === "updates@nolink.test")?.opened, 1);
    assert.ok(!listed.unopened.includes("jane@acme.test"));
    const research = (await runTool(owner, "search_email", { folder: "research" })) as { notice?: string; emails: { text: string }[] };
    assert.ok(research.notice);
    assert.match(research.emails.map((email) => email.text).join(" "), /buyers ask for proof/);
    const args = { action: "unsubscribe", senders: ["digest@list.test", "JANE@acme.test", " jane@acme.test", "not an address"], summary: "Newsletters you never open" };
    const names = await recordNames(owner, [args], ["mail_action"]);
    const card = describeAction("mail_action", args, names);
    assert.equal(card.title, "Unsubscribe from 2 senders");
    assert.equal(card.lines[0], "jane@acme.test. Jane Doe is a contact in Orbit.");
    assert.ok(card.lines.includes("Not an address or @domain, so left out: not an address"));
    const many = { action: "block", senders: [...Array.from({ length: 25 }, (_, index) => `n${index}@bulk.test`), "jane@acme.test"], summary: "x" };
    const manyCard = describeAction("mail_action", many, await recordNames(owner, [many], ["mail_action"]));
    assert.equal(manyCard.lines[0], "jane@acme.test. Jane Doe is a contact in Orbit.");
    assert.ok(manyCard.lines.includes("and 5 more"));
    assert.ok(card.lines.includes("digest@list.test"));
    assert.ok(card.lines.includes("Existing mail is archived."));
    const original = globalThis.fetch;
    globalThis.fetch = graph.fetchImpl;
    try {
      const done = (await runTool(owner, "mail_action", { action: "unsubscribe", senders: ["digest@list.test"], existingMail: "leave", summary: "Digest" })) as {
        results: { sender: string; outcome: string }[];
      };
      assert.deepEqual(done.results.map((row) => [row.sender, row.outcome]), [["digest@list.test", "Requested"]]);
      const blocked = (await runTool(owner, "mail_action", { action: "block", senders: ["@pageonly.test"], existingMail: "leave", summary: "Spam" })) as {
        changed: { sender: string; status: string }[];
      };
      assert.deepEqual(blocked.changed, [{ sender: "@pageonly.test", status: "Blocked", moved: 0 }]);
    } finally {
      globalThis.fetch = original;
    }
    const missing = (await runTool(owner, "mail_action", { action: "keep", summary: "x" })) as { error?: string };
    assert.match(String(missing.error), /Say which senders/);
  });

  it("keeps cold pitches out of the inbox only when switched on, using the prepared reply step", async () => {
    assert.equal((await mailHelpSettings(owner)).coldPitches, "off");
    process.env.LLM_API_KEY = "test-llm-key";
    try {
      await setMailHelp(owner, { autoRemindDays: null });
      const before = graph.prompts.length;
      await prepareMail(owner, { deadline: Date.now() + 120_000, fetchImpl: graph.fetchImpl });
      assert.ok(graph.prompts.slice(before).every((prompt) => !/"pitch": boolean/.test(prompt.system)));
      assert.equal((await folderOf("k1"))?.role, "inbox");

      await getAdminPool().query("delete from crm.mail_prepared where user_id = $1", [owner.userId]);
      await setMailHelp(owner, { coldPitches: "archive" });
      const second = graph.prompts.length;
      const report = await prepareMail(owner, { deadline: Date.now() + 120_000, fetchImpl: graph.fetchImpl });
      assert.equal(report.pitches, 1);
      const asked = graph.prompts.slice(second).filter((prompt) => /"pitch": boolean/.test(prompt.system));
      assert.ok(asked.some((prompt) => /cold@vendor\.test/.test(prompt.user)));
      assert.ok(!asked.some((prompt) => /jane@acme\.test/.test(prompt.user)));
      assert.ok(!graph.prompts.slice(second).some((prompt) => /"pitches"/.test(prompt.system) && /cold@vendor/.test(prompt.user)));
      assert.equal((await folderOf("k1"))?.role, "archive");
      assert.equal((await folderOf("s1"))?.role, "inbox");
      const cold =(await listSubscriptions(owner)).senders.find((sender) => sender.sender === "cold@vendor.test");
      assert.equal(cold?.coldPitch, true);
      assert.equal((await getThread(owner, threadKey(sourceId, "conv-k1"))).subscription?.coldPitch, true);

      state.inbox.push(
        message("g1", "growth@agency.test", {
          receivedDateTime: ago(0.1),
          body: { contentType: "text", content: "We grow agencies. Fancy a chat?" },
        }),
      );
      await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
      await setMailHelp(owner, { coldPitches: "other", prepareReplies: false });
      const third = graph.prompts.length;
      const batched = await prepareMail(owner, { deadline: Date.now() + 120_000, fetchImpl: graph.fetchImpl });
      assert.equal(batched.pitches, 1);
      const sorting = graph.prompts.slice(third).filter((prompt) => /"pitches"/.test(prompt.system));
      assert.equal(sorting.length, 1);
      assert.match(sorting[0].user, /growth@agency\.test/);
      assert.doesNotMatch(sorting[0].user, /jane@acme\.test/);
      const other = (await listThreads(owner, { view: { role: "inbox", split: "other" } })).threads.map((thread) => thread.from?.address);
      assert.ok(other.includes("growth@agency.test"));
      await setSubscription(owner, { sender: "growth@agency.test", action: "keep" }, options);
      const rules = await getAdminPool().query("select 1 from crm.mail_sender_rules where sender = 'growth@agency.test'");
      assert.equal(rules.rowCount, 0);
      await setSubscription(owner, { sender: "growth@agency.test", action: "subscribe" }, options);

      state.llmDown = true;
      state.inbox.push(message("g2", "pitch@newco.test", { receivedDateTime: ago(0.05), body: { contentType: "text", content: "We grow agencies too." } }));
      await syncMail(owner, { budgetMs: 30_000, fetchImpl: graph.fetchImpl });
      await prepareMail(owner, { deadline: Date.now() + 120_000, fetchImpl: graph.fetchImpl });
      const failed = await getAdminPool().query<{ failures: number }>(
        "select f.failures from crm.mail_pitch_failures f join crm.mail_messages m on m.id = f.message_id where m.provider_message_id = 'g2'",
      );
      assert.equal(failed.rows[0]?.failures, 1);
      state.llmDown = false;
      const quiet = graph.prompts.length;
      await prepareMail(owner, { deadline: Date.now() + 120_000, fetchImpl: graph.fetchImpl });
      assert.ok(!graph.prompts.slice(quiet).some((prompt) => /pitch@newco\.test/.test(prompt.user)));
      await getAdminPool().query("update crm.mail_pitch_failures set last_failed_at = now() - interval '7 hours'");
      await prepareMail(owner, { deadline: Date.now() + 120_000, fetchImpl: graph.fetchImpl });
      assert.ok(graph.prompts.slice(quiet).some((prompt) => /pitch@newco\.test/.test(prompt.user)));
      const unsubscribed = await unsubscribe(owner, { thread: threadKey(sourceId, "conv-g1"), block: true, existing: "archive" }, options);
      assert.deepEqual([unsubscribed.outcome, unsubscribed.status, unsubscribed.moved], ["none", "blocked", 1]);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });
});
