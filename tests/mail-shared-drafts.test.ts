import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { chatWorkSettled } from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import {
  cancelScheduledDraft,
  changeScheduledDraft,
  claimDueDrafts,
  discardMailDraft,
  dueDraftInput,
  failDueDraft,
  getScheduledDraft,
  listScheduledDrafts,
  unscheduleMailDraft,
  readDraftInput,
  refuseSharedTextChange,
  saveMailDraft,
  scheduleMailDraft,
  sendForAgent,
  sendMailDraft,
  sendMailOnce,
} from "@/lib/mail/compose";
import { announceSharedThreads } from "@/lib/mail/share-live";
import type { MailShareLiveEvent } from "@/lib/mail/share-types";
import { getSharedDraft, holdSharedDraft, saveSharedDraft, shareDraft, sharedDraftClosed, SHARED_TEXT_LOCKED } from "@/lib/mail/shared-drafts";
import { getSharedThread, listSharedThreads, removeFromShare, shareThread } from "@/lib/mail/shares";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads } from "@/lib/mail/threads";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ORIGIN = "https://orbit.test";

type Call = { method: string; url: string; body: Record<string, unknown> | null };

let draftCount = 0;

function message(id: string) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: "conv-renewal",
    subject: "Renewal pricing",
    bodyPreview: "Can we talk about the renewal price?",
    body: { contentType: "html", content: "<p>Can we talk about the renewal price?</p>" },
    from: { emailAddress: { name: "Tom Becker", address: "tom@halden.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: "2026-10-01T09:00:00Z",
    receivedDateTime: "2026-10-01T09:00:05Z",
    isRead: true,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: `https://outlook.office.com/mail/${id}`,
  };
}

function outlook(options: { missing?: Set<string>; vanished?: Set<string>; onPatch?: () => Promise<void>; failCreate?: boolean; failSend?: boolean; failPatch?: (id: string) => boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
    if (method !== "GET") {
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (options.missing?.has(id)) return Response.json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, { status: 404 });
      if (method === "PATCH" && options.onPatch) {
        const hook = options.onPatch;
        options.onPatch = undefined;
        await hook();
      }
      if (method === "PATCH" && options.failPatch?.(id)) return Response.json({ error: { code: "ErrorInvalidRequest", message: "Outlook refused the change." } }, { status: 400 });
      if (options.failCreate && method === "POST" && (url === `${GRAPH}/me/messages` || /\/(createReply|createReplyAll|createForward)$/.test(url))) {
        return Response.json({ error: { code: "ErrorInvalidRequest", message: "Outlook refused." } }, { status: 400 });
      }
      if (options.failSend && url.endsWith("/send")) return Response.json({ error: { code: "ErrorInvalidRecipients", message: "Outlook refused the recipients." } }, { status: 400 });
      if (method === "POST" && url === `${GRAPH}/me/messages`) {
        draftCount += 1;
        return Response.json({ id: `draft-${draftCount}`, conversationId: `conv-new-${draftCount}`, subject: "" }, { status: 201 });
      }
      if (/\/(createReply|createReplyAll|createForward)$/.test(url)) {
        draftCount += 1;
        return Response.json({ id: `draft-${draftCount}`, subject: "RE: Renewal pricing", body: { contentType: "html", content: "<html><body><div>quoted</div></body></html>" } }, { status: 201 });
      }
      if (url.endsWith("/send")) return new Response(null, { status: 202 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id });
    }
    if (id && (options.missing?.has(id) || options.vanished?.has(id))) return Response.json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, { status: 404 });
    if (id && url.includes("internetMessageId")) return Response.json({ id, internetMessageId: `<${id}@mail.test>` });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    return Response.json({ value: folder === "f-inbox" ? [message("m-1")] : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=${Date.now()}${Math.random()}` });
  };
  return { fetchImpl, calls };
}

function lastPatchBefore(calls: Call[], suffix: string) {
  const sendAt = calls.findIndex((call) => call.url.endsWith(suffix));
  const patches = calls.slice(0, sendAt === -1 ? calls.length : sendAt).filter((call) => call.method === "PATCH");
  return patches.at(-1)?.body as { subject: string; body: { content: string } } | undefined;
}

function sentDraft(calls: Call[]) {
  return calls.find((call) => call.url.endsWith("/send"))?.url.match(/\/me\/messages\/([^/]+)\/send$/)?.[1] ?? null;
}

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let jane: string;
let sourceId: string;
let threadShare: string;
let broadcasts: LiveMessage[];

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

function reply(body: string, extra: Record<string, unknown> = {}) {
  return readDraftInput({ mode: "reply", messageId: jane, to: ["tom@halden.test"], subject: "RE: Renewal pricing", body, ...extra });
}

async function sharedReply(body: string) {
  const draft = await saveMailDraft(mark, reply(body), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
  const shared = await shareDraft(mark, draft.id, []);
  assert.equal(shared.shareId, threadShare);
  return draft;
}

function draftEventsFor(user: UserActor) {
  return broadcasts.filter((item) => item.topic === personTopic(user.userId) && item.event === "mail_share").map((item) => item.payload as MailShareLiveEvent).filter((event) => event.type === "draft");
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@eclipse.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@eclipse.test", "Priya Nair"), "member");
  await saveMailbox(mark, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await syncMail(mark, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
  const inbox = await listThreads(mark, { view: { role: "inbox" } });
  jane = inbox.threads[0].latestId;
  sourceId = (await sql<{ id: string }>("select id from crm.mail_sources where user_id = $1", [mark.userId]))[0].id;
  threadShare = (await shareThread(mark, inbox.threads[0].key, [sam.userId])).share.shareId!;
});

beforeEach(async () => {
  await chatWorkSettled();
  broadcasts = [];
  setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
});

after(async () => {
  await chatWorkSettled();
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("sharing a draft", () => {
  it("refuses a reply draft in a thread that isn't shared, and a teammate's own share", async () => {
    await sql("delete from crm.mail_share_members where share_id = $1", [threadShare]);
    const draft = await saveMailDraft(mark, reply("Hi Tom"), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    await refused(shareDraft(mark, draft.id, []), /Share this thread first/);
    await sql("insert into crm.mail_share_members (share_id, user_id, added_by) values ($1, $2, $3)", [threadShare, sam.userId, mark.userId]);
    await refused(shareDraft(sam, draft.id, []), /That draft has gone/);
    await refused(shareDraft(mark, draft.id, [priya.userId]), /Add people to the thread with Share/);
    await discardMailDraft(mark, draft.id, outlook().fetchImpl);
  });

  it("gives a reply draft to the thread's people, alerts them, and shows them the text without Bcc", async () => {
    const draft = await saveMailDraft(mark, reply("Hi Tom", { bcc: ["secret@hidden.test"] }), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const shared = await shareDraft(mark, draft.id, []);
    assert.deepEqual(shared.added, [sam.userId]);
    await chatWorkSettled();
    const alerts = await sql<{ title: string; href: string }>("select title, href from crm.notifications where user_id = $1", [sam.userId]);
    assert.ok(alerts.some((alert) => alert.title === "Mark added you to a draft" && alert.href === `/mail?shared=${threadShare}`));
    const seen = await getSharedDraft(sam, threadShare);
    assert.equal(seen.state, "editing");
    assert.equal(seen.body, "Hi Tom");
    assert.equal(seen.from, "mark@eclipse.test");
    assert.deepEqual(seen.to.map((item) => item.address), ["tom@halden.test"]);
    assert.ok(!JSON.stringify(seen).includes("secret@hidden.test"));
    assert.equal((await getSharedThread(sam, threadShare)).draft?.state, "editing");
    await refused(getSharedDraft(priya, threadShare), /You no longer have access to this draft/);
    await refused(shareDraft(mark, (await saveMailDraft(mark, reply("Second"), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl })).id, []), /Another draft in this thread is shared/);
    const own = await getThread(mark, (await listThreads(mark, { view: { role: "inbox" } })).threads[0].key);
    assert.equal(own.drafts.find((item) => item.id === draft.id)?.shareId, threadShare);
  });

  it("lets a teammate write the text, never touches the content hash, and tells everyone", async () => {
    const before = (await sql<{ content_hash: string }>("select d.content_hash from crm.mail_drafts d join crm.mail_shares s on s.draft_id = d.id where s.id = $1", [threadShare]))[0].content_hash;
    const saved = await saveSharedDraft(sam, threadShare, { subject: null, body: "Hi Tom, the fee is waived." });
    assert.ok(saved.version > 0);
    const after = await sql<{ content_hash: string; body: string }>("select d.content_hash, d.body from crm.mail_drafts d join crm.mail_shares s on s.draft_id = d.id where s.id = $1", [threadShare]);
    assert.equal(after[0].content_hash, before);
    assert.equal(after[0].body, "Hi Tom, the fee is waived.");
    await chatWorkSettled();
    assert.ok(draftEventsFor(mark).some((event) => event.shareId === threadShare));
    assert.ok(draftEventsFor(sam).some((event) => event.shareId === threadShare));
    await refused(saveSharedDraft(priya, threadShare, { subject: null, body: "Nope" }), /You no longer have access to this draft/);
  });

  it("keeps the teammate's text when the owner's browser saves an older copy", async () => {
    const id = (await sql<{ draft_id: string }>("select draft_id from crm.mail_shares where id = $1", [threadShare]))[0].draft_id;
    const { fetchImpl, calls } = outlook();
    await saveMailDraft(mark, { ...reply("Hi Tom"), id, cc: [{ address: "ola@halden.test", name: null }] }, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    const patch = lastPatchBefore(calls, "never")!;
    assert.ok(patch.body.content.includes("the fee is waived"));
    assert.equal((await getSharedDraft(sam, threadShare)).body, "Hi Tom, the fee is waived.");
    assert.deepEqual((await getSharedDraft(sam, threadShare)).cc.map((item) => item.address), ["ola@halden.test"]);
  });

  it("goes read only for teammates while the owner holds it to send, and opens again on Undo", async () => {
    const id = (await sql<{ draft_id: string }>("select draft_id from crm.mail_shares where id = $1", [threadShare]))[0].draft_id;
    assert.deepEqual(await holdSharedDraft(mark, id, true), { shared: true });
    assert.equal((await getSharedDraft(sam, threadShare)).state, "sending");
    await refused(saveSharedDraft(sam, threadShare, { subject: null, body: "Late edit" }), /^Mark is sending\. Read only\.$/);
    await saveSharedDraft(mark, threadShare, { subject: null, body: "Hi Tom, the fee is waived. Mark" });
    await holdSharedDraft(mark, id, false);
    assert.equal((await getSharedDraft(sam, threadShare)).state, "editing");
    await saveSharedDraft(sam, threadShare, { subject: null, body: "Hi Tom, the fee is waived for the rollout." });
    assert.deepEqual(await holdSharedDraft(sam, id, true), { shared: false });
  });

  it("sends the merged text from the owner's Send, then tells teammates it was sent", async () => {
    const id = (await sql<{ draft_id: string }>("select draft_id from crm.mail_shares where id = $1", [threadShare]))[0].draft_id;
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(mark, { ...reply("Hi Tom"), id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    const patch = lastPatchBefore(calls, "/send")!;
    assert.ok(patch.body.content.includes("waived for the rollout"));
    assert.ok(sentDraft(calls));
    const seen = await getSharedDraft(sam, threadShare);
    assert.equal(seen.state, "sent");
    assert.equal((await getSharedThread(sam, threadShare)).draft?.state, "sent");
    const share = (await sql<{ thread_key: string; draft_id: string | null }>("select thread_key, draft_id from crm.mail_shares where id = $1", [threadShare]))[0];
    assert.equal(share.thread_key, "conv-renewal");
    assert.equal(share.draft_id, null);
    await refused(saveSharedDraft(sam, threadShare, { subject: null, body: "Too late" }), /sent or discarded/);
  });
});

describe("scheduled and background sends", () => {
  it("stays read only while scheduled until the owner cancels", async () => {
    const draft = await sharedReply("Scheduled hello");
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await scheduleMailDraft(mark, { ...reply("Scheduled hello"), id: draft.id, sendAt: at }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    assert.equal((await getSharedDraft(sam, threadShare)).state, "scheduled");
    await refused(saveSharedDraft(sam, threadShare, { subject: null, body: "Edit" }), /^Scheduled\. Read only until Mark unschedules it\.$/);
    await saveSharedDraft(mark, threadShare, { subject: null, body: "Scheduled hello" });
    await cancelScheduledDraft(mark, draft.id);
    await chatWorkSettled();
    assert.ok(draftEventsFor(sam).length >= 2);
    await saveSharedDraft(sam, threadShare, { subject: null, body: "Scheduled hello, from Sam" });
  });

  it("refuses an assistant change to a scheduled shared draft's text", async () => {
    const id = (await sql<{ draft_id: string }>("select draft_id from crm.mail_shares where id = $1", [threadShare]))[0].draft_id;
    const scheduling = outlook();
    await scheduleMailDraft(mark, { ...reply("ignored"), id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: scheduling.fetchImpl });
    assert.ok(lastPatchBefore(scheduling.calls, "never")!.body.content.includes("Scheduled hello, from Sam"));
    await refused(changeScheduledDraft(mark, id, { body: "Assistant text" }, { origin: ORIGIN, fetchImpl: outlook().fetchImpl }), new RegExp(SHARED_TEXT_LOCKED.slice(0, 30)));
    assert.equal((await getSharedDraft(sam, threadShare)).body, "Scheduled hello, from Sam");
  });

  it("sends the merged text when the scheduled time comes, and refuses edits while it sends", async () => {
    const id = (await sql<{ draft_id: string }>("select draft_id from crm.mail_shares where id = $1", [threadShare]))[0].draft_id;
    await sql("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [id]);
    const [due] = await claimDueDrafts(mark, 1);
    assert.equal(due.id, id);
    assert.equal((await getSharedDraft(sam, threadShare)).state, "sending");
    await refused(saveSharedDraft(sam, threadShare, { subject: null, body: "Edit" }), /Mark is sending/);
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(mark, dueDraftInput(due), { storedFiles: "keep", origin: ORIGIN, fetchImpl, claimed: true });
    assert.ok(calls.every((call) => call.method !== "PATCH" || JSON.stringify(call.body).includes("Scheduled hello, from Sam")));
    assert.ok(sentDraft(calls));
    assert.equal((await getSharedDraft(sam, threadShare)).state, "sent");
  });
});

describe("the assistant and MCP", () => {
  it("refuses a different body from the assistant, and sends the merged text when it matches", async () => {
    const draft = await sharedReply("Assistant start");
    await saveSharedDraft(sam, threadShare, { subject: null, body: "Assistant start, with Sam's line" });
    await refused(sendForAgent(mark, { draftId: draft.id, to: [], body: "Something else" }, { origin: ORIGIN, fetchImpl: outlook().fetchImpl }), /This draft is shared/);
    const { fetchImpl, calls } = outlook();
    await sendForAgent(mark, { draftId: draft.id, to: [], body: "Assistant start, with Sam's line" }, { origin: ORIGIN, fetchImpl });
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("with Sam&#39;s line") || lastPatchBefore(calls, "/send")!.body.content.includes("with Sam's line"));
    assert.equal((await getSharedDraft(sam, threadShare)).state, "sent");
  });

  it("refuses an MCP save that changes the text, and mail_send with draft_id carries the merged text", async () => {
    const draft = await sharedReply("MCP start");
    await saveSharedDraft(sam, threadShare, { subject: null, body: "MCP start, edited by Sam" });
    await refused(refuseSharedTextChange(mark, draft.id, { body: "Agent rewrite" }), /This draft is shared/);
    await refused(refuseSharedTextChange(mark, draft.id, { subject: "New subject", body: "MCP start, edited by Sam" }), /This draft is shared/);
    assert.ok(await refuseSharedTextChange(mark, draft.id, { body: "MCP start, edited by Sam\n" }));
    const { fetchImpl, calls } = outlook();
    const result = await sendMailOnce(mark, { draftId: draft.id }, { origin: ORIGIN, fetchImpl });
    assert.equal(result.status, "sent");
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("edited by Sam"));
  });
});

describe("the share is the stable key", () => {
  it("follows the draft when Outlook lost it on save", async () => {
    const draft = await sharedReply("Lost on save");
    const lost = `draft-${draftCount}`;
    const saved = await saveMailDraft(mark, { ...reply("Lost on save"), id: draft.id, cc: [{ address: "ola@halden.test", name: null }] }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook({ missing: new Set([lost]) }).fetchImpl });
    assert.notEqual(saved.id, draft.id);
    const share = (await sql<{ draft_id: string }>("select draft_id from crm.mail_shares where id = $1", [threadShare]))[0];
    assert.equal(share.draft_id, saved.id);
    assert.equal((await getSharedDraft(sam, threadShare)).state, "editing");
    await saveSharedDraft(sam, threadShare, { subject: null, body: "Lost on save, kept" });
  });

  it("follows the draft when Outlook lost it during Send, and sends the merged text", async () => {
    const id = (await sql<{ draft_id: string }>("select draft_id from crm.mail_shares where id = $1", [threadShare]))[0].draft_id;
    const provider = (await sql<{ provider_draft_id: string }>("select provider_draft_id from crm.mail_drafts where id = $1", [id]))[0].provider_draft_id;
    const { fetchImpl, calls } = outlook({ vanished: new Set([provider]) });
    await sendMailDraft(mark, { ...reply("stale"), id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    const sent = sentDraft(calls);
    assert.ok(sent && sent !== provider);
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("Lost on save, kept"));
    assert.equal((await getSharedDraft(sam, threadShare)).state, "sent");
  });

  it("keeps a new email's share when From moves it to another mailbox", async () => {
    const account = (
      await sql<{ id: string }>(
        `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, access_token, access_token_expires_at, can_send)
         values ($1, $2, 'microsoft', 'mark@consulting.test', 'connected', $3, $4, now() + interval '1 hour', true) returning id`,
        [mark.workspaceId, mark.userId, encryptSecret("acct-refresh"), encryptSecret("acct-access")],
      )
    )[0].id;
    const other = (await sql<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, account_id, email) values ($1, $2, $3, 'mark@consulting.test') returning id", [mark.workspaceId, mark.userId, account]))[0].id;
    const input = readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Intro", body: "Hello Tom" });
    const draft = await saveMailDraft(mark, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    await refused(shareDraft(mark, draft.id, []), /Add someone to share it with/);
    const shared = await shareDraft(mark, draft.id, [sam.userId, priya.userId]);
    assert.deepEqual(new Set(shared.added), new Set([sam.userId, priya.userId]));
    assert.ok((await listSharedThreads(priya)).some((row) => row.shareId === shared.shareId && row.subject === "Intro"));
    await saveSharedDraft(priya, shared.shareId, { subject: "Intro from Priya", body: "Hello Tom, from Priya" });
    const moved = await saveMailDraft(mark, { ...input, id: draft.id, sourceId: other }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    assert.notEqual(moved.id, draft.id);
    assert.equal(moved.body, "Hello Tom, from Priya");
    assert.equal(moved.subject, "Intro from Priya");
    const share = (await sql<{ draft_id: string; source_id: string; draft_state: string | null }>("select draft_id, source_id, draft_state from crm.mail_shares where id = $1", [shared.shareId]))[0];
    assert.deepEqual(share, { draft_id: moved.id, source_id: other, draft_state: null });
    const seen = await getSharedDraft(priya, shared.shareId);
    assert.equal(seen.state, "editing");
    assert.equal(seen.from, "mark@consulting.test");

    const { fetchImpl } = outlook();
    await sendMailDraft(mark, { ...input, id: moved.id, sourceId: other }, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    const after = (await sql<{ thread_key: string | null; draft_state: string }>("select thread_key, draft_state from crm.mail_shares where id = $1", [shared.shareId]))[0];
    assert.equal(after.draft_state, "sent");
    assert.equal(after.thread_key, `conv-new-${draftCount}`);
  });

  it("follows an SMTP send to its thread by the sent message id", async () => {
    const draft = await saveMailDraft(mark, readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "SMTP", body: "Hi" }), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const shared = await shareDraft(mark, draft.id, [sam.userId]);
    await sql("update crm.mail_shares set draft_id = null, draft_state = 'sent', sent_internet_id = '<smtp-1@eclipse.test>' where id = $1", [shared.shareId]);
    await sql("delete from crm.mail_drafts where id = $1", [draft.id]);
    const pending = (await sql<{ thread_key: string | null; sent_internet_id: string }>("select thread_key, sent_internet_id from crm.mail_shares where id = $1", [shared.shareId]))[0];
    assert.deepEqual(pending, { thread_key: null, sent_internet_id: "<smtp-1@eclipse.test>" });
    const folder = (await sql<{ id: string }>("select id from crm.mail_folders where source_id = $1 and role = 'inbox'", [sourceId]))[0].id;
    await sql(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, from_email, internet_message_id, received_at)
       values ($1, $2, $3, $4, 'smtp-copy', 'conv-smtp', 'SMTP', 'mark@eclipse.test', '<smtp-1@eclipse.test>', now())`,
      [mark.workspaceId, mark.userId, sourceId, folder],
    );
    await announceSharedThreads(mark.userId, sourceId, ["conv-smtp"]);
    const followed = (await sql<{ thread_key: string | null; sent_internet_id: string | null }>("select thread_key, sent_internet_id from crm.mail_shares where id = $1", [shared.shareId]))[0];
    assert.deepEqual(followed, { thread_key: "conv-smtp", sent_internet_id: "<smtp-1@eclipse.test>" });
    assert.ok((await listSharedThreads(sam)).some((row) => row.shareId === shared.shareId && row.count === 1));
  });

  it("tells teammates when the owner discards the draft", async () => {
    const draft = await saveMailDraft(mark, readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Bin me", body: "Hi" }), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const shared = await shareDraft(mark, draft.id, [sam.userId]);
    await discardMailDraft(mark, draft.id, outlook().fetchImpl);
    await chatWorkSettled();
    const seen = await getSharedDraft(sam, shared.shareId);
    assert.equal(seen.state, "discarded");
    assert.equal(seen.owner.name, "Mark Ridgeon");
    assert.ok(draftEventsFor(sam).some((event) => event.shareId === shared.shareId));
    assert.ok(!(await listSharedThreads(sam)).some((row) => row.shareId === shared.shareId));
  });

  it("refuses a teammate after the owner removes them", async () => {
    const draft = await saveMailDraft(mark, readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Remove", body: "Hi" }), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const shared = await shareDraft(mark, draft.id, [sam.userId, priya.userId]);
    await saveSharedDraft(sam, shared.shareId, { subject: null, body: "Sam was here" });
    await removeFromShare(mark, shared.shareId, sam.userId);
    await refused(saveSharedDraft(sam, shared.shareId, { subject: null, body: "Still here?" }), /^You no longer have access to this draft\.$/);
    await refused(getSharedDraft(sam, shared.shareId), /^You no longer have access to this draft\.$/);
    await saveSharedDraft(priya, shared.shareId, { subject: null, body: "Priya stays" });
  });
});

describe("unshared drafts", () => {
  it("send the browser's text as before", async () => {
    const draft = await saveMailDraft(mark, reply("Unshared first"), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(mark, { ...reply("Unshared final"), id: draft.id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("Unshared final"));
    assert.equal(await refuseSharedTextChange(mark, draft.id, { body: "anything" }), null);
  });
});

describe("review fixes", () => {
  async function freshShare(body: string) {
    const draft = await saveMailDraft(mark, readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Fix", body }), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const shared = await shareDraft(mark, draft.id, [sam.userId]);
    return { draft, shareId: shared.shareId };
  }

  async function version(shareId: string) {
    return (await getSharedDraft(mark, shareId)).version;
  }

  it("keeps a teammate's save made while the owner's save is talking to Outlook", async () => {
    const { draft, shareId } = await freshShare("Race start");
    const racing = outlook({
      onPatch: async () => {
        await saveSharedDraft(sam, shareId, { subject: null, body: "Sam wrote during the save" });
      },
    });
    await saveMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Fix", body: "Race start" }), id: draft.id, cc: [{ address: "ola@halden.test", name: null }] }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: racing.fetchImpl });
    assert.equal((await getSharedDraft(sam, shareId)).body, "Sam wrote during the save");
    const { fetchImpl, calls } = outlook();
    await sendMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Fix", body: "Race start" }), id: draft.id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    assert.ok(lastPatchBefore(calls, "/send")!.body.content.includes("Sam wrote during the save"));
  });

  it("keeps the share on the old draft when moving From fails part way", async () => {
    const { draft, shareId } = await freshShare("Move me");
    await saveSharedDraft(sam, shareId, { subject: null, body: "Move me, Sam's line" });
    const other = (await sql<{ id: string }>("select id from crm.mail_sources where user_id = $1 and email = 'mark@consulting.test'", [mark.userId]))[0].id;
    await assert.rejects(
      saveMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId: other, to: ["tom@halden.test"], subject: "Fix", body: "stale" }), id: draft.id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook({ failCreate: true }).fetchImpl }),
    );
    const share = (await sql<{ draft_id: string | null }>("select draft_id from crm.mail_shares where id = $1", [shareId]))[0];
    assert.equal(share.draft_id, draft.id);
    const seen = await getSharedDraft(sam, shareId);
    assert.equal(seen.state, "editing");
    assert.equal(seen.body, "Move me, Sam's line");
  });

  it("reads shareId on scheduled drafts and their unschedule", async () => {
    const { draft, shareId } = await freshShare("Scheduled read");
    const scheduled = await scheduleMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Fix", body: "x" }), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    assert.equal(scheduled.shareId, shareId);
    assert.equal((await listScheduledDrafts(mark)).find((item) => item.id === draft.id)?.shareId, shareId);
    assert.equal((await getScheduledDraft(mark, draft.id))?.shareId, shareId);
    assert.equal((await unscheduleMailDraft(mark, draft.id)).shareId, shareId);
  });

  it("refuses a save made from an older version, and takes it from the current one", async () => {
    const { shareId } = await freshShare("Versions");
    const start = await version(shareId);
    await saveSharedDraft(sam, shareId, { subject: null, body: "Versions, Sam", base: start });
    await refused(saveSharedDraft(mark, shareId, { subject: null, body: "Versions, Mark", base: start }), /This draft changed/);
    const now = await version(shareId);
    await saveSharedDraft(mark, shareId, { subject: "Fix ", body: null, base: now });
    const seen = await getSharedDraft(sam, shareId);
    assert.equal(seen.body, "Versions, Sam");
    assert.equal(seen.subject, "Fix ");
  });

  it("refuses the hold when a teammate has saved since the owner last looked, and the hold runs out", async () => {
    const { draft, shareId } = await freshShare("Hold");
    const seenByOwner = await version(shareId);
    await saveSharedDraft(sam, shareId, { subject: null, body: "Hold, Sam" });
    await refused(holdSharedDraft(mark, draft.id, true, seenByOwner), /The draft changed/);
    assert.deepEqual(await holdSharedDraft(mark, draft.id, true, await version(shareId)), { shared: true });
    await refused(saveSharedDraft(sam, shareId, { subject: null, body: "Blocked" }), /Mark is sending/);
    await sql("update crm.mail_shares set draft_held_until = now() - interval '1 second' where id = $1", [shareId]);
    assert.equal((await getSharedDraft(sam, shareId)).state, "editing");
    await saveSharedDraft(sam, shareId, { subject: null, body: "Hold, after it ran out" });
  });

  it("releases the hold when an immediate send fails", async () => {
    const { draft, shareId } = await freshShare("Fails");
    await holdSharedDraft(mark, draft.id, true, await version(shareId));
    await assert.rejects(
      sendMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Fix", body: "Fails" }), id: draft.id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook({ failSend: true }).fetchImpl }),
    );
    const held = (await sql<{ draft_held_until: Date | null }>("select draft_held_until from crm.mail_shares where id = $1", [shareId]))[0];
    assert.equal(held.draft_held_until, null);
    assert.equal((await getSharedDraft(sam, shareId)).state, "editing");
  });

  it("shows a failed scheduled send as read only and tells teammates", async () => {
    const { draft, shareId } = await freshShare("Due and fails");
    await scheduleMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Fix", body: "x" }), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    await sql("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [draft.id]);
    const [due] = await claimDueDrafts(mark, 1);
    await chatWorkSettled();
    broadcasts = [];
    await assert.rejects(sendMailDraft(mark, dueDraftInput(due), { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook({ failSend: true }).fetchImpl, claimed: true }));
    await failDueDraft(mark, due.id, "Outlook refused the recipients.");
    await chatWorkSettled();
    assert.equal((await getSharedDraft(sam, shareId)).state, "failed");
    await refused(saveSharedDraft(sam, shareId, { subject: null, body: "Edit" }), /^Couldn't send\. Read only until Mark unschedules it\.$/);
    assert.ok(draftEventsFor(sam).some((event) => event.shareId === shareId));
  });

  it("refuses a teammate who sends, schedules or discards the owner's draft by id", async () => {
    const { draft } = await freshShare("Mine");
    await assert.rejects(sendMailDraft(sam, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Fix", body: "Mine" }), id: draft.id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl }));
    await assert.rejects(
      scheduleMailDraft(sam, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Fix", body: "Mine" }), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl }),
    );
    await discardMailDraft(sam, draft.id, outlook().fetchImpl);
    const still = await sql<{ id: string; send_at: Date | null }>("select id, send_at from crm.mail_drafts where id = $1", [draft.id]);
    assert.equal(still.length, 1);
    assert.equal(still[0].send_at, null);
    assert.equal((await getSharedDraft(sam, draft.id).catch(() => null)), null);
  });
});

describe("second review fixes", () => {
  async function freshShare(body: string, subject = "Second") {
    const draft = await saveMailDraft(mark, readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject, body }), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const shared = await shareDraft(mark, draft.id, [sam.userId]);
    return { draft, shareId: shared.shareId };
  }

  async function version(shareId: string) {
    return (await getSharedDraft(mark, shareId)).version;
  }

  it("refuses a teammate's subject change on a reply, but not the owner's or a new email's", async () => {
    const draft = await sharedReply("Reply subject");
    await refused(saveSharedDraft(sam, threadShare, { subject: "Something else", body: null }), /^Only Mark can change the subject of a reply\.$/);
    await saveSharedDraft(sam, threadShare, { subject: null, body: "Reply subject, Sam" });
    await saveSharedDraft(mark, threadShare, { subject: "RE: Renewal pricing", body: null });
    const { shareId } = await freshShare("New email subject");
    await saveSharedDraft(sam, shareId, { subject: "Sam's subject", body: null });
    await discardMailDraft(mark, draft.id, outlook().fetchImpl);
  });

  it("hands back the new draft id when Outlook lost the draft and then refused the change", async () => {
    const { draft, shareId } = await freshShare("Split");
    const lost = (await sql<{ provider_draft_id: string }>("select provider_draft_id from crm.mail_drafts where id = $1", [draft.id]))[0].provider_draft_id;
    const fresh = `draft-${draftCount + 1}`;
    await assert.rejects(
      saveMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Second", body: "Split" }), id: draft.id, cc: [{ address: "ola@halden.test", name: null }] }, {
        storedFiles: "replace",
        origin: ORIGIN,
        fetchImpl: outlook({ missing: new Set([lost]), failPatch: (id) => id === fresh }).fetchImpl,
      }),
      (error: unknown) => {
        const share = error instanceof CrmError ? (error.details as { draftId?: string } | null)?.draftId : null;
        return typeof share === "string" && share !== draft.id;
      },
    );
    const now = (await sql<{ draft_id: string }>("select draft_id from crm.mail_shares where id = $1", [shareId]))[0].draft_id;
    assert.notEqual(now, draft.id);
    const saved = await saveMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Second", body: "Split" }), id: now, cc: [{ address: "ola@halden.test", name: null }] }, {
      storedFiles: "replace",
      origin: ORIGIN,
      fetchImpl: outlook().fetchImpl,
    });
    assert.equal(saved.id, now);
    assert.equal(saved.shareId, shareId);
  });

  it("finds an SMTP send's sent copy that sync imported before the send finished", async () => {
    const { draft, shareId } = await freshShare("Early copy");
    const folder = (await sql<{ id: string }>("select id from crm.mail_folders where source_id = $1 and role = 'inbox'", [sourceId]))[0].id;
    await sql(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, from_email, internet_message_id, received_at, is_draft)
       values ($1, $2, $3, $4, 'early-draft', 'conv-early', 'Second', 'mark@eclipse.test', '<early@eclipse.test>', now(), true),
              ($1, $2, $3, $4, 'early-copy', 'conv-early', 'Second', 'mark@eclipse.test', '<early@eclipse.test>', now(), false)`,
      [mark.workspaceId, mark.userId, sourceId, folder],
    );
    await sql("update crm.mail_shares set draft_id = null, draft_state = 'sent', sent_internet_id = '<early@eclipse.test>' where id = $1", [shareId]);
    await sql("delete from crm.mail_drafts where id = $1", [draft.id]);
    await sharedDraftClosed(mark, { id: shareId, members: [sam.userId] }, null, "<early@eclipse.test>");
    const share = (await sql<{ thread_key: string | null }>("select thread_key from crm.mail_shares where id = $1", [shareId]))[0];
    assert.equal(share.thread_key, "conv-early");
    assert.equal((await getSharedDraft(sam, shareId)).state, "none");
    assert.equal((await getSharedThread(sam, shareId)).draft, null);
  });

  it("follows only sent copies, never a draft with the same message id", async () => {
    const { draft, shareId } = await freshShare("Draft copy");
    const folder = (await sql<{ id: string }>("select id from crm.mail_folders where source_id = $1 and role = 'inbox'", [sourceId]))[0].id;
    await sql(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, from_email, internet_message_id, received_at, is_draft)
       values ($1, $2, $3, $4, 'only-draft', 'conv-only-draft', 'Second', 'mark@eclipse.test', '<only-draft@eclipse.test>', now(), true)`,
      [mark.workspaceId, mark.userId, sourceId, folder],
    );
    await sql("update crm.mail_shares set draft_id = null, draft_state = 'sent', sent_internet_id = '<only-draft@eclipse.test>' where id = $1", [shareId]);
    await sql("delete from crm.mail_drafts where id = $1", [draft.id]);
    await announceSharedThreads(mark.userId, sourceId, ["conv-only-draft"]);
    assert.equal((await sql<{ thread_key: string | null }>("select thread_key from crm.mail_shares where id = $1", [shareId]))[0].thread_key, null);
    assert.equal((await getSharedDraft(sam, shareId)).state, "sent");
  });

  it("refuses scheduling over a teammate's newer save, and bumps the version on hold, schedule and unschedule", async () => {
    const { draft, shareId } = await freshShare("Schedule check");
    const seenByOwner = await version(shareId);
    await saveSharedDraft(sam, shareId, { subject: null, body: "Schedule check, Sam" });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const input = { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Second", body: "x" }), id: draft.id, sendAt: at };
    await refused(scheduleMailDraft(mark, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl, shareVersion: seenByOwner }), /The draft changed/);
    assert.equal((await getSharedDraft(sam, shareId)).state, "editing");
    const before = await version(shareId);
    await scheduleMailDraft(mark, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: outlook().fetchImpl, shareVersion: before });
    const scheduled = await version(shareId);
    assert.ok(scheduled > before);
    await unscheduleMailDraft(mark, draft.id);
    const unscheduled = await version(shareId);
    assert.ok(unscheduled > scheduled);
    await holdSharedDraft(mark, draft.id, true, unscheduled);
    const held = await version(shareId);
    assert.ok(held > unscheduled);
    await holdSharedDraft(mark, draft.id, false);
    assert.ok((await version(shareId)) > held);
  });

  it("keeps the share locked against teammates while a scheduled change talks to Outlook", async () => {
    const { draft, shareId } = await freshShare("Change lock");
    await scheduleMailDraft(mark, { ...readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Second", body: "x" }), id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, {
      storedFiles: "keep",
      origin: ORIGIN,
      fetchImpl: outlook().fetchImpl,
    });
    let during = "";
    const racing = outlook({
      onPatch: async () => {
        during = (await getSharedDraft(sam, shareId)).state;
        await refused(saveSharedDraft(sam, shareId, { subject: null, body: "Sneaky" }), /is sending/);
      },
    });
    await changeScheduledDraft(mark, draft.id, { cc: ["ola@halden.test"] }, { origin: ORIGIN, fetchImpl: racing.fetchImpl });
    assert.equal(during, "sending");
    assert.equal((await getSharedDraft(sam, shareId)).state, "scheduled");
    assert.equal((await sql<{ sending_at: Date | null }>("select sending_at from crm.mail_drafts where id = $1", [draft.id]))[0].sending_at, null);
  });

  it("returns the same share when a new draft is shared twice at once", async () => {
    const draft = await saveMailDraft(mark, readDraftInput({ mode: "new", sourceId, to: ["tom@halden.test"], subject: "Twice", body: "Twice" }), { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    const [first, second] = await Promise.all([shareDraft(mark, draft.id, [sam.userId]), shareDraft(mark, draft.id, [priya.userId])]);
    assert.equal(first.shareId, second.shareId);
    const members = await sql<{ user_id: string }>("select user_id from crm.mail_share_members where share_id = $1 order by user_id", [first.shareId]);
    assert.deepEqual(members.map((row) => row.user_id).sort(), [sam.userId, priya.userId].sort());
  });
});
