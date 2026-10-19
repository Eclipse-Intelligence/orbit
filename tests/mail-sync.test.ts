import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { getMailThread, mailSyncStatus, searchMail } from "@/lib/mail/store";
import { syncMail } from "@/lib/mail/sync";
import { htmlToText } from "@/lib/mail/text";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

type Page = { value: unknown[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: "conv-renewal",
    subject: "Renewal pricing",
    bodyPreview: "Can we talk about the renewal price?",
    body: { contentType: "html", content: "<html><head><style>p{}</style></head><body><p>Can we talk about the <b>renewal</b> price&nbsp;for 2027?</p></body></html>" },
    from: { emailAddress: { name: "Jane Doe", address: "Jane@Acme.test" } },
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

function mailbox(pages: Record<string, Page | (() => Response)>) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", deleteditems: "f-trash", junkemail: "f-junk" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: [
          { id: "f-inbox", displayName: "Inbox", childFolderCount: 0, totalItemCount: 3, unreadItemCount: 2 },
          { id: "f-sent", displayName: "Sent Items", childFolderCount: 0, totalItemCount: 1, unreadItemCount: 0 },
          { id: "f-junk", displayName: "Junk Email", childFolderCount: 0, totalItemCount: 9, unreadItemCount: 9 },
          { id: "f-clients", displayName: "Clients", childFolderCount: 1, totalItemCount: 0, unreadItemCount: 0 },
        ],
      });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders/f-clients/childFolders`)) {
      return Response.json({ value: [{ id: "f-acme", displayName: "Acme", parentFolderId: "f-clients", childFolderCount: 0, totalItemCount: 0 }] });
    }
    const delta = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/);
    const key = delta && !url.includes("token=") ? `start:${delta[1]}` : url;
    const page = pages[key];
    if (!page) return Response.json({ value: [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${delta?.[1] ?? "x"}/messages/delta?$deltatoken=done` });
    return typeof page === "function" ? page() : Response.json(page);
  };
  return { fetchImpl, calls };
}

describe("mail mirror", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mail@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, {
      email: "mark@eclipse.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(() => {
    delete process.env.MAIL_STORAGE_LIMIT_MB;
  });

  after(async () => {
    await getPool().end();
  });

  it("turns email HTML into searchable text", () => {
    assert.equal(htmlToText("<style>x{}</style><p>Hi&nbsp;Jane,</p><p>Price: &pound;5 &amp; terms</p><ul><li>One</li></ul>"), "Hi Jane,\nPrice: &pound;5 & terms\n- One");
  });

  it("backfills every folder newest first, then keeps each folder live", async () => {
    const first = mailbox({
      "start:f-inbox": {
        value: [message("m-3", { receivedDateTime: "2026-10-03T09:00:00Z", subject: "Re: Renewal pricing" }), message("m-2", { receivedDateTime: "2026-10-02T09:00:00Z" })],
        "@odata.nextLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$skiptoken=page2`,
      },
      [`${GRAPH}/me/mailFolders/f-inbox/messages/delta?$skiptoken=page2`]: {
        value: [message("m-1", { conversationId: "conv-intro", subject: "Introduction", body: { contentType: "html", content: "<p>Meet our CFO</p>" } })],
        "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=inbox1`,
      },
      "start:f-sent": {
        value: [message("s-1", { from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } }, subject: "Re: Renewal pricing", receivedDateTime: "2026-10-02T12:00:00Z", isRead: true })],
        "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-sent/messages/delta?$deltatoken=sent1`,
      },
    });
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: first.fetchImpl });
    assert.deepEqual(report.errors, []);
    assert.equal(report.stored, 4);
    assert.ok(first.calls.some((url) => url.includes("$orderby=receivedDateTime%20desc")));
    assert.ok(!first.calls.some((url) => url.includes("f-junk/messages")));

    const status = await mailSyncStatus(owner);
    assert.equal(status.length, 1);
    assert.equal(status[0].stored, 4);
    assert.deepEqual(
      status[0].folders.map((folder) => [folder.name, folder.role, folder.state, folder.stored]),
      [
        ["Acme", "other", "live", 0],
        ["Clients", "other", "live", 0],
        ["Inbox", "inbox", "live", 3],
        ["Sent Items", "sent", "live", 1],
      ],
    );

    const found = await searchMail(owner, { query: "renewal price" });
    assert.equal(found.length, 3);
    assert.equal(found.find((item) => item.subject === "Renewal pricing")?.from?.address, "jane@acme.test");
    const thread = await getMailThread(owner, found.find((item) => item.subject === "Renewal pricing")!.id);
    assert.deepEqual(
      thread.map((item) => item.folderRole),
      ["inbox", "sent", "inbox"],
    );
    assert.match(thread[0].bodyText ?? "", /renewal price for 2027/);

    const later = mailbox({
      [`${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=inbox1`]: {
        value: [
          { id: "m-2", isRead: true, flag: { flagStatus: "flagged" } },
          { id: "m-1", "@removed": { reason: "deleted" } },
          message("m-4", { subject: "Contract signed", conversationId: "conv-contract", receivedDateTime: "2026-10-04T09:00:00Z" }),
        ],
        "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=inbox2`,
      },
    });
    const second = await syncMail(owner, { budgetMs: 30_000, fetchImpl: later.fetchImpl, backfill: false });
    assert.equal(second.stored, 1);
    assert.equal(second.removed, 1);
    assert.ok(!later.calls.some((url) => url.includes("/mailFolders?$top=100")));
    const inbox = await searchMail(owner, { folder: "inbox" });
    assert.deepEqual(
      inbox.map((item) => [item.subject, item.isRead, item.isFlagged]),
      [
        ["Contract signed", false, false],
        ["Re: Renewal pricing", false, false],
        ["Renewal pricing", true, true],
      ],
    );
  });

  it("pauses the backfill at the storage limit, restarts an expired sync and keeps mail private", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_folders set sync_state = 'pending', sync_link = null where role = 'sent'");
    process.env.MAIL_STORAGE_LIMIT_MB = "1";
    const capped = mailbox({
      "start:f-sent": {
        value: [message("s-2", { subject: "Proposal", receivedDateTime: "2026-09-01T09:00:00Z" })],
        "@odata.nextLink": `${GRAPH}/me/mailFolders/f-sent/messages/delta?$skiptoken=more`,
      },
      [`${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=inbox2`]: () =>
        Response.json({ error: { code: "SyncStateNotFound", message: "Expired" } }, { status: 410 }),
    });
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: capped.fetchImpl });
    assert.equal(report.paused, true);
    assert.ok(!capped.calls.some((url) => url.includes("skiptoken=more")));
    const folders = await admin.query<{ role: string; sync_state: string; sync_link: string | null; last_error: string | null }>(
      "select role, sync_state, sync_link, last_error from crm.mail_folders where role in ('inbox', 'sent') order by role",
    );
    assert.deepEqual(
      folders.rows.map((row) => [row.role, row.sync_state, row.sync_link]),
      [
        ["inbox", "pending", null],
        ["sent", "backfill", `${GRAPH}/me/mailFolders/f-sent/messages/delta?$skiptoken=more`],
      ],
    );
    assert.match(folders.rows[1].last_error ?? "", /MAIL_STORAGE_LIMIT_MB/);

    const stranger = await createUser("stranger@orbit.test", "Someone Else");
    assert.deepEqual(await searchMail(stranger, { query: "renewal" }), []);
    const theirs = await admin.query<{ id: string }>("select id from crm.mail_messages limit 1");
    await assert.rejects(getMailThread(stranger, theirs.rows[0].id), /Email not found/);
  });

  it("syncs extra accounts that are allowed to send, and lets the assistant search and read threads", async () => {
    const admin = getAdminPool();
    await admin.query(
      `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, access_token, access_token_expires_at, can_send)
       values ($1, $2, 'microsoft', 'mark@consulting.test', 'connected', $3, $4, now() + interval '1 hour', true)`,
      [owner.workspaceId, owner.userId, encryptSecret("acct-refresh"), encryptSecret("acct-access")],
    );
    const box = mailbox({
      "start:f-inbox": {
        value: [message("c-1", { subject: "Consulting kickoff", conversationId: "conv-kickoff", from: { emailAddress: { name: "Ola", address: "ola@client.test" } } })],
        "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=c1`,
      },
    });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: box.fetchImpl });
    const status = await mailSyncStatus(owner);
    assert.deepEqual(
      status.map((item) => item.email),
      ["mark@eclipse.test", "mark@consulting.test"],
    );

    const searched = (await runTool(owner, "search_email", { query: "kickoff", account: "mark@consulting.test" })) as { emails: { id: string; account: string }[] };
    assert.equal(searched.emails.length, 1);
    assert.equal(searched.emails[0].account, "mark@consulting.test");
    const thread = (await runTool(owner, "get_email_thread", { emailId: searched.emails[0].id })) as { messages: { subject: string }[] };
    assert.equal(thread.messages[0].subject, "Consulting kickoff");
  });
});
