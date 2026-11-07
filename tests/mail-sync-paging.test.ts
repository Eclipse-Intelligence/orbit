import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { retryWaitMs } from "@/lib/mail/microsoft";
import { syncMail } from "@/lib/mail/sync";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FOLDERS: Record<string, string> = { inbox: "f-inbox", archive: "f-archive", sentitems: "f-sent" };

type Page = { value: unknown[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

function message(id: string, overrides: Record<string, unknown> = {}) {
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
    webLink: `https://outlook.office.com/mail/${id}`,
    ...overrides,
  };
}

function delta(folder: string, token: string) {
  return `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;
}

function skip(folder: string, token: string) {
  return `${GRAPH}/me/mailFolders/${folder}/messages/delta?$skiptoken=${token}`;
}

type Hooks = { throttled?: Set<string>; onLookup?: () => void };

function outlook(pages: Record<string, Page | (() => Response | Promise<Response>)>, locations = new Map<string, string>(), hooks: Hooks = {}) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: [
          { id: "f-inbox", displayName: "Inbox", childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0 },
          { id: "f-archive", displayName: "Archive", childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0 },
          { id: "f-sent", displayName: "Sent Items", childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0 },
        ],
      });
    }
    const move = url.match(/\/me\/messages\/([^/?]+)\/move$/);
    if (move && method === "POST") {
      const destination = String((JSON.parse(String(init?.body)) as { destinationId: string }).destinationId);
      const folder = FOLDERS[destination] ?? destination;
      locations.set(decodeURIComponent(move[1]), folder);
      return Response.json({ id: decodeURIComponent(move[1]), parentFolderId: folder });
    }
    const lookup = url.match(/\/me\/messages\/([^/?]+)\?\$select=id,parentFolderId$/);
    if (lookup) {
      hooks.onLookup?.();
      if (hooks.throttled?.delete(decodeURIComponent(lookup[1]))) {
        return Response.json({ error: { code: "TooManyRequests", message: "Slow down." } }, { status: 429, headers: { "retry-after": "0" } });
      }
      const folder = locations.get(decodeURIComponent(lookup[1]));
      return folder ? Response.json({ id: decodeURIComponent(lookup[1]), parentFolderId: folder }) : Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });
    }
    const folderDelta = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/);
    if (folderDelta) {
      const key = url.includes("token=") ? url : `start:${folderDelta[1]}`;
      const page = pages[key];
      if (!page) return Response.json({ value: [], "@odata.deltaLink": delta(folderDelta[1], "quiet") });
      return typeof page === "function" ? page() : Response.json(page);
    }
    return Response.json({ value: [] });
  };
  return { fetchImpl, calls, locations };
}

function pusher() {
  const sent: { title: string; body: string }[] = [];
  const send: PushSender = async (_subscription, payload) => {
    sent.push(JSON.parse(payload));
  };
  return { send, sent };
}

function batch(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => message(`${prefix}-${String(index).padStart(3, "0")}`));
}

async function arrivalsOf(ids: string[]) {
  const rows = await getAdminPool().query<{ provider_message_id: string }>("select provider_message_id from crm.mail_messages where id = any($1::uuid[])", [ids]);
  return rows.rows.map((row) => row.provider_message_id).sort();
}

describe("mail sync across many pages", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("paging@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await savePushSubscription(owner, { endpoint: "https://web.push.apple.com/phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    const admin = getAdminPool();
    await admin.query("insert into crm.mail_preferences (workspace_id, user_id, notify_mail) values ($1, $2, 'all')", [owner.workspaceId, owner.userId]);
    await admin.query(
      `insert into crm.workflows (workspace_id, owner_id, name, status, trigger_type, definition)
       values ($1, $2, 'On email', 'active', 'email_received', '{"trigger": {"type": "email_received", "kind": "any"}, "steps": []}'::jsonb)`,
      [owner.workspaceId, owner.userId],
    );
    const first = outlook({ "start:f-inbox": { value: [message("old-1", { receivedDateTime: "2026-01-01T09:00:00Z" })], "@odata.deltaLink": delta("f-inbox", "t1") } });
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: first.fetchImpl });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.arrived, [], "the first backfill isn't new mail");
  });

  after(async () => {
    await getPool().end();
  });

  it("waits as long as Outlook asks before trying again, and gives up on long waits", () => {
    const after = (value: string | null) => ({ headers: new Headers(value === null ? {} : { "retry-after": value }) });
    assert.equal(retryWaitMs(after("2"), 0), 2000);
    assert.equal(retryWaitMs(after("0"), 1), 0);
    assert.equal(retryWaitMs(after(null), 0), 1000);
    assert.equal(retryWaitMs(after(null), 1), 2000);
    assert.equal(retryWaitMs(after("120"), 0), null);
  });

  it("notifies, routes and queues workflows for every new email on every page", async () => {
    const admin = getAdminPool();
    await admin.query("insert into crm.mail_subscriptions (workspace_id, user_id, sender, status) values ($1, $2, 'b-115@client.test', 'blocked')", [owner.workspaceId, owner.userId]);
    const box = outlook({
      [delta("f-inbox", "t1")]: { value: batch("a", 50), "@odata.nextLink": skip("f-inbox", "a2") },
      [skip("f-inbox", "a2")]: { value: batch("b", 50), "@odata.nextLink": skip("f-inbox", "a3") },
      [skip("f-inbox", "a3")]: { value: batch("b", 120).slice(100), "@odata.deltaLink": delta("f-inbox", "t2") },
    });
    const push = pusher();
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: box.fetchImpl, backfill: false, push: push.send });
    assert.deepEqual(report.errors, []);
    assert.equal(report.stored, 120);
    assert.equal(report.arrived.length, 120);
    assert.ok((await arrivalsOf(report.arrived)).includes("b-119"));
    assert.equal(report.routed, 1, "a blocked sender on the third page is archived");
    assert.ok(box.calls.some((call) => call.startsWith("POST") && call.includes("/me/messages/b-115/move")));
    assert.deepEqual(push.sent.map((item) => item.title), ["119 new emails"]);
    assert.equal(report.workflowEvents, 120);
    const events = await admin.query<{ count: number }>("select count(*)::int as count from crm.workflow_events where event_type = 'email.received'");
    assert.equal(events.rows[0].count, 120);
    const folder = await admin.query<{ sync_state: string; sync_link: string }>("select sync_state, sync_link from crm.mail_folders where provider_folder_id = 'f-inbox'");
    assert.deepEqual(folder.rows[0], { sync_state: "live", sync_link: delta("f-inbox", "t2") });
    const pending = await admin.query("select 1 from crm.mail_messages where arrival_pending");
    assert.equal(pending.rowCount, 0);
  });

  it("resumes an interrupted sync from the last finished page and still handles everything after it", async () => {
    const admin = getAdminPool();
    let lockedFor = 0;
    const failing = outlook({
      [delta("f-inbox", "t2")]: { value: batch("c", 50), "@odata.nextLink": skip("f-inbox", "c2") },
      [skip("f-inbox", "c2")]: async () => {
        const lock = await admin.query<{ seconds: number }>("select extract(epoch from locked_until - now())::int as seconds from crm.mail_sources where user_id = $1", [owner.userId]);
        lockedFor = lock.rows[0].seconds;
        return Response.json({ value: batch("d", 50), "@odata.nextLink": skip("f-inbox", "c3") });
      },
      [skip("f-inbox", "c3")]: () => Response.json({ error: { code: "ServiceUnavailable", message: "Try again later." } }, { status: 503 }),
    });
    const first = await syncMail(owner, { budgetMs: 8_000, fetchImpl: failing.fetchImpl, backfill: false, push: pusher().send });
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0], /Try again later/);
    assert.equal(first.arrived.length, 100, "both finished pages are handled even though the sync stopped");
    assert.ok(lockedFor > 0 && lockedFor <= 8 + 60, `the lock lasts for the sync's own budget, not ${lockedFor} seconds`);
    const stopped = await admin.query<{ sync_state: string; sync_link: string; locked_until: Date | null }>(
      `select f.sync_state, f.sync_link, s.locked_until from crm.mail_folders f join crm.mail_sources s on s.id = f.source_id
       where f.provider_folder_id = 'f-inbox'`,
    );
    assert.deepEqual(stopped.rows[0], { sync_state: "live", sync_link: skip("f-inbox", "c3"), locked_until: null });

    await admin.query("update crm.mail_messages set arrival_pending = true where provider_message_id = 'd-049'");

    const resumed = outlook({
      [skip("f-inbox", "c3")]: { value: batch("e", 30), "@odata.deltaLink": delta("f-inbox", "t3") },
    });
    const push = pusher();
    const second = await syncMail(owner, { budgetMs: 30_000, fetchImpl: resumed.fetchImpl, backfill: false, push: push.send });
    assert.deepEqual(second.errors, []);
    assert.ok(!resumed.calls.some((call) => call.includes("deltatoken=t2")), "it carries on from the saved page");
    const arrived = await arrivalsOf(second.arrived);
    assert.equal(arrived.length, 31);
    assert.ok(arrived.includes("e-029"));
    assert.ok(arrived.includes("d-049"), "an arrival a stopped sync didn't get to is handled by the next one");
    assert.deepEqual(push.sent.map((item) => item.title), ["31 new emails"]);
    const folder = await admin.query<{ sync_state: string; sync_link: string }>("select sync_state, sync_link from crm.mail_folders where provider_folder_id = 'f-inbox'");
    assert.deepEqual(folder.rows[0], { sync_state: "live", sync_link: delta("f-inbox", "t3") });
  });

  it("keeps an email and what Orbit made for it when it's archived in Outlook", async () => {
    const admin = getAdminPool();
    const row = (
      await admin.query<{ id: string; source_id: string; thread_key: string }>("select id, source_id, thread_key from crm.mail_messages where provider_message_id = 'e-000'")
    ).rows[0];
    await admin.query(
      "insert into crm.mail_prepared (workspace_id, user_id, source_id, thread_key, message_id, kind, body) values ($1, $2, $3, $4, $5, 'reply', 'Thanks, Tuesday works.')",
      [owner.workspaceId, owner.userId, row.source_id, row.thread_key, row.id],
    );
    await admin.query(
      "insert into crm.mail_attachment_texts (workspace_id, user_id, message_id, attachment_id, name, state, text) values ($1, $2, $3, 'att-1', 'brief.pdf', 'read', 'The brief')",
      [owner.workspaceId, owner.userId, row.id],
    );
    await admin.query("update crm.mail_folders set sync_state = 'live', sync_link = $2 where provider_folder_id = $1", ["f-archive", delta("f-archive", "a1")]);
    const box = outlook(
      {
        [delta("f-inbox", "t3")]: {
          value: [
            { id: "e-000", "@removed": { reason: "deleted" } },
            { id: "e-001", "@removed": { reason: "deleted" } },
          ],
          "@odata.deltaLink": delta("f-inbox", "t4"),
        },
        [delta("f-archive", "a1")]: { value: [message("e-000", { isRead: true })], "@odata.deltaLink": delta("f-archive", "a2") },
      },
      new Map([["e-000", "f-archive"]]),
      { throttled: new Set(["e-000"]) },
    );
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: box.fetchImpl, backfill: false });
    assert.deepEqual(report.errors, []);
    assert.equal(report.arrived.length, 0);
    assert.equal(report.moved, 1);
    assert.equal(report.removed, 1);
    assert.equal(box.calls.filter((call) => call.includes("/me/messages/e-000?$select=id,parentFolderId")).length, 2, "a throttled lookup is tried again");
    const kept = await admin.query<{ id: string; role: string; is_read: boolean }>(
      "select m.id, f.role, m.is_read from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where m.provider_message_id = 'e-000'",
    );
    assert.deepEqual(kept.rows, [{ id: row.id, role: "archive", is_read: true }]);
    const prepared = await admin.query<{ body: string }>("select body from crm.mail_prepared where message_id = $1", [row.id]);
    assert.deepEqual(prepared.rows, [{ body: "Thanks, Tuesday works." }]);
    const texts = await admin.query<{ text: string }>("select text from crm.mail_attachment_texts where message_id = $1", [row.id]);
    assert.deepEqual(texts.rows, [{ text: "The brief" }]);
    const deleted = await admin.query("select 1 from crm.mail_messages where provider_message_id = 'e-001'");
    assert.equal(deleted.rowCount, 0, "an email deleted for good leaves Orbit too");
  });

  it("stops looking up removed emails at the deadline and leaves the page for the next sync", async () => {
    const admin = getAdminPool();
    const gone = Array.from({ length: 10 }, (_, index) => `e-${String(index + 2).padStart(3, "0")}`);
    const page = {
      value: [...gone.map((id) => ({ id, "@removed": { reason: "deleted" } })), message("f-001")],
      "@odata.deltaLink": delta("f-inbox", "t5"),
    };
    const realNow = Date.now;
    let lookups = 0;
    const slow = outlook({ [delta("f-inbox", "t4")]: page }, new Map(), {
      onLookup: () => {
        lookups += 1;
        Date.now = () => realNow() + 10 * 60_000;
      },
    });
    let stopped;
    try {
      stopped = await syncMail(owner, { budgetMs: 30_000, fetchImpl: slow.fetchImpl, backfill: false });
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(stopped.errors, []);
    assert.equal(lookups, 4, "one batch of four, then it stops");
    assert.equal(stopped.removed, 0);
    const held = await admin.query("select 1 from crm.mail_messages where provider_message_id = any($1::text[])", [gone]);
    assert.equal(held.rowCount, 10);
    assert.equal((await admin.query("select 1 from crm.mail_messages where provider_message_id = 'f-001'")).rowCount, 0);
    const folder = await admin.query<{ sync_link: string }>("select sync_link from crm.mail_folders where provider_folder_id = 'f-inbox'");
    assert.equal(folder.rows[0].sync_link, delta("f-inbox", "t4"), "the cursor stays on the unfinished page");

    const finished = await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook({ [delta("f-inbox", "t4")]: page }).fetchImpl, backfill: false });
    assert.deepEqual(finished.errors, []);
    assert.equal(finished.removed, 10);
    assert.equal(finished.stored, 1);
    assert.equal((await admin.query("select 1 from crm.mail_messages where provider_message_id = any($1::text[])", [gone])).rowCount, 0);
  });
});
