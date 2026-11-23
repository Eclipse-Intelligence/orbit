import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { applyMailAction, moveMessages } from "@/lib/mail/actions";
import { processDueMail } from "@/lib/mail/due";
import { queueMailAction, runPendingMailActions } from "@/lib/mail/pending";
import { threadText } from "@/lib/mail/ai";
import { getMailThread } from "@/lib/mail/store";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads, mailNav } from "@/lib/mail/threads";
import type { ThreadCursor, ThreadSummary } from "@/lib/mail/view";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", archive: "f-archive", deleteditems: "f-trash" };
const DAY = 86_400_000;

function outlook() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "POST" && url === `${GRAPH}/me/mailFolders`) return Response.json({ id: "f-snoozed", displayName: "Snoozed" }, { status: 201 });
    const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
    if (method === "POST" && url.endsWith("/move")) {
      const destination = String((JSON.parse(String(init?.body)) as { destinationId: string }).destinationId);
      return Response.json({ id, parentFolderId: FOLDERS[destination] ?? destination }, { status: 201 });
    }
    if (method === "PATCH") return Response.json({ id });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: Object.entries(FOLDERS).map(([name, folder]) => ({ id: folder, displayName: name, childFolderCount: 0, totalItemCount: 0 })) });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    return Response.json({ value: [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=done` });
  };
  const writes = () => calls.filter((call) => !call.startsWith("GET "));
  const moves = () => calls.filter((call) => call.startsWith("POST ") && call.endsWith("/move"));
  return { fetchImpl, calls, writes, moves };
}

describe("mail threads and mailbox actions", () => {
  useServerlessPool();

  let owner: UserActor;
  let sourceId: string;
  let counter = 0;
  const admin = () => getAdminPool();

  const folderId = async (role: string) => (await admin().query<{ id: string }>("select id from crm.mail_folders where source_id = $1 and role = $2", [sourceId, role])).rows[0].id;
  const thread = (key: string) => `${sourceId}|${key}`;
  const roleOf = async (provider: string) =>
    (await admin().query<{ role: string }>("select f.role from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where m.provider_message_id = $1", [provider])).rows[0]?.role ?? null;

  type Seed = {
    thread: string;
    folder: string;
    at: string | Date | null;
    sentAt?: string | Date | null;
    provider?: string;
    from?: string;
    read?: boolean;
    draft?: boolean;
    html?: string | null;
    text?: string | null;
    subject?: string;
  };

  const seed = async (values: Seed) => {
    counter += 1;
    const provider = values.provider ?? `seed-${counter}`;
    const result = await admin().query<{ id: string }>(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
         body_html, body_text, from_email, from_name, to_recipients, sent_at, received_at, is_read, is_draft)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'Snippet', $9, $10, $11, 'Jane', '[{"name":"Mark","address":"mark@eclipse.test"}]'::jsonb, $12, $13, $14, $15)
       returning id`,
      [
        owner.workspaceId,
        owner.userId,
        sourceId,
        await folderId(values.folder),
        provider,
        `<${provider}@mail.test>`,
        values.thread,
        values.subject ?? `Subject ${values.thread}`,
        values.html ?? null,
        values.text === undefined ? "Hello there" : values.text,
        values.from ?? "jane@acme.test",
        values.sentAt ?? values.at,
        values.at,
        values.read ?? false,
        values.draft ?? false,
      ],
    );
    return result.rows[0].id;
  };

  const seedMany = async (key: string, folder: string, count: number, options: { start?: Date; read?: boolean; draftsAfter?: number } = {}) => {
    const start = (options.start ?? new Date(Date.now() - 2 * DAY)).getTime();
    await admin().query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
         body_text, from_email, from_name, to_recipients, sent_at, received_at, is_read)
       select $1, $2, $3, $4, $5 || '-' || n, '<' || $5 || '-' || n || '@mail.test>', $5, 'Long thread', 'Snippet', 'Body ' || n,
         'jane@acme.test', 'Jane', '[{"name":"Mark","address":"mark@eclipse.test"}]'::jsonb,
         $6::timestamptz + n * interval '1 minute', $6::timestamptz + n * interval '1 minute', $7
       from generate_series(1, $8::int) n`,
      [owner.workspaceId, owner.userId, sourceId, await folderId(folder), key, new Date(start).toISOString(), options.read ?? false, count],
    );
    if (options.draftsAfter) {
      await admin().query(
        `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
           body_text, from_email, to_recipients, sent_at, received_at, is_read, is_draft)
         select $1, $2, $3, $4, $5 || '-draft-' || n, '<' || $5 || '-draft-' || n || '@mail.test>', $5, 'Long thread', 'Draft', 'Draft ' || n,
           'mark@eclipse.test', '[]'::jsonb, $6::timestamptz + ($8::int + n) * interval '1 minute', $6::timestamptz + ($8::int + n) * interval '1 minute', true, true
         from generate_series(1, $7::int) n`,
        [owner.workspaceId, owner.userId, sourceId, await folderId("drafts"), key, new Date(start).toISOString(), options.draftsAfter, count],
      );
    }
  };

  const reminders = async (key: string, kind = "snooze") =>
    (await admin().query<{ state: string; due_at: Date }>("select state, due_at from crm.mail_reminders where thread_key = $1 and kind = $2 order by created_at", [key, kind])).rows;

  before(async () => {
    await resetDatabase();
    owner = await createUser("threads-review@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    assert.deepEqual(report.errors, []);
    sourceId = (await admin().query<{ id: string }>("select id from crm.mail_sources")).rows[0].id;
  });

  after(async () => {
    await getPool().end();
  });

  describe("Remind me", () => {
    const until = () => new Date(Date.now() + 3_600_000).toISOString();

    it("moves a thread that is only in Archive and records the reminder when no view is given", async () => {
      await seed({ thread: "snz-archive", folder: "archive", at: new Date(Date.now() - DAY), provider: "snz-archive-1" });
      const box = outlook();
      const result = await applyMailAction(owner, { thread: thread("snz-archive"), action: "snooze", until: until() }, box.fetchImpl);
      assert.equal(result.changed, 1);
      assert.equal(await roleOf("snz-archive-1"), "snoozed");
      assert.deepEqual((await reminders("snz-archive")).map((row) => row.state), ["waiting"]);
    });

    it("gives a thread already in Reminders the new time without another move", async () => {
      await seed({ thread: "snz-already", folder: "inbox", at: new Date(Date.now() - DAY), provider: "snz-already-1" });
      await applyMailAction(owner, { thread: thread("snz-already"), action: "snooze", view: { role: "inbox" }, until: until() }, outlook().fetchImpl);
      assert.equal(await roleOf("snz-already-1"), "snoozed");
      const later = new Date(Date.now() + 5 * DAY);
      for (const view of [undefined, { role: "snoozed" as const }, { role: "inbox" as const }]) {
        const box = outlook();
        const result = await applyMailAction(owner, { thread: thread("snz-already"), action: "snooze", view, until: later.toISOString() }, box.fetchImpl);
        assert.equal(result.failed, 0);
        assert.deepEqual(box.writes(), [], "nothing is moved when the thread is already in Reminders");
      }
      const rows = await reminders("snz-already");
      assert.equal(rows.filter((row) => row.state === "waiting").length, 1, "one open reminder");
      assert.ok(Math.abs(rows.filter((row) => row.state === "waiting")[0].due_at.getTime() - later.getTime()) < 1000, "it carries the new time");
      assert.equal(await roleOf("snz-already-1"), "snoozed");
    });

    it("creates the reminder for a retried snooze whose first move was recorded by sync", async () => {
      await seed({ thread: "snz-retry", folder: "inbox", at: new Date(Date.now() - DAY), provider: "snz-retry-1" });
      await applyMailAction(owner, { thread: thread("snz-retry"), action: "snooze", view: { role: "inbox" }, until: until() }, outlook().fetchImpl);
      await admin().query("update crm.mail_reminders set state = 'done' where thread_key = 'snz-retry'");
      const result = await applyMailAction(owner, { thread: thread("snz-retry"), action: "snooze", view: { role: "inbox" }, until: until() }, outlook().fetchImpl);
      assert.equal(result.problem, null);
      assert.deepEqual((await reminders("snz-retry")).map((row) => row.state), ["done", "waiting"]);
    });

    it("never moves sent mail or drafts, only records the reminder", async () => {
      await seed({ thread: "snz-sent", folder: "sent", at: new Date(Date.now() - DAY), provider: "snz-sent-1", from: "mark@eclipse.test", read: true });
      for (const view of [undefined, { role: "sent" as const }]) {
        const box = outlook();
        await applyMailAction(owner, { thread: thread("snz-sent"), action: "snooze", view, until: until() }, box.fetchImpl);
        assert.deepEqual(box.writes(), []);
      }
      assert.equal(await roleOf("snz-sent-1"), "sent");
      assert.equal((await reminders("snz-sent")).filter((row) => row.state === "waiting").length, 1);

      await seed({ thread: "snz-mixed", folder: "sent", at: new Date(Date.now() - 2 * DAY), provider: "snz-mixed-sent", from: "mark@eclipse.test", read: true });
      await seed({ thread: "snz-mixed", folder: "inbox", at: new Date(Date.now() - DAY), provider: "snz-mixed-in" });
      await seed({ thread: "snz-mixed", folder: "drafts", at: new Date(Date.now() - 1000), provider: "snz-mixed-draft", from: "mark@eclipse.test", draft: true });
      const box = outlook();
      await applyMailAction(owner, { thread: thread("snz-mixed"), action: "snooze", view: { role: "sent" }, until: until() }, box.fetchImpl);
      assert.deepEqual(box.moves(), [`POST ${GRAPH}/me/messages/snz-mixed-in/move`]);
      assert.deepEqual([await roleOf("snz-mixed-sent"), await roleOf("snz-mixed-in"), await roleOf("snz-mixed-draft")], ["sent", "snoozed", "drafts"]);
    });

    it("shows a Sent-only reminder in Reminders while waiting and lifts it into the Inbox when due, without touching sent mail", async () => {
      const keys = async (view: Parameters<typeof listThreads>[1]["view"]) => (await listThreads(owner, { view, limit: 100 })).threads.map((item) => item.key);
      await seed({ thread: "snz-due-sent", folder: "sent", at: new Date(Date.now() - DAY), provider: "snz-due-sent-1", from: "mark@eclipse.test", read: true });
      await seed({ thread: "snz-due-queued", folder: "sent", at: new Date(Date.now() - DAY), provider: "snz-due-queued-1", from: "mark@eclipse.test", read: true });
      await seed({ thread: "snz-due-draft", folder: "drafts", at: new Date(Date.now() - DAY), provider: "snz-due-draft-1", from: "mark@eclipse.test", draft: true, read: true });
      await applyMailAction(owner, { thread: thread("snz-due-sent"), action: "snooze", until: until() }, outlook().fetchImpl);
      await queueMailAction(owner, { thread: thread("snz-due-queued"), action: "snooze", view: { role: "sent" }, until: until() });
      const queued = outlook();
      await runPendingMailActions(owner, { fetchImpl: queued.fetchImpl });
      assert.deepEqual(queued.writes(), []);
      await applyMailAction(owner, { thread: thread("snz-due-draft"), action: "snooze", until: until() }, outlook().fetchImpl);

      const names = ["snz-due-sent", "snz-due-queued", "snz-due-draft"].map(thread);
      const waiting = await keys({ role: "snoozed" });
      for (const name of names) assert.ok(waiting.includes(name), `${name} is in Reminders while waiting`);
      assert.equal((await mailNav(owner)).snoozed, waiting.length);
      assert.ok(!(await keys({ role: "inbox" })).some((name) => names.includes(name)), "not in the Inbox yet");

      await admin().query("update crm.mail_reminders set due_at = now() - interval '1 minute' where thread_key like 'snz-due-%' and kind = 'snooze' and state = 'waiting'");
      const box = outlook();
      const report = await processDueMail(owner, { fetchImpl: box.fetchImpl, origin: null });
      assert.equal(report.returned, 3);
      assert.deepEqual(box.writes(), [], "nothing is moved or marked unread in Outlook");
      assert.equal((await admin().query("select 1 from crm.mail_messages where thread_key like 'snz-due-%' and not is_read and not is_draft")).rowCount, 0, "no sent message becomes unread");
      const inbox = await listThreads(owner, { view: { role: "inbox" }, limit: 100 });
      for (const name of names) {
        const row = inbox.threads.find((item) => item.key === name);
        assert.ok(row, `${name} is in the Inbox when due`);
        assert.equal(row.reminder?.kind, "snooze");
      }
      assert.ok(!(await keys({ role: "snoozed" })).some((name) => names.includes(name)), "gone from Reminders once it is back");
    });

    it("keeps a Sent-only reminder in Reminders, and the count, after a reply lands in the Inbox", async () => {
      await seed({ thread: "snz-reply", folder: "sent", at: new Date(Date.now() - DAY), provider: "snz-reply-1", from: "mark@eclipse.test", read: true });
      await applyMailAction(owner, { thread: thread("snz-reply"), action: "snooze", until: until() }, outlook().fetchImpl);
      await seed({ thread: "snz-reply", folder: "inbox", at: new Date(Date.now() - 1000), provider: "snz-reply-2" });
      const listed = (await listThreads(owner, { view: { role: "snoozed" }, limit: 100 })).threads.map((item) => item.key);
      assert.ok(listed.includes(thread("snz-reply")));
      assert.equal((await mailNav(owner)).snoozed, listed.length, "the count is what the list shows");
    });

    it("brings a Sent-only reminder back, with its alert, when the reply was filed into a custom folder by a rule", async () => {
      await admin().query(
        `insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'f-clients', 'Clients', 'other')
         on conflict (source_id, provider_folder_id) do nothing`,
        [owner.workspaceId, owner.userId, sourceId],
      );
      await seed({ thread: "snz-ruled", folder: "sent", at: new Date(Date.now() - 2 * DAY), provider: "snz-ruled-1", from: "mark@eclipse.test", read: true });
      await applyMailAction(owner, { thread: thread("snz-ruled"), action: "snooze", until: until() }, outlook().fetchImpl);
      const replyId = await seed({ thread: "snz-ruled", folder: "other", at: new Date(Date.now() - 1000), provider: "snz-ruled-2" });
      const listed = (await listThreads(owner, { view: { role: "snoozed" }, limit: 100 })).threads.map((item) => item.key);
      assert.ok(listed.includes(thread("snz-ruled")));
      assert.equal((await mailNav(owner)).snoozed, listed.length, "the count is what the list shows");

      await admin().query("update crm.mail_reminders set due_at = now() - interval '1 minute' where thread_key = 'snz-ruled' and state = 'waiting'");
      const report = await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: null });
      assert.equal(report.returned, 1);
      const alerts = await admin().query("select 1 from crm.mail_reminders r join crm.push_log l on l.key = 'snooze:' || r.id where r.thread_key = 'snz-ruled'");
      assert.equal(alerts.rowCount, 1, "it alerts");
      const inbox = (await listThreads(owner, { view: { role: "inbox" }, limit: 100 })).threads;
      const row = inbox.find((item) => item.key === thread("snz-ruled"));
      assert.equal(row?.reminder?.kind, "snooze");
      assert.equal(inbox.filter((item) => item.key === thread("snz-ruled")).length, 1, "one row");
      assert.equal(row?.latestId, replyId, "the row shows the reply");
      assert.equal(row?.from?.address, "jane@acme.test");
      assert.equal(row?.count, 2);
      assert.equal(row?.unread, true, "and it is unread");
    });

    it("never lifts a returned snooze back into the Inbox once the thread has been filed or moved on", async () => {
      const inboxKeys = async () => (await listThreads(owner, { view: { role: "inbox" }, limit: 100 })).threads.map((item) => item.key);
      const reminderKeys = async () => (await listThreads(owner, { view: { role: "snoozed" }, limit: 100 })).threads.map((item) => item.key);
      const makeDue = (key: string) => admin().query("update crm.mail_reminders set due_at = now() - interval '1 minute' where thread_key = $1 and kind = 'snooze' and state = 'waiting'", [key]);
      await admin().query(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'f-clients', 'Clients', 'other') on conflict (source_id, provider_folder_id) do nothing",
        [owner.workspaceId, owner.userId, sourceId],
      );
      const returned = async (key: string, provider: string) => {
        const id = await seed({ thread: key, folder: "inbox", at: new Date(Date.now() - DAY), provider });
        await applyMailAction(owner, { thread: thread(key), action: "snooze", view: { role: "inbox" }, until: until() }, outlook().fetchImpl);
        await makeDue(key);
        await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: null });
        assert.ok((await inboxKeys()).includes(thread(key)), `${key} is back in the Inbox`);
        assert.deepEqual((await reminders(key)).map((row) => row.state), ["due"]);
        return id;
      };

      const filedId = await returned("ret-filed", "ret-filed-1");
      const moved = await moveMessages(owner, sourceId, [{ id: filedId, providerMessageId: "ret-filed-1", threadKey: "ret-filed" }], { providerFolderId: "f-clients", role: "other" }, outlook().fetchImpl);
      assert.equal(moved.error, null);
      assert.equal(await roleOf("ret-filed-1"), "other");
      assert.ok(!(await inboxKeys()).includes(thread("ret-filed")), "filed into a folder, it stays out of the Inbox");

      await returned("ret-synced", "ret-synced-1");
      await admin().query("update crm.mail_messages set folder_id = $1 where provider_message_id = 'ret-synced-1'", [await folderId("archive")]);
      assert.ok(!(await inboxKeys()).includes(thread("ret-synced")), "archived outside Orbit, it stays out of the Inbox");

      await seed({ thread: "ret-old", folder: "archive", at: new Date(Date.now() - 30 * DAY), provider: "ret-old-1" });
      await admin().query(
        `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, subject, state, surfaced_at)
         values ($1, $2, $3, 'ret-old', 'snooze', now() - interval '20 days', 'Old', 'due', now() - interval '20 days')`,
        [owner.workspaceId, owner.userId, sourceId],
      );
      assert.ok(!(await inboxKeys()).includes(thread("ret-old")), "an old due snooze on a moved thread stays out of the Inbox");

      await seed({ thread: "ret-failed", folder: "inbox", at: new Date(Date.now() - DAY), provider: "ret-failed-1" });
      await applyMailAction(owner, { thread: thread("ret-failed"), action: "snooze", view: { role: "inbox" }, until: until() }, outlook().fetchImpl);
      await admin().query("update crm.mail_reminders set state = 'due', surfaced_at = now() where thread_key = 'ret-failed'");
      assert.ok(!(await inboxKeys()).includes(thread("ret-failed")), "a snooze that could not return is not in both lists");
      assert.ok((await reminderKeys()).includes(thread("ret-failed")));
    });

    it("never lifts a returned snooze whose thread was replied to and then deleted, or an old snooze with no flag", async () => {
      const inboxKeys = async () => (await listThreads(owner, { view: { role: "inbox" }, limit: 100 })).threads.map((item) => item.key);
      await seed({ thread: "ret-deleted", folder: "inbox", at: new Date(Date.now() - 2 * DAY), provider: "ret-deleted-1" });
      await applyMailAction(owner, { thread: thread("ret-deleted"), action: "snooze", view: { role: "inbox" }, until: until() }, outlook().fetchImpl);
      await admin().query("update crm.mail_reminders set due_at = now() - interval '1 minute' where thread_key = 'ret-deleted' and state = 'waiting'");
      await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: null });
      await seed({ thread: "ret-deleted", folder: "sent", at: new Date(Date.now() - 1000), provider: "ret-deleted-reply", from: "mark@eclipse.test", read: true });
      assert.ok((await inboxKeys()).includes(thread("ret-deleted")));
      await admin().query("update crm.mail_messages set folder_id = $1 where provider_message_id = 'ret-deleted-1'", [await folderId("trash")]);
      assert.ok(!(await inboxKeys()).includes(thread("ret-deleted")), "deleted outside Orbit, the sent reply does not bring it back");
      const junk = (
        await admin().query<{ id: string }>(
          "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'f-junk', 'Junk', 'junk') returning id",
          [owner.workspaceId, owner.userId, sourceId],
        )
      ).rows[0].id;
      await admin().query("update crm.mail_messages set folder_id = $1 where provider_message_id = 'ret-deleted-1'", [junk]);
      assert.ok(!(await inboxKeys()).includes(thread("ret-deleted")));

      await seed({ thread: "ret-unflagged", folder: "sent", at: new Date(Date.now() - 20 * DAY), provider: "ret-unflagged-1", from: "mark@eclipse.test", read: true });
      await admin().query(
        `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, subject, state, surfaced_at)
         values ($1, $2, $3, 'ret-unflagged', 'snooze', now() - interval '20 days', 'Old', 'due', now() - interval '20 days')`,
        [owner.workspaceId, owner.userId, sourceId],
      );
      assert.ok(!(await inboxKeys()).includes(thread("ret-unflagged")), "a due snooze made before the flag existed is never lifted");
    });

    it("closes a returning snooze quietly when its thread has been moved out of sight", async () => {
      const pushed = async (key: string) => (await admin().query<{ id: string }>("select r.id from crm.mail_reminders r join crm.push_log l on l.key = 'snooze:' || r.id where r.thread_key = $1", [key])).rowCount;
      await seed({ thread: "ret-vanished", folder: "inbox", at: new Date(Date.now() - DAY), provider: "ret-vanished-1" });
      await seed({ thread: "ret-control", folder: "inbox", at: new Date(Date.now() - DAY), provider: "ret-control-1" });
      for (const key of ["ret-vanished", "ret-control"]) {
        await applyMailAction(owner, { thread: thread(key), action: "snooze", view: { role: "inbox" }, until: until() }, outlook().fetchImpl);
      }
      await admin().query("update crm.mail_messages set folder_id = $1 where provider_message_id = 'ret-vanished-1'", [await folderId("archive")]);
      await admin().query("update crm.mail_reminders set due_at = now() - interval '1 minute' where thread_key in ('ret-vanished', 'ret-control') and state = 'waiting'");
      const report = await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: null });
      assert.equal(report.returned, 1, "only the visible one counts as returned");
      assert.equal((await reminders("ret-vanished"))[0].state, "done");
      assert.equal(await pushed("ret-vanished"), 0, "no alert for something nobody can see");
      assert.equal((await reminders("ret-control"))[0].state, "due");
      assert.equal(await pushed("ret-control"), 1);
    });

    it("says so, and sets no reminder, when the thread is only in Trash", async () => {
      await seed({ thread: "snz-trash", folder: "trash", at: new Date(Date.now() - DAY), provider: "snz-trash-1" });
      const box = outlook();
      await assert.rejects(
        () => applyMailAction(owner, { thread: thread("snz-trash"), action: "snooze", until: until() }, box.fetchImpl),
        /Couldn't set a reminder\. Move the conversation out of Trash or Junk first\./,
      );
      assert.deepEqual(box.writes(), []);
      assert.deepEqual(await reminders("snz-trash"), []);
    });
  });

  describe("long threads", () => {
    it("archives, reads, flags and unreads the newest messages of a thread past the old limits", async () => {
      await seedMany("long-act", "inbox", 130);
      const archived = outlook();
      const result = await applyMailAction(owner, { thread: thread("long-act"), action: "archive", view: { role: "inbox" } }, archived.fetchImpl);
      assert.deepEqual(result, { changed: 130, failed: 0, problem: null });
      assert.equal((await admin().query("select 1 from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where m.thread_key = 'long-act' and f.role = 'inbox'")).rowCount, 0);

      await seedMany("long-read", "inbox", 250);
      const read = await applyMailAction(owner, { thread: thread("long-read"), action: "read", view: { role: "inbox" } }, outlook().fetchImpl);
      assert.equal(read.changed, 250);
      assert.equal((await admin().query("select 1 from crm.mail_messages where thread_key = 'long-read' and not is_read")).rowCount, 0);

      await applyMailAction(owner, { thread: thread("long-read"), action: "flag", view: { role: "inbox" } }, outlook().fetchImpl);
      assert.deepEqual((await admin().query<{ provider_message_id: string }>("select provider_message_id from crm.mail_messages where thread_key = 'long-read' and is_flagged")).rows.map((row) => row.provider_message_id), ["long-read-250"]);
      await applyMailAction(owner, { thread: thread("long-read"), action: "unread", view: { role: "inbox" } }, outlook().fetchImpl);
      assert.deepEqual((await admin().query<{ provider_message_id: string }>("select provider_message_id from crm.mail_messages where thread_key = 'long-read' and not is_read")).rows.map((row) => row.provider_message_id), ["long-read-250"]);
    });

    it("shows the newest 200 messages of a long thread, oldest first", async () => {
      await seedMany("long-reader", "inbox", 260);
      const detail = await getThread(owner, thread("long-reader"));
      assert.equal(detail.messages.length, 200);
      const times = detail.messages.map((message) => new Date(message.at!).getTime());
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
      const newest = (await admin().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'long-reader-260'")).rows[0].id;
      assert.equal(detail.messages.at(-1)!.id, newest);
      assert.equal(detail.messages[0].text, "Body 61");
    });

    it("reads the newest messages for summaries and ignores drafts when counting them", async () => {
      await seedMany("long-text", "inbox", 210, { draftsAfter: 5 });
      const text = await withActor(owner, (db) => threadText(db, owner, sourceId, "long-text"));
      assert.equal(text.messages.length, 200);
      const newest = (await admin().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'long-text-210'")).rows[0].id;
      assert.equal(text.messages.at(-1)!.id, newest);
      assert.equal(text.subject, "Long thread");
    });

    it("gives agents the newest 100 messages of a long thread, oldest first", async () => {
      await seedMany("long-agent", "inbox", 150);
      const anchor = (await admin().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'long-agent-1'")).rows[0].id;
      const messages = await getMailThread(owner, anchor);
      assert.equal(messages.length, 100);
      const times = messages.map((message) => new Date(message.receivedAt!).getTime());
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
      const newest = (await admin().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'long-agent-150'")).rows[0].id;
      assert.equal(messages.at(-1)!.id, newest);
    });
  });

  describe("reader text", () => {
    it("leaves out the plain text when reader mode has the HTML, and keeps it when the HTML cleans to nothing", async () => {
      await seed({ thread: "reader-text", folder: "inbox", at: new Date(Date.now() - 3 * DAY), provider: "reader-text-1", html: "<p>Rich <b>words</b></p>", text: "Plain words" });
      await seed({ thread: "reader-text", folder: "inbox", at: new Date(Date.now() - 2 * DAY), provider: "reader-text-2", html: "<script>alert(1)</script>", text: "Only text survives" });
      await seed({ thread: "reader-text", folder: "inbox", at: new Date(Date.now() - DAY), provider: "reader-text-3", html: null, text: "No html here" });
      const reader = await getThread(owner, thread("reader-text"), { reader: true });
      assert.deepEqual(reader.messages.map((message) => message.text), [null, "Only text survives", "No html here"]);
      assert.match(reader.messages[0].html ?? "", /Rich/);
      const full = await getThread(owner, thread("reader-text"));
      assert.deepEqual(full.messages.map((message) => message.text), ["Plain words", "Only text survives", "No html here"]);
    });
  });

  describe("thread list pages", () => {
    const stamp = (days: number) => new Date(Date.now() - days * DAY);
    const compare = (summaries: ThreadSummary[]) => summaries.map((item) => ({ ...item }));

    async function pages(view: Parameters<typeof listThreads>[1]["view"], limit: number) {
      const out: ThreadSummary[] = [];
      let before: ThreadCursor | null = null;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await listThreads(owner, { view, limit, before });
        out.push(...page.threads);
        if (!page.next) return out;
        before = page.next;
      }
      throw new Error("The pages never ended.");
    }

    before(async () => {
      const ages = [0.5, 1, 2, 3, 3, 5, 6, 8, 13, 20, 33, 47, 60, 61, 90, 150, 200, 300, 420, 470, 520, 900];
      for (const [index, age] of ages.entries()) {
        const key = `page-${index}`;
        await seed({ thread: key, folder: "archive", at: stamp(age), provider: `${key}-latest` });
        if (index % 3 === 0) await seed({ thread: key, folder: "archive", at: stamp(age + 40), provider: `${key}-older`, read: true });
        if (index % 4 === 0) await seed({ thread: key, folder: "inbox", at: stamp(age + 1), provider: `${key}-inbox` });
      }
      await seed({ thread: "page-straddle", folder: "archive", at: stamp(2.5), provider: "page-straddle-new" });
      await seed({ thread: "page-straddle", folder: "archive", at: stamp(700), provider: "page-straddle-old" });
      const tie = stamp(10);
      await seed({ thread: "page-tie-a", folder: "archive", at: tie, provider: "page-tie-a-1" });
      await seed({ thread: "page-tie-b", folder: "archive", at: tie, provider: "page-tie-b-1" });
      await seed({ thread: "page-tie-c", folder: "archive", at: tie, provider: "page-tie-c-1" });
      await seed({ thread: "page-bumped", folder: "archive", at: stamp(800), provider: "page-bumped-1" });
      await admin().query(
        `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, subject, state, surfaced_at)
         values ($1, $2, $3, 'page-bumped', 'follow_up', now() - interval '2 hours', 'Bumped', 'due', now() - interval '1 hour')`,
        [owner.workspaceId, owner.userId, sourceId],
      );
      await seed({ thread: "sent-null", folder: "sent", at: null, sentAt: stamp(4), provider: "sent-null-1", from: "mark@eclipse.test", read: true });
      for (const [index, age] of [1, 9, 30, 120, 500].entries()) {
        await seed({ thread: `sent-${index}`, folder: "sent", at: stamp(age), provider: `sent-${index}-1`, from: "mark@eclipse.test", read: true });
      }
    });

    it("lists Archive page by page exactly as one long page", async () => {
      const whole = await listThreads(owner, { view: { role: "archive" }, limit: 100 });
      assert.equal(whole.next, null);
      assert.ok(whole.threads.length >= 26);
      const keys = whole.threads.map((item) => item.key);
      assert.ok(keys.indexOf(thread("page-bumped")) < keys.indexOf(thread("page-0")), "a surfaced reminder lifts an old thread above newer ones");
      assert.ok(keys.indexOf(thread("page-straddle")) < keys.indexOf(thread("page-8")), "a thread sorts by its newest message, not its oldest");
      assert.equal(whole.threads.find((item) => item.key === thread("page-straddle"))!.count, 2);
      assert.equal(whole.threads.find((item) => item.key === thread("page-0"))!.count, 2, "counts cover the whole thread in the folder");
      for (const size of [1, 2, 3, 4, 7, 11]) {
        assert.deepEqual(compare(await pages({ role: "archive" }, size)), compare(whole.threads), `pages of ${size}`);
      }
    });

    it("lists Sent, including mail with no received time, and a chosen folder page by page", async () => {
      const sent = await listThreads(owner, { view: { role: "sent" }, limit: 100 });
      const at = sent.threads.filter((item) => !item.reminder).map((item) => new Date(item.latestAt!).getTime());
      assert.deepEqual(at, [...at].sort((x, y) => y - x));
      assert.ok(sent.threads.length >= 6);
      assert.ok(sent.threads.some((item) => item.key === thread("sent-null")));
      for (const size of [1, 2, 4]) {
        assert.deepEqual(compare(await pages({ role: "sent" }, size)), compare(sent.threads), `sent pages of ${size}`);
      }
      const archive = await folderId("archive");
      const chosen = await listThreads(owner, { view: { folderId: archive }, limit: 100 });
      assert.deepEqual(compare(await pages({ folderId: archive }, 5)), compare(chosen.threads));
    });

    it("keeps the same order after a cursor deep in the folder", async () => {
      const whole = await listThreads(owner, { view: { role: "archive" }, limit: 100 });
      const cut = whole.threads[10];
      const rest = await listThreads(owner, { view: { role: "archive" }, limit: 100, before: { at: cut.latestAt!, key: cut.key } });
      assert.deepEqual(compare(rest.threads), compare(whole.threads.slice(11)));
    });
  });
});
