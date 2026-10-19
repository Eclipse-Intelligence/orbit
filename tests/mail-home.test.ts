import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { applyMailAction } from "@/lib/mail/actions";
import { cleanEmailHtml, richEmail } from "@/lib/mail/html";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads, mailNav, mailUnreadCount } from "@/lib/mail/threads";
import { readMailView, readThreadCursor } from "@/lib/mail/view";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: "conv-renewal",
    subject: "Renewal pricing",
    bodyPreview: "Can we talk about the renewal price?",
    body: { contentType: "html", content: "<p onclick=\"steal()\">Renewal price</p><script>alert(1)</script>" },
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

const FOLDERS: Record<string, string> = {
  inbox: "f-inbox",
  sentitems: "f-sent",
  drafts: "f-drafts",
  archive: "f-archive",
  deleteditems: "f-trash",
};

type Write = { method: string; url: string; body: Record<string, unknown> };

function outlook(options: { refuse?: boolean } = {}) {
  const writes: Write[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, url, body: JSON.parse(String(init?.body ?? "{}")) });
      if (options.refuse) return Response.json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, { status: 403 });
      const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
      if (url.endsWith("/move")) {
        const destination = String((JSON.parse(String(init?.body)) as { destinationId: string }).destinationId);
        return Response.json({ id, parentFolderId: FOLDERS[destination] }, { status: 201 });
      }
      return Response.json({ id });
    }
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: [
          { id: "f-inbox", displayName: "Inbox", childFolderCount: 0, totalItemCount: 3, unreadItemCount: 3 },
          { id: "f-sent", displayName: "Sent Items", childFolderCount: 0, totalItemCount: 1 },
          { id: "f-drafts", displayName: "Drafts", childFolderCount: 0, totalItemCount: 0 },
          { id: "f-archive", displayName: "Archive", childFolderCount: 0, totalItemCount: 0 },
          { id: "f-trash", displayName: "Deleted Items", childFolderCount: 0, totalItemCount: 0 },
          { id: "f-clients", displayName: "Clients", childFolderCount: 0, totalItemCount: 0 },
        ],
      });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = {
      "f-inbox": [
        message("m-3", { subject: "Re: Renewal pricing", receivedDateTime: "2026-10-03T09:00:00Z" }),
        message("m-2", { receivedDateTime: "2026-10-02T09:00:00Z" }),
        message("m-1", { conversationId: "conv-intro", subject: "Introduction", bodyPreview: "Meet our CFO", receivedDateTime: "2026-09-30T09:00:00Z" }),
      ],
      "f-sent": [
        message("s-1", {
          subject: "Re: Renewal pricing",
          from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
          receivedDateTime: "2026-10-02T12:00:00Z",
          isRead: true,
        }),
      ],
    };
    const value = folder && !url.includes("token=") ? (pages[folder] ?? []) : [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=done` });
  };
  return { fetchImpl, writes };
}

describe("mail home", () => {
  let owner: UserActor;
  let other: UserActor;
  let renewal: string;
  let intro: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mail-home@orbit.test", "Mark Ridgeon");
    other = await createUser("other-mail@orbit.test", "Someone Else");
    await saveMailbox(owner, {
      email: "mark@eclipse.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    assert.deepEqual(report.errors, []);
    assert.equal(report.stored, 4);
  });

  after(async () => {
    await getPool().end();
  });

  it("strips scripts and handlers from email HTML and spots designed emails", () => {
    const cleaned = cleanEmailHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="cid:logo"><iframe src="https://x.test"></iframe><base href="https://x.test">');
    assert.equal(cleaned, "<p>Hi</p><a>x</a>");
    assert.equal(richEmail('<table width="600" bgcolor="#fff"><tr><td>x</td></tr></table>'), true);
    assert.equal(richEmail("<div>Plain reply</div>"), false);
  });

  it("reads views and cursors from the URL", () => {
    assert.deepEqual(readMailView("sent"), { role: "sent" });
    assert.deepEqual(readMailView("junk"), { role: "inbox" });
    assert.deepEqual(readMailView("folder:abc"), { folderId: "abc" });
    assert.deepEqual(readThreadCursor("2026-10-01T00:00:00.000Z~a|b"), { at: "2026-10-01T00:00:00.000Z", key: "a|b" });
    assert.equal(readThreadCursor("nonsense"), null);
  });

  it("groups the inbox into conversations, newest first, with paging", async () => {
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    assert.equal(inbox.next, null);
    assert.deepEqual(
      inbox.threads.map((thread) => [thread.subject, thread.count, thread.unread]),
      [
        ["Re: Renewal pricing", 2, true],
        ["Introduction", 1, true],
      ],
    );
    renewal = inbox.threads[0].key;
    intro = inbox.threads[1].key;
    assert.equal(inbox.threads[0].account, "mark@eclipse.test");

    const first = await listThreads(owner, { view: { role: "inbox" }, limit: 1 });
    assert.equal(first.threads.length, 1);
    assert.ok(first.next);
    const second = await listThreads(owner, { view: { role: "inbox" }, limit: 1, before: first.next });
    assert.deepEqual(second.threads.map((thread) => thread.key), [intro]);
    assert.equal(second.next, null);

    const sent = await listThreads(owner, { view: { role: "sent" } });
    assert.deepEqual(sent.threads.map((thread) => thread.key), [renewal]);

    const search = await listThreads(owner, { query: "introduction" });
    assert.deepEqual(search.threads.map((thread) => thread.key), [intro]);

    const blocked = await listThreads(other, { view: { role: "inbox" } });
    assert.equal(blocked.threads.length, 0);
  });

  it("opens a conversation across folders with cleaned bodies", async () => {
    const thread = await getThread(owner, renewal);
    assert.deepEqual(
      thread.messages.map((item) => [item.folderRole, item.from?.address]),
      [
        ["inbox", "jane@acme.test"],
        ["sent", "mark@eclipse.test"],
        ["inbox", "jane@acme.test"],
      ],
    );
    assert.equal(thread.messages[0].html, "<p>Renewal price</p>");
    await assert.rejects(() => getThread(other, renewal), /Conversation not found/);
    await assert.rejects(() => getThread(owner, "not-a-key"), /Conversation not found/);
  });

  it("counts unread conversations for the sidebar and folder list", async () => {
    assert.equal(await mailUnreadCount(owner), 2);
    const nav = await mailNav(owner);
    assert.equal(nav.unread, 2);
    assert.deepEqual(nav.accounts.map((account) => [account.email, account.unread]), [["mark@eclipse.test", 2]]);
    assert.ok(nav.folders.some((folder) => folder.name === "Clients" && folder.role === "other"));
  });

  it("marks a conversation read in Outlook and in Orbit", async () => {
    const { fetchImpl, writes } = outlook();
    const result = await applyMailAction(owner, { thread: renewal, action: "read", view: { role: "inbox" } }, fetchImpl);
    assert.equal(result.changed, 2);
    assert.deepEqual(
      writes.map((write) => [write.method, write.url.split("?")[0], write.body]).sort(),
      [
        ["PATCH", `${GRAPH}/me/messages/m-2`, { isRead: true }],
        ["PATCH", `${GRAPH}/me/messages/m-3`, { isRead: true }],
      ],
    );
    assert.equal(await mailUnreadCount(owner), 1);
  });

  it("flags only the latest email and unflags them all", async () => {
    const flag = outlook();
    await applyMailAction(owner, { thread: renewal, action: "flag", view: { role: "inbox" } }, flag.fetchImpl);
    assert.deepEqual(flag.writes.map((write) => [write.url.split("?")[0], write.body]), [[`${GRAPH}/me/messages/m-3`, { flag: { flagStatus: "flagged" } }]]);
    assert.equal((await listThreads(owner, { view: { role: "inbox" } })).threads[0].flagged, true);
    const unflag = outlook();
    await applyMailAction(owner, { thread: renewal, action: "unflag" }, unflag.fetchImpl);
    assert.equal(unflag.writes.length, 1);
    assert.equal((await listThreads(owner, { view: { role: "inbox" } })).threads[0].flagged, false);
  });

  it("archives what is in the inbox and leaves sent mail alone", async () => {
    const { fetchImpl, writes } = outlook();
    const result = await applyMailAction(owner, { thread: renewal, action: "archive", view: { role: "inbox" } }, fetchImpl);
    assert.equal(result.changed, 2);
    assert.deepEqual(writes.map((write) => [write.url, write.body]).sort(), [
      [`${GRAPH}/me/messages/m-2/move`, { destinationId: "archive" }],
      [`${GRAPH}/me/messages/m-3/move`, { destinationId: "archive" }],
    ]);
    assert.deepEqual((await listThreads(owner, { view: { role: "inbox" } })).threads.map((thread) => thread.key), [intro]);
    assert.deepEqual((await listThreads(owner, { view: { role: "archive" } })).threads.map((thread) => [thread.key, thread.count]), [[renewal, 2]]);
    assert.deepEqual((await listThreads(owner, { view: { role: "sent" } })).threads.map((thread) => thread.key), [renewal]);

    const back = outlook();
    await applyMailAction(owner, { thread: renewal, action: "inbox", view: { role: "archive" } }, back.fetchImpl);
    assert.deepEqual(back.writes.map((write) => write.body.destinationId), ["inbox", "inbox"]);
    assert.equal((await listThreads(owner, { view: { role: "inbox" } })).threads.length, 2);
  });

  it("keeps Orbit unchanged and explains when Outlook refuses", async () => {
    const { fetchImpl } = outlook({ refuse: true });
    await assert.rejects(
      () => applyMailAction(owner, { thread: intro, action: "trash", view: { role: "inbox" } }, fetchImpl),
      /Connect the account again/,
    );
    assert.equal((await listThreads(owner, { view: { role: "inbox" } })).threads.length, 2);
    assert.equal((await listThreads(owner, { view: { role: "trash" } })).threads.length, 0);
  });

  it("moves drafts to Trash but never archives them", async () => {
    const admin = getAdminPool();
    const folder = await admin.query<{ id: string; source_id: string }>("select id, source_id from crm.mail_folders where provider_folder_id = 'f-drafts'");
    await admin.query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, is_draft, is_read, received_at)
       values ($1, $2, $3, $4, 'd-1', 'conv-draft', 'Draft idea', true, true, now())`,
      [owner.workspaceId, owner.userId, folder.rows[0].source_id, folder.rows[0].id],
    );
    const drafts = await listThreads(owner, { view: { role: "drafts" } });
    const key = drafts.threads[0].key;
    const archive = outlook();
    assert.equal((await applyMailAction(owner, { thread: key, action: "archive", view: { role: "drafts" } }, archive.fetchImpl)).changed, 0);
    assert.equal(archive.writes.length, 0);
    const trash = outlook();
    assert.equal((await applyMailAction(owner, { thread: key, action: "trash", view: { role: "drafts" } }, trash.fetchImpl)).changed, 1);
    assert.deepEqual(trash.writes.map((write) => write.body.destinationId), ["deleteditems"]);
  });

  it("refuses conversations that belong to someone else", async () => {
    await assert.rejects(() => applyMailAction(other, { thread: intro, action: "read" }, outlook().fetchImpl), /Conversation not found/);
  });
});
