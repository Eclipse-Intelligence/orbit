import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { applyMailAction } from "@/lib/mail/actions";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads, mailNav, mailUnreadCount, mailVersion } from "@/lib/mail/threads";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: "conv-pricing",
    subject: "Pricing",
    bodyPreview: "Can we talk about pricing?",
    body: { contentType: "html", content: `<p>${"Can we talk about pricing for the next year? ".repeat(10)}</p>` },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: "2026-10-01T09:00:00Z",
    receivedDateTime: "2026-10-01T09:00:05Z",
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

const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", archive: "f-archive", deleteditems: "f-trash" };

function outlook(pages: Record<string, unknown[]>, calls: string[] = []) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method !== "GET") {
      const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
      if (url.endsWith("/move")) {
        const destination = String((JSON.parse(String(init?.body)) as { destinationId: string }).destinationId);
        return Response.json({ id, parentFolderId: FOLDERS[destination] }, { status: 201 });
      }
      return Response.json({ id });
    }
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: [
          { id: "f-inbox", displayName: "Inbox", childFolderCount: 0, totalItemCount: 3, unreadItemCount: 3 },
          { id: "f-sent", displayName: "Sent Items", childFolderCount: 0, totalItemCount: 1 },
          { id: "f-drafts", displayName: "Drafts", childFolderCount: 0, totalItemCount: 0 },
          { id: "f-archive", displayName: "Archive", childFolderCount: 0, totalItemCount: 0 },
          { id: "f-trash", displayName: "Deleted Items", childFolderCount: 0, totalItemCount: 0 },
        ],
      });
    }
    if (/\/me\/messages\/[^/]+\/attachments/.test(url)) {
      return Response.json({
        value: [
          { id: "att-1", name: "Terms.pdf", contentType: "application/pdf", size: 2048, isInline: false },
          { id: "att-2", name: "logo.png", contentType: "image/png", size: 10, isInline: true },
        ],
      });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const value = folder && !url.includes("token=") ? (pages[folder] ?? []) : [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=done` });
  };
  return fetchImpl;
}

async function sentThreads(actor: UserActor) {
  return withActor(actor, async (db) => (await db.query<{ thread_key: string }>("select thread_key from crm.mail_sent_threads order by thread_key")).rows.map((row) => row.thread_key));
}

describe("mail speed", () => {
  let owner: UserActor;
  let other: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mail-speed@orbit.test", "Mark Ridgeon");
    other = await createUser("mail-speed-other@orbit.test", "Someone Else");
    await saveMailbox(owner, {
      email: "mark@eclipse.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await createContact(owner, { firstName: "Priya", lastName: "Patel", email: "priya@client.test" });
    const report = await syncMail(owner, {
      budgetMs: 30_000,
      fetchImpl: outlook({
        "f-inbox": [
          message("m-2", { subject: "Re: Pricing", receivedDateTime: "2026-10-03T09:00:00Z", inferenceClassification: "other" }),
          message("m-1", { receivedDateTime: "2026-10-01T09:00:00Z", inferenceClassification: "other" }),
          message("m-news", {
            conversationId: null,
            subject: "Weekly digest",
            from: { emailAddress: { name: "News", address: "newsletter@digest.test" } },
            receivedDateTime: "2026-10-02T09:00:00Z",
          }),
          message("m-priya", {
            conversationId: "conv-priya",
            subject: "Contract",
            from: { emailAddress: { name: "Priya", address: "priya@client.test" } },
            receivedDateTime: "2026-10-02T10:00:00Z",
            hasAttachments: true,
          }),
          message("m-cold", {
            conversationId: "conv-cold",
            subject: "Quick question",
            from: { emailAddress: { name: "Sam", address: "sam@stranger.test" } },
            receivedDateTime: "2026-10-02T11:00:00Z",
            isRead: true,
            inferenceClassification: "other",
          }),
        ],
        "f-sent": [
          message("s-1", {
            subject: "Re: Pricing",
            from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
            receivedDateTime: "2026-10-02T12:00:00Z",
            isRead: true,
          }),
        ],
      }),
    });
    assert.deepEqual(report.errors, []);
  });

  after(async () => {
    await getPool().end();
  });

  it("gives every message a thread key, even when Outlook sends none or old code writes null", async () => {
    const admin = getAdminPool();
    const news = await admin.query<{ id: string; thread_key: string }>("select id, thread_key from crm.mail_messages where provider_message_id = 'm-news'");
    assert.equal(news.rows[0].thread_key, `m:${news.rows[0].id}`);
    await admin.query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject)
       select m.workspace_id, m.user_id, m.source_id, m.folder_id, 'm-news', null, 'Weekly digest again' from crm.mail_messages m where m.id = $1
       on conflict (source_id, provider_message_id) do update set thread_key = excluded.thread_key, subject = excluded.subject`,
      [news.rows[0].id],
    );
    const again = await admin.query<{ id: string; thread_key: string; subject: string }>("select id, thread_key, subject from crm.mail_messages where provider_message_id = 'm-news'");
    assert.deepEqual(again.rows, [{ id: news.rows[0].id, thread_key: `m:${news.rows[0].id}`, subject: "Weekly digest again" }]);
    const nulls = await admin.query<{ attnotnull: boolean }>(
      "select attnotnull from pg_attribute where attrelid = 'crm.mail_messages'::regclass and attname = 'thread_key'",
    );
    assert.equal(nulls.rows[0].attnotnull, true);
  });

  it("keeps the threads you have written in, and the splits that come from them", async () => {
    assert.deepEqual(await sentThreads(owner), ["conv-pricing"]);
    assert.deepEqual(await sentThreads(other), []);
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    const splits = Object.fromEntries(inbox.threads.map((thread) => [thread.subject, thread.split]));
    assert.deepEqual(splits, { "Re: Pricing": "important", "Quick question": "other", Contract: "important", "Weekly digest again": "news" });
    const splitOf = async (subject: string) => (await listThreads(owner, { view: { role: "inbox" } })).threads.find((thread) => thread.subject === subject)?.split;

    const admin = getAdminPool();
    await admin.query("delete from crm.mail_messages where provider_message_id = 's-1'");
    assert.deepEqual(await sentThreads(owner), []);
    const sentFolder = await admin.query<{ id: string }>("select id from crm.mail_folders where provider_folder_id = 'f-sent'");
    await admin.query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, from_email, is_read)
       select m.workspace_id, m.user_id, m.source_id, $1, 's-cold', 'conv-cold', 'Re: Quick question', 'mark@eclipse.test', true
       from crm.mail_messages m where m.provider_message_id = 'm-cold'`,
      [sentFolder.rows[0].id],
    );
    assert.deepEqual(await sentThreads(owner), ["conv-cold"]);
    assert.equal(await splitOf("Re: Pricing"), "other");
    assert.equal(await splitOf("Quick question"), "important");
    await admin.query("update crm.mail_folders set role = 'other' where id = $1", [sentFolder.rows[0].id]);
    assert.deepEqual(await sentThreads(owner), []);
    assert.equal(await splitOf("Quick question"), "other");
    await admin.query("update crm.mail_folders set role = 'sent' where id = $1", [sentFolder.rows[0].id]);
    assert.deepEqual(await sentThreads(owner), ["conv-cold"]);
  });

  it("counts unread important mail for the badge the same way the nav does", async () => {
    const nav = await mailNav(owner);
    const fromNav = nav.splits.filter((row) => row.split === "important").reduce((sum, row) => sum + row.unread, 0);
    assert.equal(fromNav, 1);
    assert.equal(await mailUnreadCount(owner), fromNav);
    assert.equal(await mailUnreadCount(other), 0);
    assert.equal(nav.folders.find((folder) => folder.role === "inbox")?.unread, 3);
  });

  it("moves the mail version on every change and only then", async () => {
    const start = await mailVersion(owner);
    assert.equal(await mailVersion(owner), start);
    assert.equal((await mailNav(owner)).version, start);
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    const contract = inbox.threads.find((thread) => thread.subject === "Contract")!;
    await applyMailAction(owner, { thread: contract.key, action: "read", view: { role: "inbox" } }, outlook({}));
    const afterRead = await mailVersion(owner);
    assert.equal(Number(afterRead), Number(start) + 1);
    assert.equal(await mailVersion(other), "0");
    await withActor(owner, (db) => db.query("select 1 from crm.mail_messages where user_id = $1", [owner.userId]));
    assert.equal(await mailVersion(owner), afterRead);
    assert.equal(await mailUnreadCount(owner), 0);
    const visible = await withActor(other, async (db) => (await db.query("select * from crm.mail_versions")).rowCount);
    assert.equal(visible, 0);
  });

  it("sends the reader only what it renders, with the stored summary and the attachments", async () => {
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    const contract = inbox.threads.find((thread) => thread.subject === "Contract")!;
    const full = await getThread(owner, contract.key);
    assert.ok(full.messages[0].text);
    assert.equal(full.cachedSummary, undefined);
    assert.equal(full.messages[0].attachments, undefined);

    const previous = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "test-key";
    try {
      const calls: string[] = [];
      const reader = await getThread(owner, contract.key, { reader: true, attachments: true, fetchImpl: outlook({}, calls) });
      assert.equal(reader.messages[0].text, null);
      assert.ok(reader.messages[0].html);
      assert.equal(reader.cachedSummary, null);
      assert.deepEqual(reader.messages[0].attachments, [{ id: "att-1", name: "Terms.pdf", contentType: "application/pdf", size: 2048 }]);
      assert.equal(calls.filter((call) => call.includes("/attachments")).length, 1);

      const admin = getAdminPool();
      await admin.query(
        `insert into crm.mail_summaries (workspace_id, user_id, source_id, thread_key, latest_message_id, summary, todo)
         values ($1, $2, $3, 'conv-priya', $4, 'Priya sent the contract.', 'Sign it')`,
        [owner.workspaceId, owner.userId, contract.sourceId, contract.latestId],
      );
      const summarised = await getThread(owner, contract.key, { reader: true });
      assert.deepEqual(summarised.cachedSummary, { latestId: contract.latestId, summary: "Priya sent the contract.", todo: "Sign it" });
      assert.equal(summarised.messages[0].attachments, undefined);

      const cold = inbox.threads.find((thread) => thread.subject === "Quick question")!;
      const short = await getThread(owner, cold.key, { reader: true });
      assert.equal(short.cachedSummary, null);
    } finally {
      if (previous === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previous;
    }
    delete process.env.LLM_API_KEY;
    const noAi = await getThread(owner, contract.key, { reader: true });
    assert.deepEqual(noAi.cachedSummary, { latestId: contract.latestId, summary: null, todo: null });
  });

  it("lists a due follow-up from the archive in the inbox", async () => {
    const admin = getAdminPool();
    const archive = await admin.query<{ id: string }>("select id from crm.mail_folders where provider_folder_id = 'f-archive'");
    const priya = await admin.query<{ source_id: string }>("update crm.mail_messages set folder_id = $1 where provider_message_id = 'm-priya' returning source_id", [archive.rows[0].id]);
    let inbox = await listThreads(owner, { view: { role: "inbox" } });
    assert.equal(inbox.threads.some((thread) => thread.subject === "Contract"), false);
    await admin.query(
      `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, state, surfaced_at)
       values ($1, $2, $3, 'conv-priya', 'follow_up', now(), 'due', now())`,
      [owner.workspaceId, owner.userId, priya.rows[0].source_id],
    );
    inbox = await listThreads(owner, { view: { role: "inbox" } });
    const contract = inbox.threads.find((thread) => thread.subject === "Contract");
    assert.equal(contract?.reminder?.kind, "follow_up");
    assert.equal(inbox.threads[0].subject, "Contract");
    const important = await listThreads(owner, { view: { role: "inbox", split: "important" } });
    assert.equal(important.threads[0].subject, "Contract");
  });
});
