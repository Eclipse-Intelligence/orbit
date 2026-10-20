import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { POST as webhook } from "@/app/api/microsoft/mail-webhook/route";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool, query } from "@/lib/db/pool";
import { setMailNotifications } from "@/lib/mail/notify";
import { syncMail } from "@/lib/mail/sync";
import { pushKeys, pushToUser, savePushSubscription, type PushSender } from "@/lib/push";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function message(id: string, from: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: `Preview ${id}`,
    body: { contentType: "text", content: "Hello" },
    from: { emailAddress: { name: `Name ${id}`, address: from } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: new Date().toISOString(),
    receivedDateTime: new Date().toISOString(),
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
    inferenceClassification: "focused",
    ...overrides,
  };
}

function outlook(state: { inbox: unknown[] }) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === `${GRAPH}/subscriptions` && method === "POST") return Response.json({ id: "sub-1", expirationDateTime: new Date(Date.now() + 3 * 86_400_000).toISOString() }, { status: 201 });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("$select=id,inferenceClassification")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    return Response.json({ value: folder === "f-inbox" ? state.inbox : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${Math.random()}` });
  };
  return { fetchImpl, calls };
}

function pusher(status?: number) {
  const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
  const send: PushSender = async (subscription, payload) => {
    if (status) throw Object.assign(new Error("gone"), { statusCode: status });
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
  };
  return { send, sent };
}

describe("notifications", () => {
  let owner: UserActor;
  const state = { inbox: [message("first", "jane@acme.test")] as unknown[] };

  before(async () => {
    process.env.SITE_URL = "https://orbit.test";
    await resetDatabase();
    owner = await createUser("push@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" });
    await savePushSubscription(owner, { endpoint: "https://push.example/device-1", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
  });

  after(async () => {
    delete process.env.SITE_URL;
    await getPool().end();
  });

  it("makes push keys once and keeps them", async () => {
    const first = await pushKeys();
    assert.ok(first.publicKey.length > 40);
    const stored = await getAdminPool().query("select count(*)::int as count from private.push_keys");
    assert.equal(stored.rows[0].count, 1);
    assert.equal((await pushKeys()).publicKey, first.publicKey);
  });

  it("checks a device before saving it", async () => {
    await assert.rejects(() => savePushSubscription(owner, { endpoint: "http://insecure", keys: { p256dh: "x", auth: "y" } }, null), /couldn't set up/);
  });

  it("stays quiet on the first sync, then alerts about new important mail within the same sync", async () => {
    const quiet = pusher();
    const first = outlook(state);
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: first.fetchImpl, push: quiet.send });
    assert.equal(quiet.sent.length, 0);
    const subscription = first.calls.find((call) => call.url === `${GRAPH}/subscriptions`);
    assert.equal(subscription?.body?.notificationUrl, "https://orbit.test/api/microsoft/mail-webhook");
    assert.equal(subscription?.body?.resource, "me/mailFolders('inbox')/messages");

    state.inbox = [message("from-jane", "jane@acme.test"), message("newsletter", "news@brand.test")];
    const loud = pusher();
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl, push: loud.send });
    assert.equal(loud.sent.length, 1);
    assert.equal(loud.sent[0].payload.title, "Name from-jane");
    assert.equal(loud.sent[0].payload.body, "Subject from-jane\nPreview from-jane");
    assert.match(String(loud.sent[0].payload.url), /^\/mail\?view=inbox:important&thread=/);
    assert.equal(loud.sent[0].payload.badge, 2);

    const again = pusher();
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl, push: again.send });
    assert.equal(again.sent.length, 0);
  });

  it("follows the chosen level and groups a burst", async () => {
    await setMailNotifications(owner, { mail: "all" });
    state.inbox = [message("n1", "a@x.test"), message("n2", "b@x.test"), message("n3", "c@x.test"), message("n4", "d@x.test")];
    const burst = pusher();
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl, push: burst.send });
    assert.deepEqual(burst.sent.map((item) => item.payload.title), ["4 new emails"]);
    state.inbox = [message("n-news", "news@brand.test")];
    const news = pusher();
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl, push: news.send });
    assert.match(String(news.sent[0].payload.url), /^\/mail\?view=inbox:news&thread=/);
    await setMailNotifications(owner, { mail: "none" });
    state.inbox = [message("n5", "jane@acme.test")];
    const off = pusher();
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl, push: off.send });
    assert.equal(off.sent.length, 0);
    await setMailNotifications(owner, { mail: "important" });
  });

  it("tests one device and says why the push service refused it", async () => {
    await savePushSubscription(owner, { endpoint: "https://web.push.apple.com/mac", keys: { p256dh: "BKey", auth: "auth" } }, "Mac");
    const one = pusher();
    const sent = await pushToUser(owner, { title: "Orbit", body: "Test", url: "/mail" }, { send: one.send, endpoint: "https://web.push.apple.com/mac" });
    assert.equal(sent.sent, 1);
    assert.deepEqual(one.sent.map((item) => item.endpoint), ["https://web.push.apple.com/mac"]);
    const refused: PushSender = async () => {
      throw Object.assign(new Error("Received unexpected response code"), { statusCode: 403, body: '{"reason":"BadJwtToken"}' });
    };
    const result = await pushToUser(owner, { title: "Orbit", body: "Test", url: "/mail" }, { send: refused, endpoint: "https://web.push.apple.com/mac" });
    assert.equal(result.sent, 0);
    assert.deepEqual(result.failures, [{ status: 403, reason: "BadJwtToken" }]);
    await getAdminPool().query("delete from crm.push_subscriptions where endpoint = 'https://web.push.apple.com/mac'");
  });

  it("forgets a device the push service says is gone", async () => {
    const gone = pusher(410);
    await pushToUser(owner, { title: "x", body: "y", url: "/mail" }, { send: gone.send });
    const left = await getAdminPool().query("select count(*)::int as count from crm.push_subscriptions");
    assert.equal(left.rows[0].count, 0);
  });

  it("answers Outlook's webhook check and finds the owner of a subscription", async () => {
    const check = await webhook(new Request("https://orbit.test/api/microsoft/mail-webhook?validationToken=abc%20123", { method: "POST" }));
    assert.equal(await check.text(), "abc 123");
    const source = await getAdminPool().query<{ graph_subscription_id: string; graph_client_state: string }>(
      "select graph_subscription_id, graph_client_state from crm.mail_sources",
    );
    const { graph_subscription_id: id, graph_client_state: clientState } = source.rows[0];
    assert.equal(id, "sub-1");
    const found = await query<{ user_id: string }>("select * from private.mail_subscription_owner($1, $2)", [id, clientState]);
    assert.equal(found.rows[0]?.user_id, owner.userId);
    const wrong = await query("select * from private.mail_subscription_owner($1, $2)", [id, "nope"]);
    assert.equal(wrong.rows.length, 0);
  });
});
