import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { applyMailAction } from "@/lib/mail/actions";
import { threadText } from "@/lib/mail/ai";
import { getMailThread } from "@/lib/mail/store";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads } from "@/lib/mail/threads";
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
      assert.equal(whole.threads[0].key, thread("page-bumped"), "a surfaced reminder lifts an old thread to the top");
      const keys = whole.threads.map((item) => item.key);
      assert.ok(keys.indexOf(thread("page-straddle")) < keys.indexOf(thread("page-8")), "a thread sorts by its newest message, not its oldest");
      assert.equal(whole.threads.find((item) => item.key === thread("page-straddle"))!.count, 2);
      assert.equal(whole.threads.find((item) => item.key === thread("page-0"))!.count, 2, "counts cover the whole thread in the folder");
      for (const size of [1, 2, 3, 4, 7, 11]) {
        assert.deepEqual(compare(await pages({ role: "archive" }, size)), compare(whole.threads), `pages of ${size}`);
      }
    });

    it("lists Sent, including mail with no received time, and a chosen folder page by page", async () => {
      const sent = await listThreads(owner, { view: { role: "sent" }, limit: 100 });
      const at = sent.threads.map((item) => new Date(item.latestAt!).getTime());
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
