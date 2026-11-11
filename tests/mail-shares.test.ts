import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ChatLiveEvent } from "@/lib/chat/types";
import { chatWorkSettled, getDiscussion, listMessages, openDiscussion, postMessage } from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import { removeMember } from "@/lib/crm/team";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import type { MailShareLiveEvent } from "@/lib/mail/share-types";
import {
  getSharedThread,
  getThreadShare,
  listSharedAttachments,
  listSharedThreads,
  openSharedAttachment,
  removeFromShare,
  sharesLostOnLeaving,
  shareThread,
} from "@/lib/mail/shares";
import { syncMail } from "@/lib/mail/sync";
import { threadKey } from "@/lib/mail/threads";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

type GraphMessage = Record<string, unknown>;

function graphMessage(id: string, conversationId: string, at: string, extra: GraphMessage = {}): GraphMessage {
  return {
    id,
    conversationId,
    subject: "Revised pricing",
    bodyPreview: `Preview ${id}`,
    body: { contentType: "html", content: `<p>Body ${id}</p>` },
    from: { emailAddress: { name: "Tom Becker", address: "tom@halden.test" } },
    toRecipients: [{ emailAddress: { name: "Mark Ridgeon", address: "mark@eclipse.test" } }],
    receivedDateTime: at,
    isRead: true,
    hasAttachments: false,
    webLink: `https://outlook.office.com/${id}`,
    ...extra,
  };
}

let pending: GraphMessage[] = [];
let graphCalls: string[] = [];

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  graphCalls.push(url);
  if (url.includes("/me/messages/m-1/attachments/att-1/$value")) return new Response("PDFDATA", { headers: { "content-type": "application/pdf" } });
  if (url.match(/\/me\/messages\/[^/]+\/attachments\/[^/]+\/\$value/)) return new Response("", { status: 404 });
  if (url.includes("/me/messages/m-1/attachments")) {
    return Response.json({
      value: [
        { id: "att-1", name: "Order form.pdf", contentType: "application/pdf", size: 184_000, isInline: false },
        { id: "att-2", name: "logo.png", contentType: "image/png", size: 4_000, isInline: true },
      ],
    });
  }
  if (url.match(/\/me\/messages\/[^/]+\/attachments/)) return Response.json({ value: [] });
  const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
  if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
  if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
  if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
  if (url.includes("token=")) {
    const value = pending;
    pending = [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=2` });
  }
  return Response.json({
    value: [
      graphMessage("m-1", "conv-1", "2026-10-01T09:00:00Z", { hasAttachments: true }),
      graphMessage("m-2", "conv-1", "2026-10-02T09:00:00Z"),
      graphMessage("m-other", "conv-2", "2026-10-03T09:00:00Z", { subject: "Something private" }),
    ],
    "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=1`,
  });
};

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let olly: UserActor;
let key: string;
let sourceId: string;
let ids: Record<string, string>;
let broadcasts: LiveMessage[];

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function folder(role: string) {
  const rows = await sql<{ id: string }>(
    "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role, sync_state) values ($1, $2, $3, $4, $5, $6, 'skipped') returning id",
    [mark.workspaceId, mark.userId, sourceId, `f-${role}`, role, role],
  );
  return rows[0].id;
}

async function message(folderId: string, providerId: string, thread: string, extra: { draft?: boolean; bcc?: boolean; at?: string } = {}) {
  const rows = await sql<{ id: string }>(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, snippet, body_text,
       from_email, from_name, to_recipients, bcc_recipients, sent_at, is_draft, web_link)
     values ($1, $2, $3, $4, $5, $6, 'Revised pricing', $5, $5, 'mark@eclipse.test', 'Mark Ridgeon', '[{"name":"Tom Becker","address":"tom@halden.test"}]'::jsonb,
       $7::jsonb, $8, $9, 'https://outlook.office.com/x')
     returning id`,
    [
      mark.workspaceId,
      mark.userId,
      sourceId,
      folderId,
      providerId,
      thread,
      extra.bcc ? '[{"name":"Secret","address":"secret@hidden.test"}]' : "[]",
      extra.at ?? "2026-10-04T09:00:00Z",
      Boolean(extra.draft),
    ],
  );
  return rows[0].id;
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

function shareEventsFor(user: UserActor) {
  return broadcasts.filter((item) => item.topic === personTopic(user.userId) && item.event === "mail_share").map((item) => item.payload as MailShareLiveEvent);
}

function chatEventsFor(user: UserActor) {
  return broadcasts.filter((item) => item.topic === personTopic(user.userId) && item.event === "chat").map((item) => item.payload as ChatLiveEvent);
}

async function alertsFor(user: UserActor) {
  await chatWorkSettled();
  return sql<{ title: string; body: string | null; href: string | null; source: string; workspace_id: string }>(
    "select title, body, href, source, workspace_id from crm.notifications where user_id = $1 order by created_at, id",
    [user.userId],
  );
}

function tag(person: UserActor) {
  return `@[${person.fullName}](member:${person.userId})`;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@eclipse.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@eclipse.test", "Priya Nair"), "member");
  olly = await createUser("olly@elsewhere.test", "Olly Outside");
  await saveMailbox(mark, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await syncMail(mark, { budgetMs: 30_000, fetchImpl });
  sourceId = (await sql<{ id: string }>("select id from crm.mail_sources where user_id = $1", [mark.userId]))[0].id;
  key = threadKey(sourceId, "conv-1");
  const messages = await sql<{ id: string; provider_message_id: string }>("select id, provider_message_id from crm.mail_messages where user_id = $1", [mark.userId]);
  ids = Object.fromEntries(messages.map((row) => [row.provider_message_id, row.id]));
  ids.sent = await message(await folder("sent"), "m-sent", "conv-1", { bcc: true });
  ids.draft = await message(await folder("drafts"), "m-draft", "conv-1", { draft: true });
  ids.trash = await message(await folder("trash"), "m-trash", "conv-1");
  ids.junk = await message(await folder("junk"), "m-junk", "conv-1");
});

beforeEach(async () => {
  await chatWorkSettled();
  broadcasts = [];
  graphCalls = [];
  setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
});

after(async () => {
  await chatWorkSettled();
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("sharing a thread", () => {
  it("lets only the owner share, only with people who share a workspace, and is idempotent", async () => {
    await refused(shareThread(sam, key, [priya.userId]), /Conversation not found/);
    await refused(shareThread(mark, key, [olly.userId]), /doesn't share a workspace with you/);
    await refused(shareThread(mark, threadKey(sourceId, "conv-missing"), [sam.userId]), /Conversation not found/);
    await refused(shareThread(mark, key, []), /Pick someone/);
    const first = await shareThread(mark, key, [sam.userId]);
    assert.deepEqual(first.added, [sam.userId]);
    assert.deepEqual(
      first.share.people.map((person) => [person.name, person.owner]),
      [
        ["Mark Ridgeon", true],
        ["Sam Okafor", false],
      ],
    );
    assert.ok(first.share.candidates.some((person) => person.id === priya.userId));
    assert.ok(!first.share.candidates.some((person) => [sam.userId, mark.userId, olly.userId].includes(person.id)));
    const again = await shareThread(mark, key, [sam.userId]);
    assert.deepEqual(again.added, []);
    assert.equal(again.share.shareId, first.share.shareId);
    assert.equal((await getThreadShare(mark, key)).shareId, first.share.shareId);
    await refused(getThreadShare(sam, key), /Conversation not found/);
  });

  it("tells the new person with a generic alert that isn't wrapped in a workspace switch", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    const alerts = await alertsFor(sam);
    const home = (await sql<{ workspace_id: string }>("select workspace_id from private.memberships_for($1)", [sam.userId]))[0].workspace_id;
    assert.deepEqual(
      alerts.map((alert) => ({ ...alert })),
      [{ title: "Mark shared an email with you", body: null, href: `/mail?shared=${shareId}`, source: "mail_share", workspace_id: home }],
    );
    const second = await sql<{ count: number }>("select count(*)::int as count from crm.workspace_members where user_id = $1", [sam.userId]);
    assert.equal(second[0].count, 2);
  });

  it("sends live events when people are added", async () => {
    const result = await shareThread(mark, key, [priya.userId]);
    await chatWorkSettled();
    const shareId = result.share.shareId!;
    assert.deepEqual(shareEventsFor(priya), [{ type: "shared", shareId }]);
    assert.deepEqual(shareEventsFor(sam), [{ type: "people", shareId }]);
    assert.deepEqual(shareEventsFor(mark), [{ type: "people", shareId }]);
    await removeFromShare(mark, shareId, priya.userId);
  });
});

describe("reading a shared thread", () => {
  it("lists it for members only, one row with no bodies", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    const threads = await listSharedThreads(sam);
    assert.equal(threads.length, 1);
    const [row] = threads;
    assert.equal(row.shareId, shareId);
    assert.deepEqual(row.owner, { id: mark.userId, name: "Mark Ridgeon" });
    assert.equal(row.count, 3);
    assert.equal(row.hasAttachments, true);
    assert.deepEqual(row.counterpart, { name: "Tom Becker", address: "tom@halden.test" });
    assert.equal(row.subject, "Revised pricing");
    assert.ok(!("html" in row) && !("text" in row));
    assert.deepEqual(await listSharedThreads(priya), []);
    assert.deepEqual(await listSharedThreads(mark), []);
  });

  it("returns only the thread's sent and received mail, without drafts, trash, junk, Bcc or provider ids", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    const thread = await getSharedThread(sam, shareId);
    assert.deepEqual(
      thread.messages.map((item) => item.id),
      [ids["m-1"], ids["m-2"], ids.sent],
    );
    assert.equal(thread.viewerIsOwner, false);
    assert.equal(thread.threadKey, null);
    const json = JSON.stringify(thread);
    for (const hidden of ["secret@hidden.test", "m-draft", "m-trash", "m-junk", "m-other", "Something private", "outlook.office.com", "conv-1", "bcc", "webLink"]) {
      assert.ok(!json.includes(hidden), hidden);
    }
    assert.match(thread.messages[0].html ?? "", /Body m-1/);
    const own = await getSharedThread(mark, shareId);
    assert.equal(own.viewerIsOwner, true);
    assert.equal(own.threadKey, key);
    await refused(getSharedThread(priya, shareId), /Conversation not found/);
    await refused(getSharedThread(olly, shareId), /Conversation not found/);
    await refused(getSharedThread(sam, "not-a-share"), /Conversation not found/);
  });
});

describe("shared attachments", () => {
  it("opens attachments in the shared thread as the owner, read only", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    const items = await listSharedAttachments(sam, shareId, ids["m-1"], fetchImpl);
    assert.deepEqual(items.map((item) => item.name), ["Order form.pdf"]);
    const { item, body } = await openSharedAttachment(sam, shareId, ids["m-1"], "att-1", fetchImpl);
    assert.equal(item.name, "Order form.pdf");
    assert.equal(await new Response(body).text(), "PDFDATA");
    assert.ok(graphCalls.every((url) => url.includes("/me/messages/m-1/attachments")));
    await refused(openSharedAttachment(sam, shareId, ids["m-1"], "att-9", fetchImpl), /Attachment not found/);
  });

  it("refuses messages outside the thread, drafts, trash, junk and people outside the share", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    for (const id of [ids["m-other"], ids.draft, ids.trash, ids.junk]) {
      await refused(openSharedAttachment(sam, shareId, id, "att-1", fetchImpl), /Email not found/);
      await refused(listSharedAttachments(sam, shareId, id, fetchImpl), /Email not found/);
    }
    await refused(openSharedAttachment(priya, shareId, ids["m-1"], "att-1", fetchImpl), /Email not found/);
    assert.deepEqual(graphCalls, []);
  });

  it("names the owner when their mailbox needs reconnecting", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    await sql("update crm.mailbox_connections set status = 'disconnected' where user_id = $1", [mark.userId]);
    try {
      await refused(openSharedAttachment(sam, shareId, ids["m-1"], "att-1", fetchImpl), /^Couldn't open the attachment\. Mark needs to reconnect their mailbox\.$/);
    } finally {
      await sql("update crm.mailbox_connections set status = 'connected' where user_id = $1", [mark.userId]);
    }
  });
});

describe("notes on a shared thread", () => {
  let shareId: string;
  let conversationId: string;

  before(async () => {
    shareId = (await getThreadShare(mark, key)).shareId!;
  });

  it("is visible to the owner and members only", async () => {
    conversationId = (await openDiscussion(sam, { kind: "mail_thread", id: shareId })).conversationId;
    assert.equal((await openDiscussion(mark, { kind: "mail_thread", id: shareId })).conversationId, conversationId);
    await refused(openDiscussion(priya, { kind: "mail_thread", id: shareId }), /not found/);
    await refused(getDiscussion(olly, { kind: "mail_thread", id: shareId }), /not found/);
    await postMessage(sam, { conversationId, body: "Setup fee waiver is fine on our side." });
    const seen = await getDiscussion(mark, { kind: "mail_thread", id: shareId });
    assert.equal(seen.count, 1);
    await refused(listMessages(priya, conversationId), /not found/);
    await refused(postMessage(priya, { conversationId, body: "Let me in" }), /not found/);
    await chatWorkSettled();
    assert.equal(chatEventsFor(mark).length, 1);
    assert.equal(chatEventsFor(sam).length, 1);
    assert.equal(chatEventsFor(priya).length, 0);
    assert.deepEqual((chatEventsFor(mark)[0] as { subject?: unknown }).subject, { kind: "mail_thread", id: shareId });
  });

  it("refuses tagging someone outside the share, and says who can add them", async () => {
    await assert.rejects(postMessage(sam, { conversationId, body: `${tag(priya)} can you check?` }), (error: unknown) => {
      assert.ok(error instanceof CrmError);
      assert.equal(error.message, "Priya Nair isn't in this thread. Only Mark can add people.");
      assert.deepEqual(error.details?.needsShare, { people: [{ id: priya.userId, name: "Priya Nair" }], canAdd: false });
      return true;
    });
    await assert.rejects(postMessage(mark, { conversationId, body: `${tag(priya)} can you check?` }), (error: unknown) => {
      assert.ok(error instanceof CrmError);
      assert.deepEqual(error.details?.needsShare, { people: [{ id: priya.userId, name: "Priya Nair" }], canAdd: true });
      return true;
    });
    assert.equal((await getDiscussion(mark, { kind: "mail_thread", id: shareId })).count, 1);
    assert.deepEqual(await listSharedThreads(priya), []);
  });

  it("alerts mentions and thread replies with links to the shared email", async () => {
    await sql("truncate crm.notifications, crm.push_log");
    const root = (await postMessage(mark, { conversationId, body: `${tag(sam)} can you check their quantities?` })).message;
    await postMessage(sam, { conversationId, parentId: root.id, body: "Quantities match." });
    const href = `/mail?shared=${shareId}&discussion=1`;
    assert.deepEqual(
      (await alertsFor(sam)).map((alert) => [alert.title, alert.href, alert.source, alert.body]),
      [["Mark mentioned you in a shared email", href, "mail_share", null]],
    );
    assert.deepEqual(
      (await alertsFor(mark)).map((alert) => [alert.title, alert.href, alert.source]),
      [["Sam replied in a thread on a shared email", href, "mail_share"]],
    );
    assert.deepEqual(await alertsFor(priya), []);
  });
});

describe("live updates from sync", () => {
  it("sends one mail_share event to members when sync adds a message to a shared thread", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    pending = [graphMessage("m-3", "conv-1", "2026-10-05T09:00:00Z"), graphMessage("m-4", "conv-1", "2026-10-05T10:00:00Z"), graphMessage("m-5", "conv-2", "2026-10-05T11:00:00Z")];
    await syncMail(mark, { budgetMs: 30_000, fetchImpl });
    assert.deepEqual(shareEventsFor(sam), [{ type: "message", shareId }]);
    assert.deepEqual(shareEventsFor(priya), []);
    assert.equal((await getSharedThread(sam, shareId)).messages.length, 5);
    broadcasts = [];
    pending = [graphMessage("m-6", "conv-2", "2026-10-06T09:00:00Z")];
    await syncMail(mark, { budgetMs: 30_000, fetchImpl });
    assert.deepEqual(shareEventsFor(sam), []);
  });
});

describe("removing people", () => {
  it("lets only the owner remove, refuses the removed person from then on, and tells them", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    const conversationId = (await openDiscussion(mark, { kind: "mail_thread", id: shareId })).conversationId;
    await shareThread(mark, key, [priya.userId]);
    await chatWorkSettled();
    broadcasts = [];
    await refused(removeFromShare(sam, shareId, priya.userId), /Only the person who shared this thread can remove people/);
    await refused(removeFromShare(olly, shareId, sam.userId), /Conversation not found/);
    assert.deepEqual(await removeFromShare(mark, shareId, sam.userId), { removed: true });
    await chatWorkSettled();
    assert.deepEqual(shareEventsFor(sam), [{ type: "removed", shareId }]);
    assert.deepEqual(shareEventsFor(priya), [{ type: "people", shareId }]);
    assert.deepEqual(await listSharedThreads(sam), []);
    await refused(getSharedThread(sam, shareId), /Conversation not found/);
    await refused(openSharedAttachment(sam, shareId, ids["m-1"], "att-1", fetchImpl), /Email not found/);
    await refused(listMessages(sam, conversationId), /not found/);
    await refused(postMessage(sam, { conversationId, body: "Still here?" }), /not found/);
    assert.deepEqual(await removeFromShare(mark, shareId, sam.userId), { removed: false });
    assert.equal((await getSharedThread(priya, shareId)).messages.length, 5);
  });

  it("drops a member who leaves the owner's workspace, and tells them", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    await shareThread(mark, key, [sam.userId]);
    await chatWorkSettled();
    broadcasts = [];
    await removeMember(mark, sam.userId);
    assert.deepEqual(shareEventsFor(sam), [{ type: "removed", shareId }]);
    assert.ok(shareEventsFor(priya).some((event) => event.type === "people"));
    await refused(getSharedThread(sam, shareId), /Conversation not found/);
    assert.deepEqual(
      (await getThreadShare(mark, key)).people.map((person) => person.name),
      ["Mark Ridgeon", "Priya Nair"],
    );
  });

  it("drops every member when the owner no longer shares a workspace with them", async () => {
    const shareId = (await getThreadShare(mark, key)).shareId!;
    const lost = await sharesLostOnLeaving(mark.workspaceId, mark.userId);
    assert.deepEqual(
      lost.map((item) => [item.shareId, item.userId]),
      [[shareId, priya.userId]],
    );
    await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, mark.userId]);
    await refused(getSharedThread(priya, shareId), /Conversation not found/);
    assert.equal((await sql("select 1 from crm.mail_share_members where share_id = $1", [shareId])).length, 0);
  });
});
