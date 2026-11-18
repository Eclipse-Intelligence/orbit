import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { syncCalendar } from "@/lib/crm/calendar";
import { handleCalendarNotifications } from "@/lib/crm/calendar-notify";
import { disconnectMailbox, saveMailbox } from "@/lib/crm/inbox";
import { encryptSecret } from "@/lib/crypto/secret";
import { DEFAULT_STEPS } from "@/lib/crm/scheduler";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { applyMailAction } from "@/lib/mail/actions";
import { handleMailNotifications } from "@/lib/mail/notifications";
import { REFRESH_FLOOR_MS, SCHEDULED_FLOOR_MS, screenSyncOptions, syncMail, syncNotifiedMailboxes } from "@/lib/mail/sync";
import { readGraphNotices } from "@/lib/microsoft/notifications";
import { createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SITE = "https://orbit.test";

type Call = { method: string; url: string; token: string; body: Record<string, unknown> | null };

type Person = { actor: UserActor; token: string; source: string; inbox: unknown[]; parents: Record<string, string> };

const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", archive: "f-archive", outbox: "f-outbox" };

function message(id: string) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: `Hello ${id}`,
    bodyPreview: "Quick question",
    body: { contentType: "html", content: "<p>Quick question</p>" },
    from: { emailAddress: { name: `Sender ${id}`, address: `${id}@client.test` } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: new Date(Date.now() - 60_000).toISOString(),
    receivedDateTime: new Date(Date.now() - 30_000).toISOString(),
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Hooks = {
  inboxDelay?: number;
  beforeInbox?: (token: string) => Promise<Response | void> | Response | void;
  beforeDelta?: (folder: string, token: string) => Promise<void> | void;
  subscription?: (call: Call) => Response | undefined | Promise<Response | undefined>;
  calendarDelay?: number;
};

let created = 0;

function microsoft(people: () => Person[], hooks: Hooks = {}) {
  const calls: Call[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const call: Call = { method, url, token, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (url.startsWith(`${GRAPH}/subscriptions`)) {
      const custom = await hooks.subscription?.(call);
      if (custom) return custom;
      if (method === "POST") {
        created += 1;
        return Response.json({ id: `sub-${token}-${created}`, expirationDateTime: new Date(Date.now() + 3 * 86_400_000).toISOString() }, { status: 201 });
      }
      if (method === "PATCH") return Response.json({ expirationDateTime: new Date(Date.now() + 3 * 86_400_000).toISOString() });
      return new Response(null, { status: 204 });
    }
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: Object.entries(FOLDERS).map(([name, id]) => ({ id, displayName: name, childFolderCount: 0 })) });
    }
    const lookup = url.match(/\/me\/messages\/([^/?]+)\?\$select=id,parentFolderId$/);
    if (lookup) {
      const parent = people().find((item) => item.token === token)?.parents[decodeURIComponent(lookup[1])];
      if (parent === "ERROR") return Response.json({ error: { code: "ErrorInvalidRequest", message: "Bad request." } }, { status: 400 });
      return parent ? Response.json({ id: lookup[1], parentFolderId: parent }) : Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });
    }
    if (method === "PATCH" && /\/me\/messages\/[^/?]+\?\$select=id$/.test(url)) return Response.json({ id: "x" });
    if (url.includes("$select=id,inferenceClassification")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    if (folder) {
      await hooks.beforeDelta?.(folder, token);
      if (folder === "f-inbox") {
        const early = await hooks.beforeInbox?.(token);
        if (early) return early;
        if (hooks.inboxDelay) await wait(hooks.inboxDelay);
      }
      const person = people().find((item) => item.token === token);
      return Response.json({ value: folder === "f-inbox" ? (person?.inbox ?? []) : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${Date.now()}` });
    }
    if (new URL(url).pathname.endsWith("/me/calendars")) return Response.json({ value: [{ id: `cal-${token}`, name: "Calendar", isDefaultCalendar: true, canEdit: true }] });
    if (url.includes("/calendarView")) {
      if (hooks.calendarDelay) await wait(hooks.calendarDelay);
      return Response.json({ value: [] });
    }
    return Response.json({ value: [] });
  };
  const inboxDeltas = (token: string) => calls.filter((call) => call.token === token && call.url.includes("/mailFolders/f-inbox/messages/delta"));
  const deltaFolders = (token: string) =>
    [...new Set(calls.filter((call) => call.token === token && call.url.includes("/messages/delta")).map((call) => call.url.match(/mailFolders\/([^/]+)\//)?.[1]))].sort();
  const calendarViews = (token: string) => calls.filter((call) => call.token === token && call.url.includes("/calendarView"));
  const subscriptionCalls = (token: string, method: string) => calls.filter((call) => call.token === token && call.method === method && call.url.startsWith(`${GRAPH}/subscriptions`));
  return { fetchImpl, calls, inboxDeltas, deltaFolders, calendarViews, subscriptionCalls };
}

function notice(subscriptionId: string, clientState: string, lifecycleEvent?: string, messageId = "y", changeType = "updated") {
  return {
    subscriptionId,
    clientState,
    changeType: lifecycleEvent ? undefined : changeType,
    resource: `Users('x')/Messages('${messageId}')`,
    ...(lifecycleEvent ? { lifecycleEvent } : {}),
  };
}

function post(path: string, value: unknown[]) {
  return new Request(`${SITE}${path}`, { method: "POST", body: JSON.stringify({ value }), headers: { "content-type": "application/json" } });
}

async function mailSource(userId: string) {
  const rows = await getAdminPool().query<{
    id: string;
    graph_subscription_id: string | null;
    graph_client_state: string | null;
    graph_subscription_scope: string | null;
    resync_pending: boolean;
  }>("select id, graph_subscription_id, graph_client_state, graph_subscription_scope, resync_pending from crm.mail_sources where user_id = $1", [userId]);
  return rows.rows[0];
}

async function stored(providerId: string) {
  return (await getAdminPool().query("select 1 from crm.mail_messages where provider_message_id = $1", [providerId])).rowCount;
}

describe("Microsoft change notifications", () => {
  let alice: Person;
  let bruno: Person;
  const signals: LiveMessage[] = [];
  const people = () => [alice, bruno];

  before(async () => {
    process.env.SITE_URL = SITE;
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    await resetDatabase();
    const a = await createUser("alice@orbit.test", "Alice Archer");
    const b = await createUser("bruno@orbit.test", "Bruno Bell");
    await saveMailbox(a, { email: "alice@eclipse.test", refreshToken: "refresh", accessToken: "token-a", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await saveMailbox(b, { email: "bruno@eclipse.test", refreshToken: "refresh", accessToken: "token-b", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    alice = { actor: a, token: "token-a", source: "", inbox: [], parents: {} };
    bruno = { actor: b, token: "token-b", source: "", inbox: [], parents: {} };
    const box = microsoft(people);
    await syncMail(a, { budgetMs: 30_000, fetchImpl: box.fetchImpl });
    await syncMail(b, { budgetMs: 30_000, fetchImpl: box.fetchImpl });
    alice.source = (await mailSource(a.userId)).id;
    bruno.source = (await mailSource(b.userId)).id;
    setLiveTesting({ batch: async (messages) => void signals.push(...messages) });
  });

  beforeEach(async () => {
    signals.length = 0;
    alice.inbox = [];
    bruno.inbox = [];
    alice.parents = { y: "f-inbox" };
    bruno.parents = { y: "f-inbox" };
    await getAdminPool().query(
      "update crm.mail_sources set locked_until = null, resync_pending = false, resync_full = false, resync_lookups = '{}', retry_at = null, last_error = null, graph_subscription_retry_at = null, last_synced_at = now() - interval '1 hour', last_full_synced_at = now() - interval '1 hour'",
    );
    await getAdminPool().query("update crm.mail_folders set resync_pending = false");
    await getAdminPool().query("update crm.calendars set notify_locked_until = null, resync_pending = false");
  });

  after(async () => {
    setLiveTesting(null);
    delete process.env.SITE_URL;
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    await getPool().end();
  });

  useServerlessPool();

  async function runMail(requests: Request[], box: ReturnType<typeof microsoft>) {
    const tasks: (() => Promise<unknown>)[] = [];
    for (const request of requests) {
      const response = await handleMailNotifications(request, {
        fetchImpl: box.fetchImpl,
        pollMs: 50,
        schedule: (task) => tasks.push(task),
        afterSync: async () => undefined,
      });
      assert.equal(response.status, 202);
    }
    await Promise.all(tasks.map((task) => task()));
  }

  describe("mail", () => {
    it("replaces an Inbox-only subscription with one for the whole mailbox, once, and removes the old one", async () => {
      const admin = getAdminPool();
      await admin.query(
        "update crm.mail_sources set graph_subscription_id = 'old-inbox', graph_subscription_scope = null, graph_subscription_expires_at = now() + interval '2 days' where id = $1",
        [alice.source],
      );
      const box = microsoft(people);
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
      const created = box.subscriptionCalls("token-a", "POST");
      assert.equal(created.length, 1);
      assert.equal(created[0].body?.resource, "me/messages");
      assert.equal(created[0].body?.changeType, "created,updated,deleted");
      assert.equal(created[0].body?.notificationUrl, `${SITE}/api/microsoft/mail-webhook`);
      assert.equal(created[0].body?.lifecycleNotificationUrl, `${SITE}/api/microsoft/mail-webhook`);
      assert.deepEqual(box.subscriptionCalls("token-a", "DELETE").map((call) => call.url), [`${GRAPH}/subscriptions/old-inbox`]);
      const source = await mailSource(alice.actor.userId);
      assert.equal(source.graph_subscription_scope, "mailbox");
      assert.notEqual(source.graph_subscription_id, "old-inbox");

      const again = microsoft(people);
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: again.fetchImpl });
      assert.equal(again.subscriptionCalls("token-a", "POST").length, 0, "a current subscription is never made twice");
      assert.equal(again.subscriptionCalls("token-a", "PATCH").length, 0);
    });

    it("renews a subscription close to expiry, and makes a new one only when Microsoft has lost it", async () => {
      const admin = getAdminPool();
      const before = await mailSource(alice.actor.userId);
      await admin.query("update crm.mail_sources set graph_subscription_expires_at = now() + interval '2 hours' where id = $1", [alice.source]);
      const renew = microsoft(people);
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: renew.fetchImpl });
      assert.equal(renew.subscriptionCalls("token-a", "PATCH").length, 1);
      assert.equal(renew.subscriptionCalls("token-a", "POST").length, 0);
      assert.equal((await mailSource(alice.actor.userId)).graph_subscription_id, before.graph_subscription_id);

      await admin.query("update crm.mail_sources set graph_subscription_expires_at = now() + interval '2 hours' where id = $1", [alice.source]);
      const lost = microsoft(people, { subscription: (call) => (call.method === "PATCH" ? Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 }) : undefined) });
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: lost.fetchImpl });
      assert.equal(lost.subscriptionCalls("token-a", "POST").length, 1);
      assert.equal(lost.subscriptionCalls("token-a", "DELETE").length, 0, "nothing to remove when Microsoft already lost it");
      assert.notEqual((await mailSource(alice.actor.userId)).graph_subscription_id, before.graph_subscription_id);
    });

    it("never keeps a second subscription when another sync stored one first", async () => {
      const admin = getAdminPool();
      await admin.query("update crm.mail_sources set graph_subscription_id = null, graph_subscription_scope = null where id = $1", [alice.source]);
      const box = microsoft(people, {
        subscription: async (call) => {
          if (call.method !== "POST") return undefined;
          await admin.query(
            "update crm.mail_sources set graph_subscription_id = 'raced', graph_subscription_scope = 'mailbox', graph_subscription_expires_at = now() + interval '2 days' where id = $1",
            [alice.source],
          );
          return undefined;
        },
      });
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
      assert.equal(box.subscriptionCalls("token-a", "POST").length, 1);
      const deleted = box.subscriptionCalls("token-a", "DELETE").map((call) => call.url);
      assert.equal(deleted.length, 1, "the spare one is removed");
      assert.match(deleted[0], /\/subscriptions\/sub-token-a-\d+$/);
      assert.equal((await mailSource(alice.actor.userId)).graph_subscription_id, "raced");
    });

    it("syncs and signals only the person whose subscription and client state match", async () => {
      const a = await mailSource(alice.actor.userId);
      const b = await mailSource(bruno.actor.userId);
      alice.inbox = [message("alice-new")];
      bruno.inbox = [message("bruno-new")];
      const box = microsoft(people);
      await runMail(
        [
          post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!)]),
          post("/api/microsoft/mail-webhook", [notice(b.graph_subscription_id!, a.graph_client_state!)]),
          post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, "guess")]),
        ],
        box,
      );
      assert.equal(box.inboxDeltas("token-a").length, 1);
      assert.equal(box.inboxDeltas("token-b").length, 0, "another person's subscription with the wrong client state syncs nothing");
      assert.equal(await stored("alice-new"), 1);
      assert.equal(await stored("bruno-new"), 0);
      const topics = new Set(signals.filter((item) => item.event === "synced").map((item) => item.topic));
      assert.deepEqual([...topics], [personTopic(alice.actor.userId)]);
      assert.deepEqual(
        signals.map((item) => item.payload),
        signals.map(() => ({ kind: "mail" })),
        "the signal names nothing but its kind",
      );
    });

    it("sends no signal when a sync changed nothing", async () => {
      const a = await mailSource(alice.actor.userId);
      const box = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!)])], box);
      assert.equal(box.inboxDeltas("token-a").length, 1);
      assert.equal(signals.length, 0);
    });

    it("turns a burst of notifications into at most two syncs", async () => {
      const a = await mailSource(alice.actor.userId);
      alice.inbox = [message("burst-1")];
      const box = microsoft(people, { inboxDelay: 400 });
      const requests = Array.from({ length: 10 }, () => post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!)]));
      await runMail(requests, box);
      const syncs = box.inboxDeltas("token-a").length;
      assert.ok(syncs >= 1 && syncs <= 2, `expected one or two syncs, got ${syncs}`);
      assert.equal(await stored("burst-1"), 1);
      assert.equal((await mailSource(alice.actor.userId)).resync_pending, false);
    });

    it("never loses a notification that arrives while the mailbox is syncing", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const box = microsoft(people, {
        beforeInbox: async (token) => {
          if (token !== "token-a" || !first) return;
          first = false;
          await gate;
        },
      });
      const running = syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
      while (box.inboxDeltas("token-a").length === 0) await wait(10);
      const notified = syncNotifiedMailboxes(alice.actor, [alice.source], { deadline: Date.now() + 30_000, fetchImpl: box.fetchImpl, pollMs: 50 });
      while (!(await mailSource(alice.actor.userId)).resync_pending) await wait(10);
      alice.inbox = [message("late-1")];
      release();
      await running;
      const outcome = await notified;
      assert.equal(await stored("late-1"), 1, "the change made during the first pass is picked up");
      assert.equal(box.inboxDeltas("token-a").length, 2, "one more pass, not a fresh sync per notification");
      assert.deepEqual(outcome.unreached, []);
    });

    it("picks up a change when the sync holding the mailbox ends without looking again", async () => {
      const admin = getAdminPool();
      await admin.query("update crm.mail_sources set locked_until = now() + interval '5 minutes' where id = $1", [alice.source]);
      alice.inbox = [message("after-holder")];
      const box = microsoft(people);
      const notified = syncNotifiedMailboxes(alice.actor, [alice.source], { deadline: Date.now() + 30_000, fetchImpl: box.fetchImpl, pollMs: 50 });
      await wait(200);
      assert.equal(box.inboxDeltas("token-a").length, 0, "no call while another sync holds the mailbox");
      await admin.query("update crm.mail_sources set locked_until = null where id = $1", [alice.source]);
      await notified;
      assert.equal(await stored("after-holder"), 1);
    });

    it("skips a mailbox synced in the last minute unless a notification asked for it", async () => {
      const admin = getAdminPool();
      await admin.query("update crm.mail_sources set last_full_synced_at = now() - interval '30 seconds' where id = $1", [alice.source]);
      const skipped = microsoft(people);
      const report = await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: skipped.fetchImpl, skipRecentMs: SCHEDULED_FLOOR_MS });
      assert.deepEqual(report.recent, [alice.source]);
      assert.equal(skipped.calls.length, 0);

      await admin.query("update crm.mail_sources set last_full_synced_at = now() - interval '61 seconds' where id = $1", [alice.source]);
      const due = microsoft(people);
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: due.fetchImpl, skipRecentMs: SCHEDULED_FLOOR_MS });
      assert.equal(due.inboxDeltas("token-a").length, 1);

      await admin.query("update crm.mail_sources set last_full_synced_at = now() - interval '5 seconds', resync_pending = true where id = $1", [alice.source]);
      const pending = microsoft(people);
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: pending.fetchImpl, skipRecentMs: SCHEDULED_FLOOR_MS });
      assert.equal(pending.inboxDeltas("token-a").length, 1, "a change still waiting is never skipped");

      await admin.query("update crm.mail_sources set last_full_synced_at = now() - interval '5 seconds' where id = $1", [alice.source]);
      const notified = microsoft(people);
      await syncNotifiedMailboxes(alice.actor, [alice.source], { deadline: Date.now() + 30_000, fetchImpl: notified.fetchImpl });
      assert.equal(notified.inboxDeltas("token-a").length, 1, "a notification sync ignores the floor");
    });

    it("lets Refresh sync only a mailbox last synced more than two minutes ago", async () => {
      const admin = getAdminPool();
      const options = screenSyncOptions({ manual: true });
      assert.equal(options.skipRecentMs, REFRESH_FLOOR_MS);
      assert.equal(options.ignoreFolderWaits, true);
      await admin.query("update crm.mail_sources set last_full_synced_at = now() - interval '90 seconds' where id = $1", [alice.source]);
      const recent = microsoft(people);
      await syncMail(alice.actor, { ...options, fetchImpl: recent.fetchImpl });
      assert.equal(recent.calls.length, 0);
      await admin.query("update crm.mail_sources set last_full_synced_at = now() - interval '150 seconds' where id = $1", [alice.source]);
      const stale = microsoft(people);
      await syncMail(alice.actor, { ...options, fetchImpl: stale.fetchImpl });
      assert.equal(stale.inboxDeltas("token-a").length, 1);
    });

    it("syncs straight away on a missed lifecycle event, and remakes a removed subscription", async () => {
      const a = await mailSource(alice.actor.userId);
      alice.inbox = [message("missed-1")];
      const missed = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, "missed")])], missed);
      assert.equal(missed.inboxDeltas("token-a").length, 1);
      assert.equal(await stored("missed-1"), 1);

      const removed = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, "subscriptionRemoved")])], removed);
      assert.equal(removed.subscriptionCalls("token-a", "POST").length, 1);
      assert.equal(removed.subscriptionCalls("token-a", "DELETE").length, 0);
      const after = await mailSource(alice.actor.userId);
      assert.notEqual(after.graph_subscription_id, a.graph_subscription_id);

      const renew = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(after.graph_subscription_id!, after.graph_client_state!, "reauthorizationRequired")])], renew);
      assert.equal(renew.subscriptionCalls("token-a", "PATCH").length, 1);
      assert.equal(renew.subscriptionCalls("token-a", "POST").length, 0);
    });

    it("answers Microsoft's validation, folds a large batch into one notice per subscription and drops malformed ones", async () => {
      const check = await handleMailNotifications(new Request(`${SITE}/api/microsoft/mail-webhook?validationToken=abc%20123`, { method: "POST" }));
      assert.equal(await check.text(), "abc 123");
      assert.deepEqual(readGraphNotices({ value: Array.from({ length: 300 }, () => notice("x", "y")) }), [
        { subscriptionId: "x", clientState: "y", lifecycleEvent: null, changeType: "updated", messageId: "y" },
      ]);
      const many = readGraphNotices({ value: Array.from({ length: 300 }, (_, index) => notice("x", "y", undefined, `m-${index}`)) });
      assert.deepEqual(many, [{ subscriptionId: "x", clientState: "y", lifecycleEvent: null, changeType: null, messageId: null }], "too many messages fall back to a full walk");
      assert.deepEqual(readGraphNotices({ value: [notice("x", "y", "somethingElse"), { subscriptionId: "x" }] }), []);
      const malformed = await handleMailNotifications(new Request(`${SITE}/api/microsoft/mail-webhook`, { method: "POST", body: "not json" }));
      assert.equal(malformed.status, 400);
    });

    it("skips the echo of Orbit's own change without calling Microsoft", async () => {
      alice.inbox = [message("echo-1")];
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: microsoft(people).fetchImpl });
      alice.inbox = [];
      const acting = microsoft(people);
      await applyMailAction(alice.actor, { thread: `${alice.source}|conv-echo-1`, action: "read" }, acting.fetchImpl);
      assert.equal(acting.calls.filter((call) => call.method === "PATCH").length, 1);
      const a = await mailSource(alice.actor.userId);
      const box = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "echo-1")])], box);
      assert.equal(box.calls.length, 0, "an echo costs no Microsoft call");
      assert.equal((await mailSource(alice.actor.userId)).resync_pending, false);
    });

    it("syncs a change made in Outlook to the same message once the echo window has passed, and only its folder", async () => {
      await getAdminPool().query("update crm.mail_echoes set changed_at = now() - interval '3 minutes' where provider_message_id = 'echo-1'");
      const a = await mailSource(alice.actor.userId);
      const box = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "echo-1")])], box);
      assert.deepEqual(box.deltaFolders("token-a"), ["f-inbox"]);
      assert.equal(box.calls.filter((call) => call.url.includes("parentFolderId")).length, 0, "a known message needs no lookup");
    });

    it("syncs only the folders a burst involves: where Orbit has each message, and where a new one landed", async () => {
      alice.inbox = [message("known-1")];
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: microsoft(people).fetchImpl });
      alice.parents = { "new-sent": "f-sent" };
      const a = await mailSource(alice.actor.userId);
      const box = microsoft(people);
      await runMail(
        [
          post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "known-1")]),
          post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "new-sent", "created")]),
          post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "gone-1", "deleted")]),
        ],
        box,
      );
      assert.deepEqual(box.deltaFolders("token-a"), ["f-inbox", "f-sent"]);
      assert.equal(box.calls.filter((call) => call.url.includes("/me/messages/new-sent?")).length, 1, "one lookup for the new message");
      const pending = await getAdminPool().query("select 1 from crm.mail_folders where resync_pending");
      assert.equal(pending.rowCount, 0);
    });

    it("walks every folder only when looking up an unknown message fails", async () => {
      alice.parents = { mystery: "ERROR" };
      const a = await mailSource(alice.actor.userId);
      const box = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "mystery", "created")])], box);
      assert.deepEqual(box.deltaFolders("token-a"), ["f-archive", "f-inbox", "f-sent"]);
    });

    it("walks nothing for a message Microsoft no longer has, or one in a folder Orbit skips", async () => {
      alice.parents = { outgoing: "f-outbox" };
      const a = await mailSource(alice.actor.userId);
      const box = microsoft(people);
      await runMail(
        [
          post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "vanished", "created")]),
          post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "outgoing", "created")]),
        ],
        box,
      );
      assert.deepEqual(box.deltaFolders("token-a"), []);
      assert.equal(box.calls.filter((call) => call.url.includes("parentFolderId")).length, 2);
    });

    it("keeps the scheduled and Refresh syncs walking every folder after a targeted sync", async () => {
      const admin = getAdminPool();
      await admin.query("update crm.mail_sources set last_full_synced_at = now() - interval '5 minutes' where id = $1", [alice.source]);
      const a = await mailSource(alice.actor.userId);
      const targeted = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!)])], targeted);
      assert.deepEqual(targeted.deltaFolders("token-a"), ["f-inbox"]);
      const scheduled = microsoft(people);
      const report = await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: scheduled.fetchImpl, skipRecentMs: SCHEDULED_FLOOR_MS });
      assert.deepEqual(report.recent, [], "a targeted sync doesn't count as a full one");
      assert.deepEqual(scheduled.deltaFolders("token-a"), ["f-archive", "f-inbox", "f-sent"]);
      const refresh = microsoft(people);
      await syncMail(alice.actor, { ...screenSyncOptions({ manual: true }), fetchImpl: refresh.fetchImpl });
      assert.equal(refresh.calls.length, 0, "the full walk just now does count");
    });

    it("walks every folder after a targeted run that failed", async () => {
      const a = await mailSource(alice.actor.userId);
      const failing = microsoft(people, {
        beforeInbox: () => {
          return Response.json({ error: { code: "InvalidAuthenticationToken", message: "Expired." } }, { status: 401 });
        },
      });
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!)])], failing);
      const failed = await getAdminPool().query<{ resync_full: boolean }>("select resync_full from crm.mail_sources where id = $1", [alice.source]);
      assert.equal(failed.rows[0].resync_full, true);
      const next = microsoft(people);
      await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!)])], next);
      assert.deepEqual(next.deltaFolders("token-a"), ["f-archive", "f-inbox", "f-sent"]);
    });

    it("records every person's notifications before syncing anyone, so a slow first mailbox drops nobody's", async () => {
      const a = await mailSource(alice.actor.userId);
      const b = await mailSource(bruno.actor.userId);
      const box = microsoft(people, { inboxDelay: 3_500 });
      const tasks: (() => Promise<unknown>)[] = [];
      await handleMailNotifications(
        post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!), notice(b.graph_subscription_id!, b.graph_client_state!)]),
        { fetchImpl: box.fetchImpl, pollMs: 50, deadline: Date.now() + 4_000, schedule: (task) => tasks.push(task), afterSync: async () => undefined },
      );
      await Promise.all(tasks.map((task) => task()));
      assert.equal(box.inboxDeltas("token-b").length, 0, "the budget ran out before Bruno's mailbox");
      const waiting = await getAdminPool().query<{ resync_pending: boolean; resync_lookups: string[] }>(
        "select resync_pending, resync_lookups from crm.mail_sources where id = $1",
        [b.id],
      );
      assert.deepEqual(waiting.rows[0], { resync_pending: true, resync_lookups: ["y"] }, "his change waits for the next sync");
    });

    it("finds a new folder by refreshing the folder list once, then syncs only that folder", async () => {
      FOLDERS.projects = "f-projects";
      alice.parents = { filed: "f-projects" };
      try {
        const a = await mailSource(alice.actor.userId);
        const box = microsoft(people);
        await runMail([post("/api/microsoft/mail-webhook", [notice(a.graph_subscription_id!, a.graph_client_state!, undefined, "filed", "created")])], box);
        assert.equal(box.calls.filter((call) => call.url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)).length, 1);
        assert.deepEqual(box.deltaFolders("token-a"), ["f-projects"]);
      } finally {
        delete FOLDERS.projects;
      }
    });

    it("tells other tabs and devices after a Refresh or one of Orbit's own actions", async () => {
      assert.equal(screenSyncOptions({ manual: true }).announce, true);
      alice.inbox = [message("refresh-new")];
      await syncMail(alice.actor, { ...screenSyncOptions({ manual: true }), fetchImpl: microsoft(people).fetchImpl });
      assert.ok(signals.some((item) => item.topic === personTopic(alice.actor.userId) && item.event === "synced"));
      signals.length = 0;
      await applyMailAction(alice.actor, { thread: `${alice.source}|conv-refresh-new`, action: "flag" }, microsoft(people).fetchImpl);
      for (let tries = 0; tries < 50 && signals.length === 0; tries += 1) await wait(20);
      assert.deepEqual(
        signals.map((item) => [item.topic, item.event, item.payload]),
        [[personTopic(alice.actor.userId), "synced", { kind: "mail" }]],
      );
    });

    it("keeps the old Inbox subscription and records why when Microsoft refuses one for the whole mailbox", async () => {
      const admin = getAdminPool();
      await admin.query(
        "update crm.mail_sources set graph_subscription_id = 'legacy-inbox', graph_subscription_scope = null, graph_subscription_expires_at = now() + interval '2 hours', graph_subscription_error = null where id = $1",
        [alice.source],
      );
      const refused = microsoft(people, {
        subscription: (call) => (call.method === "POST" ? Response.json({ error: { code: "ExtensionError", message: "Operation not supported." } }, { status: 403 }) : undefined),
      });
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: refused.fetchImpl });
      assert.equal(refused.subscriptionCalls("token-a", "POST").length, 1);
      assert.deepEqual(refused.subscriptionCalls("token-a", "PATCH").map((call) => call.url), [`${GRAPH}/subscriptions/legacy-inbox`]);
      const row = await admin.query<{ graph_subscription_id: string; graph_subscription_error: string | null }>(
        "select graph_subscription_id, graph_subscription_error from crm.mail_sources where id = $1",
        [alice.source],
      );
      assert.equal(row.rows[0].graph_subscription_id, "legacy-inbox");
      assert.match(row.rows[0].graph_subscription_error ?? "", /refused/);
      const later = microsoft(people);
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: later.fetchImpl });
      assert.equal(later.subscriptionCalls("token-a", "POST").length, 0, "it waits before asking again");
      await admin.query("update crm.mail_sources set graph_subscription_retry_at = null where id = $1", [alice.source]);
      const retry = microsoft(people);
      await syncMail(alice.actor, { budgetMs: 30_000, backfill: false, fetchImpl: retry.fetchImpl });
      assert.equal(retry.subscriptionCalls("token-a", "POST").length, 1);
      assert.equal((await mailSource(alice.actor.userId)).graph_subscription_scope, "mailbox");
    });

    it("stops backfilling to look again when a change arrives during a backfill", async () => {
      const admin = getAdminPool();
      await admin.query("update crm.mail_folders set sync_state = 'pending', sync_link = null where source_id = $1 and provider_folder_id in ('f-archive', 'f-sent')", [alice.source]);
      try {
        let noted = false;
        const box = microsoft(people, {
          beforeDelta: async (folder, token) => {
            if (token !== "token-a" || noted || !["f-archive", "f-sent"].includes(folder)) return;
            noted = true;
            await admin.query("update crm.mail_sources set resync_pending = true where id = $1", [alice.source]);
          },
        });
        await syncMail(alice.actor, { budgetMs: 30_000, fetchImpl: box.fetchImpl });
        const backfilled = box.calls.filter((call) => call.token === "token-a" && call.url.includes("/f-archive/messages/delta")).length;
        assert.equal(backfilled, 0, "the next backfill folder waits");
        assert.equal(box.inboxDeltas("token-a").length, 2, "one more pass picks up the change");
      } finally {
        await admin.query(
          "update crm.mail_folders set sync_state = 'live', sync_link = $2 || provider_folder_id || '/messages/delta?$deltatoken=x' where source_id = $1 and provider_folder_id in ('f-archive', 'f-sent')",
          [alice.source, `${GRAPH}/me/mailFolders/`],
        );
      }
    });

    it("keeps each person's echoes and the subscription lookups to themselves", async () => {
      const admin = getAdminPool();
      await admin.query("insert into crm.mail_echoes (source_id, user_id, provider_message_id) values ($1, $2, 'private-echo') on conflict do nothing", [
        alice.source,
        alice.actor.userId,
      ]);
      await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [
        alice.actor.workspaceId,
        bruno.actor.userId,
      ]);
      try {
        assert.deepEqual(await queryAsUser(bruno.actor.userId, "select provider_message_id from crm.mail_echoes where source_id = $1", [alice.source]), []);
        await assert.rejects(
          queryAsUser(bruno.actor.userId, "insert into crm.mail_echoes (source_id, user_id, provider_message_id) values ($1, $2, 'forged')", [alice.source, bruno.actor.userId]),
        );
        await assert.rejects(
          queryAsUser(bruno.actor.userId, "insert into crm.mail_echoes (source_id, user_id, provider_message_id) values ($1, $2, 'forged')", [alice.source, alice.actor.userId]),
        );
        assert.deepEqual(
          await queryAsUser(bruno.actor.userId, "update crm.mail_echoes set changed_at = now() where source_id = $1 returning provider_message_id", [alice.source]),
          [],
        );
        await assert.rejects(queryAsUser(alice.actor.userId, "select * from private.mail_subscription_sources(array['x'])"));
        await assert.rejects(queryAsUser(alice.actor.userId, "select * from private.calendar_subscription_owners(array['x'])"));
      } finally {
        await admin.query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [alice.actor.workspaceId, bruno.actor.userId]);
      }
    });

    it("no longer syncs mail from the ten-minute job", () => {
      assert.equal(DEFAULT_STEPS.some((step) => step.name === "mail_store"), false);
    });
  });

  describe("calendar", () => {
    async function calendarRow(userId: string) {
      const rows = await getAdminPool().query<{ id: string; graph_subscription_id: string | null }>(
        "select id, graph_subscription_id from crm.calendars where user_id = $1",
        [userId],
      );
      return rows.rows[0];
    }

    async function runCalendar(requests: Request[], box: ReturnType<typeof microsoft>) {
      const tasks: (() => Promise<unknown>)[] = [];
      for (const request of requests) {
        const response = await handleCalendarNotifications(request, { fetchImpl: box.fetchImpl, pollMs: 50, schedule: (task) => tasks.push(task) });
        assert.equal(response.status, 202);
      }
      await Promise.all(tasks.map((task) => task()));
    }

    let states: Record<string, string> = {};

    before(async () => {
      const box = microsoft(people);
      await syncCalendar(alice.actor, { force: true, fetchImpl: box.fetchImpl });
      await syncCalendar(bruno.actor, { force: true, fetchImpl: box.fetchImpl });
      states = {};
      for (const person of [alice, bruno]) {
        const row = await calendarRow(person.actor.userId);
        const created = box.subscriptionCalls(person.token, "POST").find((call) => call.body?.resource === `me/calendars/cal-${person.token}/events`);
        assert.ok(row.graph_subscription_id, "every synced calendar is subscribed");
        assert.equal(created?.body?.changeType, "created,updated,deleted");
        assert.equal(created?.body?.notificationUrl, `${SITE}/api/microsoft/calendar-webhook`);
        assert.equal(created?.body?.lifecycleNotificationUrl, `${SITE}/api/microsoft/calendar-webhook`);
        states[row.graph_subscription_id!] = created?.body?.clientState as string;
      }
    });

    it("keeps one subscription per calendar across syncs", async () => {
      const box = microsoft(people);
      await syncCalendar(alice.actor, { force: true, fetchImpl: box.fetchImpl });
      assert.equal(box.subscriptionCalls("token-a", "POST").length, 0);
      const count = await getAdminPool().query<{ count: number }>("select count(*)::int as count from crm.calendars where graph_subscription_id is not null");
      assert.equal(count.rows[0].count, 2);
    });

    it("syncs and signals only the calendar's owner", async () => {
      const a = await calendarRow(alice.actor.userId);
      const b = await calendarRow(bruno.actor.userId);
      const box = microsoft(people);
      await runCalendar(
        [
          post("/api/microsoft/calendar-webhook", [notice(a.graph_subscription_id!, states[a.graph_subscription_id!])]),
          post("/api/microsoft/calendar-webhook", [notice(b.graph_subscription_id!, states[a.graph_subscription_id!])]),
          post("/api/microsoft/calendar-webhook", [notice(a.graph_subscription_id!, "guess")]),
        ],
        box,
      );
      assert.equal(box.calendarViews("token-a").length, 1);
      assert.equal(box.calendarViews("token-b").length, 0);
      assert.deepEqual(
        signals.map((item) => [item.topic, item.event, item.payload]),
        [[personTopic(alice.actor.userId), "synced", { kind: "calendar" }]],
      );
    });

    it("turns a burst of calendar notifications into at most two syncs", async () => {
      const a = await calendarRow(alice.actor.userId);
      const box = microsoft(people, { calendarDelay: 400 });
      const requests = Array.from({ length: 8 }, () => post("/api/microsoft/calendar-webhook", [notice(a.graph_subscription_id!, states[a.graph_subscription_id!])]));
      await runCalendar(requests, box);
      const syncs = box.calendarViews("token-a").length;
      assert.ok(syncs >= 1 && syncs <= 2, `expected one or two syncs, got ${syncs}`);
    });

    it("syncs on a missed lifecycle event and remakes a removed subscription", async () => {
      const a = await calendarRow(alice.actor.userId);
      const missed = microsoft(people);
      await runCalendar([post("/api/microsoft/calendar-webhook", [notice(a.graph_subscription_id!, states[a.graph_subscription_id!], "missed")])], missed);
      assert.equal(missed.calendarViews("token-a").length, 1);

      const removed = microsoft(people);
      await runCalendar([post("/api/microsoft/calendar-webhook", [notice(a.graph_subscription_id!, states[a.graph_subscription_id!], "subscriptionRemoved")])], removed);
      const created = removed.subscriptionCalls("token-a", "POST");
      assert.equal(created.length, 1);
      const after = await calendarRow(alice.actor.userId);
      assert.ok(after.graph_subscription_id && after.graph_subscription_id !== a.graph_subscription_id);
      states[after.graph_subscription_id!] = created[0].body?.clientState as string;

      const renew = microsoft(people);
      await runCalendar([post("/api/microsoft/calendar-webhook", [notice(after.graph_subscription_id!, states[after.graph_subscription_id!], "reauthorizationRequired")])], renew);
      assert.equal(renew.subscriptionCalls("token-a", "PATCH").length, 1);
      assert.equal(renew.subscriptionCalls("token-a", "POST").length, 0);
    });

    it("removes the subscription of a calendar Orbit stops syncing", async () => {
      const a = await calendarRow(alice.actor.userId);
      await getAdminPool().query("update crm.calendars set is_visible = false, use_for_crm = false where id = $1", [a.id]);
      const box = microsoft(people);
      await syncCalendar(alice.actor, { force: true, fetchImpl: box.fetchImpl });
      assert.deepEqual(box.subscriptionCalls("token-a", "DELETE").map((call) => call.url), [`${GRAPH}/subscriptions/${a.graph_subscription_id}`]);
      assert.equal((await calendarRow(alice.actor.userId)).graph_subscription_id, null);
      await getAdminPool().query("update crm.calendars set is_visible = true where id = $1", [a.id]);
    });

    it("waits six hours before trying again when Microsoft refuses a calendar subscription", async () => {
      const a = await calendarRow(alice.actor.userId);
      await getAdminPool().query("update crm.calendars set graph_subscription_id = null, graph_subscription_retry_at = null where id = $1", [a.id]);
      const refused = microsoft(people, {
        subscription: (call) => (call.method === "POST" ? Response.json({ error: { code: "ExtensionError", message: "Not supported." } }, { status: 400 }) : undefined),
      });
      const result = await syncCalendar(alice.actor, { force: true, fetchImpl: refused.fetchImpl });
      assert.equal(result.error, undefined, "a refused subscription never fails the calendar sync");
      assert.equal(refused.subscriptionCalls("token-a", "POST").length, 1);
      const again = microsoft(people);
      await syncCalendar(alice.actor, { force: true, fetchImpl: again.fetchImpl });
      assert.equal(again.subscriptionCalls("token-a", "POST").length, 0);
    });

    it("tries again on the next run when making a calendar subscription fails for a passing reason", async () => {
      const a = await calendarRow(alice.actor.userId);
      for (const failure of [
        () => Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 }),
        () => Response.json({ error: { code: "TooManyRequests" } }, { status: 429 }),
        () => Response.json({ error: { code: "ValidationError", message: "Subscription validation request timed out." } }, { status: 400 }),
      ]) {
        await getAdminPool().query("update crm.calendars set graph_subscription_id = null, graph_subscription_retry_at = null where id = $1", [a.id]);
        const failing = microsoft(people, { subscription: (call) => (call.method === "POST" ? failure() : undefined) });
        await syncCalendar(alice.actor, { force: true, fetchImpl: failing.fetchImpl });
        const row = await getAdminPool().query<{ retry: Date | null }>("select graph_subscription_retry_at as retry from crm.calendars where id = $1", [a.id]);
        assert.equal(row.rows[0].retry, null);
      }
      const next = microsoft(people);
      await syncCalendar(alice.actor, { force: true, fetchImpl: next.fetchImpl });
      assert.equal(next.subscriptionCalls("token-a", "POST").length, 1);
    });

    it("remakes a calendar subscription Microsoft has expired", async () => {
      const a = await calendarRow(alice.actor.userId);
      await getAdminPool().query("update crm.calendars set graph_subscription_expires_at = now() + interval '1 hour' where id = $1", [a.id]);
      const expired = microsoft(people, {
        subscription: (call) => (call.method === "PATCH" ? Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 }) : undefined),
      });
      await syncCalendar(alice.actor, { force: true, fetchImpl: expired.fetchImpl });
      assert.equal(expired.subscriptionCalls("token-a", "POST").length, 1);
      const after = await calendarRow(alice.actor.userId);
      assert.ok(after.graph_subscription_id && after.graph_subscription_id !== a.graph_subscription_id);
    });

    it("keeps one calendar subscription when two syncs make one at once, and deletes the spare", async () => {
      const a = await calendarRow(alice.actor.userId);
      await getAdminPool().query("update crm.calendars set graph_subscription_id = null, graph_subscription_retry_at = null where id = $1", [a.id]);
      const box = microsoft(people, {
        subscription: async (call) => {
          if (call.method === "POST") await wait(200);
          return undefined;
        },
      });
      await Promise.all([
        syncCalendar(alice.actor, { force: true, fetchImpl: box.fetchImpl }),
        syncCalendar(alice.actor, { force: true, fetchImpl: box.fetchImpl }),
      ]);
      const made = box.subscriptionCalls("token-a", "POST").length;
      assert.equal(made, 2, "both syncs asked Microsoft");
      assert.equal(box.subscriptionCalls("token-a", "DELETE").length, 1, "the spare is deleted");
      assert.ok((await calendarRow(alice.actor.userId)).graph_subscription_id);
    });

    it("never stamps the connection or clears its error when a notification syncs one calendar", async () => {
      const a = await calendarRow(alice.actor.userId);
      await getAdminPool().query(
        "update crm.calendars set graph_subscription_id = 'cal-pinned', graph_client_state = $2, graph_subscription_expires_at = now() + interval '2 days' where id = $1",
        [a.id, encryptSecret("pinned-state")],
      );
      await getAdminPool().query(
        "update crm.integration_state set last_attempt_at = now() - interval '1 hour', last_error = 'Kept error' where user_id = $1 and source = 'calendar'",
        [alice.actor.userId],
      );
      const box = microsoft(people);
      await runCalendar([post("/api/microsoft/calendar-webhook", [notice("cal-pinned", "pinned-state")])], box);
      assert.equal(box.calendarViews("token-a").length, 1);
      const state = await getAdminPool().query<{ stale: boolean; last_error: string | null }>(
        "select last_attempt_at < now() - interval '30 minutes' as stale, last_error from crm.integration_state where user_id = $1 and source = 'calendar'",
        [alice.actor.userId],
      );
      assert.deepEqual(state.rows[0], { stale: true, last_error: "Kept error" });
      const scheduled = microsoft(people);
      await syncCalendar(alice.actor, { fetchImpl: scheduled.fetchImpl });
      assert.equal(scheduled.calendarViews("token-a").length, 1, "the scheduled sync still runs for the connection");
    });

    it("removes the subscription of a calendar that disappeared from Outlook before forgetting it", async () => {
      await getAdminPool().query(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, graph_subscription_id, graph_client_state, graph_subscription_expires_at)
         select workspace_id, user_id, connection_id, 'cal-gone', 'Gone', color, 'sub-gone', 'x', now() + interval '2 days' from crm.calendars where user_id = $1 limit 1`,
        [alice.actor.userId],
      );
      const failing = microsoft(people, {
        subscription: (call) => (call.method === "DELETE" ? Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 }) : undefined),
      });
      await syncCalendar(alice.actor, { force: true, fetchImpl: failing.fetchImpl });
      assert.equal(failing.calendarViews("token-a").filter((call) => call.url.includes("cal-gone")).length, 0, "a gone calendar isn't read");
      const kept = await getAdminPool().query("select 1 from crm.calendars where provider_calendar_id = 'cal-gone'");
      assert.equal(kept.rowCount, 1, "kept until its subscription is removed");
      const box = microsoft(people);
      await syncCalendar(alice.actor, { force: true, fetchImpl: box.fetchImpl });
      assert.ok(box.subscriptionCalls("token-a", "DELETE").some((call) => call.url.endsWith("/subscriptions/sub-gone")));
      const gone = await getAdminPool().query("select 1 from crm.calendars where provider_calendar_id = 'cal-gone'");
      assert.equal(gone.rowCount, 0);
    });

    it("keeps calendar subscription details from colleagues", async () => {
      const admin = getAdminPool();
      const a = await calendarRow(alice.actor.userId);
      await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [
        alice.actor.workspaceId,
        bruno.actor.userId,
      ]);
      try {
        assert.deepEqual(await queryAsUser(bruno.actor.userId, "select graph_client_state, graph_subscription_id from crm.calendars where id = $1", [a.id]), []);
        assert.deepEqual(
          await queryAsUser(bruno.actor.userId, "update crm.calendars set graph_subscription_id = 'stolen', graph_client_state = 'x' where id = $1 returning id", [a.id]),
          [],
        );
      } finally {
        await admin.query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [alice.actor.workspaceId, bruno.actor.userId]);
      }
    });

    it("removes the mailbox's and calendars' subscriptions at Microsoft when the mailbox is disconnected", async () => {
      const mail = await mailSource(bruno.actor.userId);
      const calendar = await calendarRow(bruno.actor.userId);
      const box = microsoft(people);
      await disconnectMailbox(bruno.actor, box.fetchImpl);
      const deleted = box.subscriptionCalls("token-b", "DELETE").map((call) => call.url).sort();
      assert.deepEqual(deleted, [`${GRAPH}/subscriptions/${calendar.graph_subscription_id}`, `${GRAPH}/subscriptions/${mail.graph_subscription_id}`].sort());
      const left = await getAdminPool().query(
        "select 1 from crm.calendars where user_id = $1 and graph_subscription_id is not null union all select 1 from crm.mail_sources where user_id = $1 and graph_subscription_id is not null",
        [bruno.actor.userId],
      );
      assert.equal(left.rowCount, 0);
    });
  });
});
