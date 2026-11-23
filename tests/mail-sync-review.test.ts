import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import { createContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { runMailPass } from "@/lib/mail/cron-pass";
import { syncMail } from "@/lib/mail/sync";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", archive: "f-archive", outbox: "f-outbox" };
const HOUR = 3_600_000;

type Handler = (url: string, method: string, init?: RequestInit) => Response | Promise<Response | undefined> | undefined;

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

function ago(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function delta(folder: string, token: string) {
  return `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;
}

function outlook(handler: Handler = () => undefined) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const custom = await handler(url, method, init);
    if (custom) return custom;
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: Object.entries(FOLDERS).map(([name, id]) => ({ id, displayName: name, childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0 })),
      });
    }
    if (/\/me\/messages\/[^/?]+\?\$select=id,parentFolderId$/.test(url)) return Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });
    const folderDelta = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/);
    if (folderDelta) return Response.json({ value: [], "@odata.deltaLink": delta(decodeURIComponent(folderDelta[1]), "quiet") });
    return Response.json({ value: [] });
  };
  return { fetchImpl, calls, matching: (part: string) => calls.filter((call) => call.includes(part)) };
}

async function seed(folder: string, providerId: string, receivedAt: string | null = null) {
  await getAdminPool().query(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, received_at, thread_key)
     select workspace_id, user_id, source_id, id, $2, $3, 'conv-' || $2 from crm.mail_folders where provider_folder_id = $1`,
    [folder, providerId, receivedAt],
  );
}

async function stored(providerId: string) {
  return (await getAdminPool().query("select 1 from crm.mail_messages where provider_message_id = $1", [providerId])).rowCount;
}

async function folderRow(providerId: string) {
  const rows = await getAdminPool().query<{
    sync_state: string;
    sync_link: string | null;
    classified_at: Date | null;
    classify_link: string | null;
    walk_started_at: Date | null;
    walk_was_live: boolean;
  }>("select sync_state, sync_link, classified_at, classify_link, walk_started_at, walk_was_live from crm.mail_folders where provider_folder_id = $1", [providerId]);
  return rows.rows[0];
}

async function connection() {
  const rows = await getAdminPool().query<{ status: string; email: string; refresh_token: string | null; access_token: string | null; access_token_expires_at: Date | null }>(
    "select status, email, refresh_token, access_token, access_token_expires_at from crm.mailbox_connections",
  );
  return rows.rows[0];
}

describe("mail sync review fixes", () => {
  let owner: UserActor;
  const initial = {} as { box: ReturnType<typeof outlook>; report: Awaited<ReturnType<typeof syncMail>>; focused: boolean | null };

  async function connect() {
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + HOUR).toISOString() });
  }

  async function deliver(folder: string, items: unknown[]) {
    await getAdminPool().query("update crm.mail_folders set sync_link = $2 where provider_folder_id = $1", [folder, delta(folder, "in")]);
    const box = outlook((url) => (url === delta(folder, "in") ? Response.json({ value: items, "@odata.deltaLink": delta(folder, "out") }) : undefined));
    return syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
  }

  before(async () => {
    await resetDatabase();
    owner = await createUser("review@orbit.test", "Mark Ridgeon");
    await connect();
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    initial.box = outlook((url) =>
      url.includes("/mailFolders/f-inbox/messages/delta")
        ? Response.json({ value: [message("first-1", { inferenceClassification: "focused" })], "@odata.deltaLink": delta("f-inbox", "t1") })
        : undefined,
    );
    initial.report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: initial.box.fetchImpl });
    initial.focused = (await getAdminPool().query<{ focused: boolean | null }>("select focused from crm.mail_messages where provider_message_id = 'first-1'")).rows[0]?.focused ?? null;
  });

  beforeEach(async () => {
    const admin = getAdminPool();
    await admin.query(
      `update crm.mail_folders set sync_state = 'live', sync_link = $1 || provider_folder_id || '/messages/delta?$deltatoken=quiet',
         failures = 0, retry_at = null, last_error = null, last_synced_at = now(), classified_at = coalesce(classified_at, now()),
         classify_link = null, walk_started_at = null, walk_was_live = false
       where sync_state <> 'skipped'`,
      [`${GRAPH}/me/mailFolders/`],
    );
    await admin.query("update crm.mail_sources set last_error = null, retry_at = null, locked_until = null");
    await admin.query("delete from crm.mail_messages");
  });

  after(async () => {
    await getPool().end();
  });

  useServerlessPool();

  it("counts a folder's first delta walk as Focused sorted, without walking the folder again", async () => {
    assert.deepEqual(initial.report.errors, []);
    assert.equal(initial.box.matching("$select=id,inferenceClassification").length, 0);
    const inbox = await folderRow("f-inbox");
    assert.ok(inbox.classified_at);
    assert.equal(inbox.sync_state, "live");
    assert.equal(initial.focused, true);
  });

  it("removes mail that vanished while a folder's delta link was dead, and keeps what it still holds", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_folders set sync_link = $1, last_synced_at = now() - interval '1 hour' where provider_folder_id = 'f-inbox'", [delta("f-inbox", "dead")]);
    await seed("f-inbox", "keep-1", ago(2 * HOUR));
    await seed("f-inbox", "gone-1", ago(2 * HOUR));
    await seed("f-archive", "archive-1", ago(2 * HOUR));
    const box = outlook((url) => {
      if (url === delta("f-inbox", "dead")) return Response.json({ error: { code: "SyncStateNotFound", message: "The sync state is gone." } }, { status: 410 });
      if (url.includes("/mailFolders/f-inbox/messages/delta?$select=")) {
        return Response.json({
          value: [
            message("keep-1", { receivedDateTime: ago(2 * HOUR) }),
            message("fresh-1", { receivedDateTime: ago(5 * 60_000) }),
            message("old-1", { receivedDateTime: ago(3 * HOUR) }),
          ],
          "@odata.deltaLink": delta("f-inbox", "fresh"),
        });
      }
      return undefined;
    });

    const reset = await syncMail(owner, { budgetMs: 30_000, fetchImpl: box.fetchImpl });
    assert.deepEqual(reset.errors, []);
    const waiting = await folderRow("f-inbox");
    assert.equal(waiting.sync_state, "pending");
    assert.ok(waiting.walk_started_at);
    assert.equal(waiting.walk_was_live, true);
    assert.equal(await stored("gone-1"), 1, "nothing is removed before the walk is complete");
    await seed("f-inbox", "late-1", ago(60_000));

    const walk = await syncMail(owner, { budgetMs: 30_000, fetchImpl: box.fetchImpl });
    assert.deepEqual(walk.errors, []);
    assert.equal(await stored("gone-1"), 0, "mail the walk did not see is gone");
    assert.equal(await stored("keep-1"), 1);
    assert.equal(await stored("archive-1"), 1, "other folders are left alone");
    assert.equal(await stored("late-1"), 1, "mail stored after the walk began is kept");
    assert.equal(await stored("fresh-1"), 1);
    assert.equal(await stored("old-1"), 1);
    const done = await folderRow("f-inbox");
    assert.equal(done.sync_state, "live");
    assert.equal(done.sync_link, delta("f-inbox", "fresh"));
    assert.equal(done.walk_started_at, null);
    assert.equal(done.walk_was_live, false);
    const ids = await admin.query<{ provider_message_id: string }>("select provider_message_id from crm.mail_messages where id = any($1::uuid[])", [walk.arrived]);
    assert.deepEqual(ids.rows.map((row) => row.provider_message_id), ["fresh-1"], "only mail newer than the last good sync counts as an arrival");
  });

  it("does not treat the first walk of a folder as new mail or remove anything from it", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_folders set sync_state = 'pending', sync_link = null, last_synced_at = null where provider_folder_id = 'f-inbox'");
    await seed("f-inbox", "held-1", ago(HOUR));
    const box = outlook((url) =>
      url.includes("/mailFolders/f-inbox/messages/delta?$select=")
        ? Response.json({ value: [message("first-2", { receivedDateTime: ago(60_000) })], "@odata.deltaLink": delta("f-inbox", "first") })
        : undefined,
    );
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: box.fetchImpl });
    assert.deepEqual(report.arrived, []);
    assert.equal(await stored("held-1"), 1);
    assert.equal(await stored("first-2"), 1);
  });

  it("finishes the Focused walk for older folders from where it stopped", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_folders set classified_at = null where provider_folder_id = 'f-inbox'");
    await seed("f-inbox", "c-1");
    await seed("f-inbox", "c-2");
    const secondPage = `${GRAPH}/me/mailFolders/f-inbox/messages?$skiptoken=page2`;
    let secondFails = true;
    const box = outlook((url) => {
      if (url.includes("$select=id,inferenceClassification") && !url.includes("skiptoken")) {
        return Response.json({ value: [{ id: "c-1", inferenceClassification: "focused" }], "@odata.nextLink": secondPage });
      }
      if (url === secondPage) {
        if (secondFails) return Response.json({ error: { code: "ErrorInvalidRequest", message: "Bad." } }, { status: 400 });
        return Response.json({ value: [{ id: "c-2", inferenceClassification: "other" }] });
      }
      return undefined;
    });
    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    const cut = await folderRow("f-inbox");
    assert.equal(cut.classified_at, null);
    assert.equal(cut.classify_link, secondPage, "the cursor is kept");

    secondFails = false;
    const again = outlook((url) => {
      if (url === secondPage) return Response.json({ value: [{ id: "c-2", inferenceClassification: "other" }] });
      return undefined;
    });
    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: again.fetchImpl });
    assert.equal(again.matching("$select=id,inferenceClassification").filter((call) => !call.includes("skiptoken")).length, 0, "it doesn't start again from page one");
    const done = await folderRow("f-inbox");
    assert.ok(done.classified_at);
    assert.equal(done.classify_link, null);
    const focus = await admin.query<{ provider_message_id: string; focused: boolean }>("select provider_message_id, focused from crm.mail_messages order by provider_message_id");
    assert.deepEqual(focus.rows, [
      { provider_message_id: "c-1", focused: true },
      { provider_message_id: "c-2", focused: false },
    ]);
  });

  it("sends the push before the Focused walk and before reading email tone", async () => {
    const admin = getAdminPool();
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@client.test" });
    await admin.query("insert into crm.mail_preferences (workspace_id, user_id, notify_mail) values ($1, $2, 'all') on conflict do nothing", [owner.workspaceId, owner.userId]);
    await savePushSubscription(owner, { endpoint: "https://web.push.apple.com/review", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    await admin.query("update crm.mail_folders set classified_at = null where provider_folder_id = 'f-inbox'");
    const events: string[] = [];
    const push: PushSender = async () => {
      events.push("push");
    };
    process.env.LLM_API_KEY = "test-llm-key";
    try {
      const box = outlook((url) => {
        if (url === delta("f-inbox", "in")) return Response.json({ value: [message("jane", { from: { emailAddress: { name: "Jane Doe", address: "jane@client.test" } } })], "@odata.deltaLink": delta("f-inbox", "out") });
        if (url.includes("$select=id,inferenceClassification")) {
          events.push("focused");
          return Response.json({ value: [] });
        }
        if (!url.startsWith(GRAPH) && !url.includes("login.microsoftonline.com")) {
          events.push("tone");
          return Response.json({ error: "no" }, { status: 500 });
        }
        return undefined;
      });
      await admin.query("update crm.mail_folders set sync_link = $1 where provider_folder_id = 'f-inbox'", [delta("f-inbox", "in")]);
      await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl, push });
    } finally {
      process.env.LLM_API_KEY = "";
      await admin.query("delete from crm.push_subscriptions where user_id = $1", [owner.userId]);
    }
    assert.equal(events[0], "push", "the arrival is pushed first");
    assert.ok(events.includes("focused"), "the Focused walk still runs");
    assert.ok(events.includes("tone"), "email tone is still read");
  });

  it("does not rewrite a message Outlook delivers again unchanged, and still stores a real change", async () => {
    const admin = getAdminPool();
    const original = message("same-1");
    await deliver("f-inbox", [original]);
    const version = async () => (await admin.query<{ xmin: string; is_read: boolean; body_html: string }>("select xmin::text, is_read, body_html from crm.mail_messages where provider_message_id = 'same-1'")).rows[0];
    const first = await version();
    const again = await deliver("f-inbox", [original]);
    assert.equal((await version()).xmin, first.xmin, "an identical delivery writes nothing");
    assert.equal(again.changed, 0);
    assert.equal(again.stored, 1);

    await deliver("f-inbox", [{ ...original, inferenceClassification: undefined }]);
    assert.equal((await version()).xmin, first.xmin, "a delivery that doesn't say Focused or Other changes nothing either");

    const read = await deliver("f-inbox", [{ ...original, isRead: true }]);
    const afterRead = await version();
    assert.equal(afterRead.is_read, true);
    assert.notEqual(afterRead.xmin, first.xmin);
    assert.equal(read.changed, 1);

    await deliver("f-inbox", [{ ...original, isRead: true, body: { contentType: "html", content: "<p>Edited</p>" } }]);
    assert.match((await version()).body_html, /Edited/);
  });

  it("does not list every folder again when mail moved to a folder Orbit doesn't sync", async () => {
    await seed("f-inbox", "outbound-1");
    const box = outlook((url) => {
      if (url === delta("f-inbox", "quiet")) return Response.json({ value: [{ id: "outbound-1", "@removed": { reason: "changed" } }], "@odata.deltaLink": delta("f-inbox", "next") });
      if (url.includes("/me/messages/outbound-1?")) return Response.json({ id: "outbound-1", parentFolderId: "f-outbox" });
      return undefined;
    });
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.deepEqual(report.errors, []);
    assert.equal(await stored("outbound-1"), 0, "mail in a folder Orbit skips is dropped");
    assert.equal(box.matching("/me/mailFolders?$top=100").length, 0, "no folder refresh for a skipped folder");
  });

  it("never writes old tokens over a mailbox that was disconnected or reconnected while the sync ran", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mailbox_connections set access_token_expires_at = now() - interval '1 hour'");
    const disconnected = outlook(async (url) => {
      if (!url.includes("/oauth2/v2.0/token")) return undefined;
      await admin.query("update crm.mailbox_connections set status = 'disconnected', refresh_token = null, access_token = null, access_token_expires_at = null");
      return Response.json({ access_token: "late-access", refresh_token: "late-refresh", expires_in: 3600 });
    });
    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: disconnected.fetchImpl });
    const row = await connection();
    assert.equal(row.status, "disconnected");
    assert.equal(row.refresh_token, null);
    assert.equal(row.access_token, null);

    await connect();
    await admin.query("update crm.mailbox_connections set access_token_expires_at = now() - interval '1 hour'");
    let replaced: string | null = null;
    const switched = outlook(async (url) => {
      if (!url.includes("/oauth2/v2.0/token")) return undefined;
      await admin.query("update crm.mailbox_connections set email = 'second@eclipse.test', refresh_token = (select refresh_token from crm.mailbox_connections) || 'x'");
      replaced = (await connection()).refresh_token;
      return Response.json({ access_token: "late-access", refresh_token: "late-refresh", expires_in: 3600 });
    });
    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: switched.fetchImpl });
    const after = await connection();
    assert.equal(after.refresh_token, replaced, "the newer connection keeps its tokens");
    await admin.query("update crm.mailbox_connections set email = 'mark@eclipse.test'");
    await connect();
  });

  it("stores a refreshed token once, and not again while the access token is still good", async () => {
    const admin = getAdminPool();
    await connect();
    await admin.query("update crm.mailbox_connections set access_token_expires_at = now() - interval '1 hour'");
    const refreshing = outlook((url) => (url.includes("/oauth2/v2.0/token") ? Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }) : undefined));
    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: refreshing.fetchImpl });
    const row = await connection();
    assert.equal(decryptSecret(row.refresh_token!), "new-refresh");
    assert.equal(decryptSecret(row.access_token!), "new-access");
    assert.ok(row.access_token_expires_at && row.access_token_expires_at.getTime() > Date.now() + 30 * 60_000);
    const cipher = row.refresh_token;
    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: outlook().fetchImpl });
    assert.equal((await connection()).refresh_token, cipher, "a sync that didn't refresh writes no token");
  });

  it("syncs every user before any user's extras, and bounds each user's extras", async () => {
    const actors = ["a", "b", "c"].map((name) => ({ userId: name }) as UserActor);
    const events: string[] = [];
    const turns: number[] = [];
    const until = Date.now() + 60_000;
    const users = await runMailPass(
      actors,
      {
        sync: async (actor) => {
          events.push(`sync ${actor.userId}`);
          if (actor.userId === "b") throw new Error("Nope.");
          return { stored: 1 };
        },
        extras: async (actor, turnEnd) => {
          events.push(`extras ${actor.userId}`);
          turns.push(turnEnd - Date.now());
        },
      },
      until,
    );
    assert.deepEqual(events, ["sync a", "sync b", "sync c", "extras a", "extras c"]);
    assert.deepEqual(users, [
      { userId: "a", report: { stored: 1 } },
      { userId: "b", report: { error: "Nope." } },
      { userId: "c", report: { stored: 1 } },
    ]);
    assert.ok(turns[0] <= 30_500 && turns[0] > 29_000, "the first of two gets half the time left");
    assert.ok(turns[1] <= 60_500, "the last gets what is left");
  });
});
