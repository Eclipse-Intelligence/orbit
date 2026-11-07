import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { applyMailAction } from "@/lib/mail/actions";
import {
  ALREADY_SENDING,
  ALREADY_SENT_WARNING,
  MAYBE_SENT,
  readDraftInput,
  saveMailDraft,
  scheduleMailDraft,
  SEND_UNCONFIRMED,
  sendMailDraft,
  unscheduleMailDraft,
  claimDueDrafts,
} from "@/lib/mail/compose";
import { processDueMail, REMINDER_ATTEMPTS } from "@/lib/mail/due";
import { GraphMailError, reconnectProblem, sendOutcomeUnknown } from "@/lib/mail/microsoft";
import { attachmentBlock } from "@/lib/mail/send-ready";
import { mailSourceToken, syncMail } from "@/lib/mail/sync";
import { mailNav } from "@/lib/mail/threads";
import { MicrosoftTokenError } from "@/lib/microsoft/oauth";
import { listNotifications } from "@/lib/workflows/store";
import {
  cachedList,
  cachedThread,
  dwellReadDue,
  forgetDwellRead,
  holdQueuedDraft,
  noteDwellRead,
  OFFLINE,
  refreshProblem,
  restoreToList,
  sameList,
  statusProblem,
  storeList,
  storeThread,
  syncNow,
} from "@/components/mail/mail-cache";
import type { ThreadDetail, ThreadSummary } from "@/lib/mail/view";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ORIGIN = "https://orbit.test";

type SendMode = "ok" | "lost-answer" | "no-answer" | "gateway" | "vanished" | "sent-elsewhere" | "refused";
type Call = { method: string; url: string };
type Draft = { isDraft: boolean; internetMessageId: string; conversationId: string; subject: string };

function outlook(send: SendMode = "ok") {
  const calls: Call[] = [];
  const drafts = new Map<string, Draft>();
  const sent: (Draft & { sentDateTime: string })[] = [];
  let count = 0;
  const notFound = () => Response.json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, { status: 404 });
  const moveToSent = (id: string) => {
    const draft = drafts.get(id)!;
    drafts.delete(id);
    sent.push({ ...draft, isDraft: false, sentDateTime: new Date().toISOString() });
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
    if (method === "POST" && url === `${GRAPH}/me/messages`) {
      count += 1;
      const made = `draft-${randomUUID()}`;
      drafts.set(made, { isDraft: true, internetMessageId: `<${made}@outlook.test>`, conversationId: `conv-${made}`, subject: "" });
      return Response.json({ id: made, conversationId: `conv-${made}`, subject: "" }, { status: 201 });
    }
    if (method === "PATCH" && id) {
      const draft = drafts.get(id);
      if (!draft) return notFound();
      draft.subject = String((JSON.parse(String(init?.body ?? "{}")) as { subject?: string }).subject ?? "");
      return Response.json({ id });
    }
    if (method === "POST" && url.endsWith("/send")) {
      if (!drafts.has(id)) return notFound();
      if (send === "ok") {
        moveToSent(id);
        return new Response(null, { status: 202 });
      }
      if (send === "lost-answer") {
        moveToSent(id);
        throw new TypeError("fetch failed");
      }
      if (send === "no-answer") throw new TypeError("fetch failed");
      if (send === "gateway") return new Response("<html>Gateway Timeout</html>", { status: 504 });
      if (send === "vanished") {
        drafts.delete(id);
        return notFound();
      }
      if (send === "sent-elsewhere") {
        moveToSent(id);
        return notFound();
      }
      return Response.json({ error: { code: "ErrorInvalidRecipients", message: "At least one recipient isn't valid." } }, { status: 400 });
    }
    if (method === "GET" && id && url.includes("$select=internetMessageId")) {
      const draft = drafts.get(id);
      return draft ? Response.json({ id, internetMessageId: draft.internetMessageId }) : notFound();
    }
    if (method === "GET" && id && url.includes("$select=id,isDraft")) {
      const draft = drafts.get(id);
      return draft ? Response.json({ id, isDraft: true }) : notFound();
    }
    if (method === "GET" && url.startsWith(`${GRAPH}/me/messages?$filter=`)) {
      const wanted = decodeURIComponent(url).match(/internetMessageId eq '([^']+)'/)?.[1];
      return Response.json({ value: sent.filter((item) => item.internetMessageId === wanted).map((item) => ({ id: item.internetMessageId, isDraft: false })) });
    }
    if (method === "GET" && url.startsWith(`${GRAPH}/me/mailFolders/sentitems/messages?$filter=`)) {
      const wanted = decodeURIComponent(url).match(/conversationId eq '([^']+)'/)?.[1];
      return Response.json({ value: sent.filter((item) => item.conversationId === wanted).map((item) => ({ id: item.internetMessageId, subject: item.subject, sentDateTime: item.sentDateTime, isDraft: false })) });
    }
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return Response.json({ id: `f-${named[1]}` });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }, { id: "f-sentitems", displayName: "Sent Items", childFolderCount: 0 }] });
    }
    if (method !== "GET") return Response.json({ id: "x" });
    return Response.json({ value: [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/x/messages/delta?$deltatoken=${Math.random()}` });
  };
  const sends = () => calls.filter((call) => call.method === "POST" && call.url.endsWith("/send")).length;
  const created = () => calls.filter((call) => call.method === "POST" && call.url === `${GRAPH}/me/messages`).length;
  return { fetchImpl, calls, sent, drafts, sends, created, count: () => count };
}

describe("mail sending and actions that don't repeat or go quiet", () => {
  let owner: UserActor;
  let sourceId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("reliable@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    sourceId = (await mailNav(owner)).accounts[0].id;
  });

  after(async () => {
    await getPool().end();
  });

  const draftFor = async (box: ReturnType<typeof outlook>, subject: string) => {
    const input = readDraftInput({ mode: "new", sourceId, to: ["sam@acme.test"], subject, body: "Only once, please" });
    const draft = await saveMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl });
    return { input: { ...input, id: draft.id }, id: draft.id };
  };

  const draftRow = async (id: string) =>
    (await getAdminPool().query<{ send_attempted_at: Date | null; sending_at: Date | null }>("select send_attempted_at, sending_at from crm.mail_drafts where id = $1", [id])).rows[0] ?? null;

  it("doesn't send again when Outlook took the email but the answer was lost", async () => {
    const box = outlook("lost-answer");
    const { input, id } = await draftFor(box, "Lost answer");
    await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl }), { message: SEND_UNCONFIRMED });
    const kept = await draftRow(id);
    assert.ok(kept?.send_attempted_at);
    assert.equal(kept?.sending_at, null);

    const retry = outlook("ok");
    retry.sent.push(...box.sent);
    const result = await sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: retry.fetchImpl });
    assert.equal(result.warning, ALREADY_SENT_WARNING);
    assert.equal(retry.sends(), 0);
    assert.equal(retry.created(), 0);
    assert.equal(await draftRow(id), null);
  });

  it("finds the earlier send by its conversation when Outlook gave no message id", async () => {
    const box = outlook("lost-answer");
    const { input, id } = await draftFor(box, "No message id");
    await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl }), { message: SEND_UNCONFIRMED });
    await getAdminPool().query("update crm.mail_drafts set sent_internet_id = null where id = $1", [id]);
    const retry = outlook("ok");
    retry.sent.push(...box.sent);
    assert.equal((await sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: retry.fetchImpl })).warning, ALREADY_SENT_WARNING);
    assert.equal(retry.sends(), 0);
  });

  it("refuses to send again while it can't tell, then sends once the draft is clearly unsent", async () => {
    const box = outlook("no-answer");
    const { input, id } = await draftFor(box, "Unknown outcome");
    await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl }), { message: SEND_UNCONFIRMED });

    const soon = outlook("ok");
    for (const [key, value] of box.drafts) soon.drafts.set(key, value);
    await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: soon.fetchImpl }), { message: MAYBE_SENT });
    assert.equal(soon.sends(), 0);
    assert.equal(soon.created(), 0);

    await getAdminPool().query("update crm.mail_drafts set send_attempted_at = now() - interval '5 minutes' where id = $1", [id]);
    const later = outlook("ok");
    for (const [key, value] of box.drafts) later.drafts.set(key, value);
    assert.equal((await sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: later.fetchImpl })).warning, null);
    assert.equal(later.sends(), 1);
    assert.equal(later.created(), 0);
  });

  it("treats a gateway timeout on send as unconfirmed", async () => {
    const box = outlook("gateway");
    const { input, id } = await draftFor(box, "Gateway");
    await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl }), { message: SEND_UNCONFIRMED });
    assert.ok((await draftRow(id))?.send_attempted_at);
    assert.equal(sendOutcomeUnknown(new GraphMailError("Mailbox is full.", 500, "ErrorQuotaExceeded")), false);
    assert.equal(sendOutcomeUnknown(new GraphMailError("Busy.", 503, "")), true);
    assert.equal(sendOutcomeUnknown(new TypeError("fetch failed")), true);
  });

  it("never makes and sends a new draft when the draft vanishes at send time", async () => {
    const box = outlook("vanished");
    const { input } = await draftFor(box, "Vanished");
    await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl }), { message: MAYBE_SENT });
    assert.equal(box.sends(), 1);
    assert.equal(box.created(), 1);

    const elsewhere = outlook("sent-elsewhere");
    const second = await draftFor(elsewhere, "Sent from Outlook");
    const result = await sendMailDraft(owner, second.input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: elsewhere.fetchImpl });
    assert.equal(result.warning, ALREADY_SENT_WARNING);
    assert.equal(elsewhere.created(), 1);
    assert.equal(await draftRow(second.id), null);
  });

  it("lets a clearly refused send go again straight away", async () => {
    const box = outlook("refused");
    const { input, id } = await draftFor(box, "Refused");
    await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl }), /recipient/);
    assert.equal((await draftRow(id))?.send_attempted_at, null);
    const again = outlook("ok");
    for (const [key, value] of box.drafts) again.drafts.set(key, value);
    await sendMailDraft(owner, input, { storedFiles: "keep", origin: ORIGIN, fetchImpl: again.fetchImpl });
    assert.equal(again.sends(), 1);
  });

  it("sends once for a double submit before the draft exists, and answers a repeat with success", async () => {
    const box = outlook("ok");
    const sendKey = randomUUID();
    const input = { ...readDraftInput({ mode: "new", sourceId, to: ["sam@acme.test"], subject: "Double click", body: "Once" }), sendKey };
    const results = await Promise.allSettled([
      sendMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl }),
      sendMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl }),
    ]);
    assert.equal(box.sends(), 1);
    assert.equal(box.created(), 1);
    for (const result of results) if (result.status === "rejected") assert.equal(result.reason.message, ALREADY_SENDING);

    const racing = outlook("ok");
    const raced = { ...input, sendKey: randomUUID(), subject: "Many clicks" };
    await Promise.allSettled(Array.from({ length: 4 }, () => sendMailDraft(owner, raced, { storedFiles: "replace", origin: ORIGIN, fetchImpl: racing.fetchImpl })));
    assert.equal(racing.sends(), 1);
    assert.equal(racing.created(), 1);

    const repeat = outlook("ok");
    assert.deepEqual(await sendMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: repeat.fetchImpl }), { warning: null });
    assert.equal(repeat.calls.length, 0);
  });

  it("reuses the draft from a failed keyed send instead of making another", async () => {
    const box = outlook("refused");
    const sendKey = randomUUID();
    const input = { ...readDraftInput({ mode: "new", sourceId, to: ["sam@acme.test"], subject: "Keyed retry", body: "Once" }), sendKey };
    await assert.rejects(() => sendMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl }));
    const again = outlook("ok");
    for (const [key, value] of box.drafts) again.drafts.set(key, value);
    await sendMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: again.fetchImpl });
    assert.equal(again.created(), 0);
    assert.equal(again.sends(), 1);
    const left = await getAdminPool().query("select 1 from crm.mail_drafts where user_id = $1 and subject = 'Keyed retry'", [owner.userId]);
    assert.equal(left.rowCount, 0);
  });

  it("won't unschedule an email the scheduler is already sending", async () => {
    const box = outlook("ok");
    const input = readDraftInput({ mode: "new", sourceId, to: ["sam@acme.test"], subject: "Unschedule", body: "Later" });
    const draft = await scheduleMailDraft(owner, { ...input, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: box.fetchImpl });
    assert.equal((await unscheduleMailDraft(owner, draft.id)).sendAt, null);
    await scheduleMailDraft(owner, { ...input, id: draft.id, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "keep", origin: ORIGIN, fetchImpl: box.fetchImpl });
    await getAdminPool().query("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [draft.id]);
    assert.equal((await claimDueDrafts(owner, 1))[0].id, draft.id);
    await assert.rejects(() => unscheduleMailDraft(owner, draft.id), /isn't waiting to send/);
    await getAdminPool().query("delete from crm.mail_drafts where id = $1", [draft.id]);
    await assert.rejects(() => unscheduleMailDraft(owner, draft.id), /isn't in Orbit Mail any more/);
  });

  it("stops retrying a failing reminder after a few attempts and says so", async () => {
    const admin = getAdminPool();
    const reminder = await admin.query<{ id: string }>(
      `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, subject)
       values ($1, $2, $3, 'conv-missing', 'snooze', now() - interval '1 minute', 'Gone missing') returning id`,
      [owner.workspaceId, owner.userId, sourceId],
    );
    const id = reminder.rows[0].id;
    const read = async () =>
      (await admin.query<{ state: string; attempts: number; last_error: string | null; later: boolean }>("select state, attempts, last_error, due_at > now() as later from crm.mail_reminders where id = $1", [id]))
        .rows[0];
    for (let attempt = 1; attempt < REMINDER_ATTEMPTS; attempt += 1) {
      const report = await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: ORIGIN });
      assert.equal(report.reminderErrors, 1);
      const row = await read();
      assert.deepEqual([row.state, row.attempts, row.later], ["waiting", attempt, true]);
      assert.match(row.last_error ?? "", /Conversation not found/);
      await admin.query("update crm.mail_reminders set due_at = now() - interval '1 minute' where id = $1", [id]);
    }
    await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: ORIGIN });
    const last = await read();
    assert.deepEqual([last.state, last.attempts], ["due", REMINDER_ATTEMPTS]);
    const quiet = await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: ORIGIN });
    assert.equal(quiet.reminderErrors, 0);
    assert.ok((await listNotifications(owner, 20)).some((note) => note.title === "Orbit couldn't bring back: Gone missing"));
  });

  it("names the account and the fix when Microsoft refuses", async () => {
    assert.equal(reconnectProblem(new GraphMailError("x", 401), "mark@geteclipse.co"), "Reconnect mark@geteclipse.co in Settings › Email. Microsoft has signed Orbit out of it.");
    assert.match(reconnectProblem(new GraphMailError("x", 403, "ErrorAccessDenied"), "mark@geteclipse.co") ?? "", /^Reconnect mark@geteclipse.co in Settings › Email and allow every permission/);
    assert.match(reconnectProblem(new GraphMailError("x", 403, "AADSTS65001 consent_required"), "mark@geteclipse.co") ?? "", /^Ask your Microsoft admin to approve Orbit for mark@geteclipse.co/);
    assert.match(reconnectProblem(new MicrosoftTokenError("AADSTS70008: invalid_grant, the refresh token has expired"), "mark@geteclipse.co") ?? "", /^Reconnect mark@geteclipse.co in Settings › Email\./);
    assert.equal(reconnectProblem(new GraphMailError("Busy", 503), "mark@geteclipse.co"), null);

    const refusing: typeof fetch = async () => Response.json({ error: { code: "InvalidAuthenticationToken", message: "Expired" } }, { status: 401 });
    const threadKey = `${sourceId}|conv-signed-out`;
    const admin = getAdminPool();
    const folder = (await admin.query<{ id: string }>("select id from crm.mail_folders where source_id = $1 and role = 'inbox'", [sourceId])).rows[0].id;
    await admin.query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, is_read, received_at)
       values ($1, $2, $3, $4, 'm-signed-out', 'conv-signed-out', 'Hello', false, now())`,
      [owner.workspaceId, owner.userId, sourceId, folder],
    );
    await assert.rejects(() => applyMailAction(owner, { thread: threadKey, action: "read" }, refusing), {
      message: "Reconnect mark@eclipse.test in Settings › Email. Microsoft has signed Orbit out of it.",
    });

    await admin.query("update crm.mailbox_connections set status = 'disconnected' where user_id = $1", [owner.userId]);
    await assert.rejects(() => mailSourceToken(owner, sourceId), { message: "Reconnect mark@eclipse.test in Settings › Email. It isn't connected to Orbit any more." });
    await admin.query("update crm.mailbox_connections set status = 'connected' where user_id = $1", [owner.userId]);
  });
});

describe("send readiness and the Mail cache", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  it("blocks Send while an attachment is uploading or after one failed", () => {
    assert.equal(attachmentBlock([{ name: "deck.pdf", status: "ready" }]), null);
    assert.equal(attachmentBlock([{ name: "deck.pdf", status: "uploading" }]), "Wait for deck.pdf to finish uploading.");
    assert.equal(attachmentBlock([{ name: "a.pdf", status: "uploading" }, { name: "b.pdf", status: "uploading" }]), "Wait for 2 attachments to finish uploading.");
    assert.equal(attachmentBlock([{ name: "deck.pdf", status: "failed" }, { name: "b.pdf", status: "uploading" }]), "deck.pdf didn't upload. Remove it or attach it again to send.");
  });

  it("shows a refresh problem once, then again when it changes or after a while", () => {
    assert.equal(refreshProblem("Reconnect mark@eclipse.test in Settings › Email.", 0), "Reconnect mark@eclipse.test in Settings › Email.");
    assert.equal(refreshProblem("Reconnect mark@eclipse.test in Settings › Email.", 60_000), null);
    assert.equal(refreshProblem("Mail didn't refresh. Try again.", 61_000), "Mail didn't refresh. Try again.");
    assert.equal(refreshProblem("Mail didn't refresh. Try again.", 61_000 + 6 * 60_000), "Mail didn't refresh. Try again.");
    assert.equal(refreshProblem(null), null);
    assert.equal(refreshProblem("Mail didn't refresh. Try again.", 61_001 + 6 * 60_000), "Mail didn't refresh. Try again.");
  });

  it("explains a failed request instead of a generic message", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(() => syncNow(), { message: OFFLINE });
    globalThis.fetch = (async () => new Response("<html>Gateway Timeout</html>", { status: 504 })) as typeof fetch;
    await assert.rejects(() => syncNow(), { message: statusProblem(504) });
    globalThis.fetch = (async () => Response.json({ error: "Reconnect mark@eclipse.test in Settings › Email." }, { status: 502 })) as typeof fetch;
    await assert.rejects(() => syncNow(), { message: "Reconnect mark@eclipse.test in Settings › Email." });
  });

  it("tries a dwell read once per message, and again after Mark unread", () => {
    assert.equal(dwellReadDue("t-1", "m-1"), true);
    noteDwellRead("t-1", "m-1");
    assert.equal(dwellReadDue("t-1", "m-1"), false);
    assert.equal(dwellReadDue("t-1", "m-2"), true);
    forgetDwellRead("t-1");
    assert.equal(dwellReadDue("t-1", "m-1"), true);
  });

  it("restores a thread only into the list it came from", () => {
    const thread = { key: "t-restore", latestAt: "2026-11-01T10:00:00Z" } as ThreadSummary;
    const inbox = { view: "inbox", account: null, query: "" };
    const archive = { view: "archive", account: null, query: "" };
    storeList(inbox, { threads: [{ key: "t-old", latestAt: "2026-10-01T10:00:00Z" } as ThreadSummary], next: null });
    storeList(archive, { threads: [], next: null });
    assert.equal(sameList(inbox, { ...inbox }), true);
    assert.equal(sameList(inbox, archive), false);
    restoreToList(inbox, thread);
    restoreToList(inbox, thread);
    assert.deepEqual(cachedList(inbox)?.threads.map((item) => item.key), ["t-restore", "t-old"]);
    assert.deepEqual(cachedList(archive)?.threads, []);
  });

  it("drops a draft from the cache as soon as its send is queued", async () => {
    const detail = { key: "t-draft", drafts: [{ id: "d-1" }, { id: "d-2" }], messages: [] } as unknown as ThreadDetail;
    storeThread(detail);
    let resolve: (value: { id: string | null }) => void = () => undefined;
    const payload = new Promise<{ id: string | null }>((done) => (resolve = done));
    const release = holdQueuedDraft("d-1", payload);
    assert.deepEqual(cachedThread("t-draft")?.drafts.map((draft) => draft.id), ["d-2"]);
    resolve({ id: "d-2" });
    await payload;
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(cachedThread("t-draft")?.drafts.map((draft) => draft.id), []);
    storeThread(detail);
    assert.deepEqual(cachedThread("t-draft")?.drafts.map((draft) => draft.id), []);
    release();
    await new Promise((done) => setImmediate(done));
    storeThread(detail);
    assert.deepEqual(cachedThread("t-draft")?.drafts.map((draft) => draft.id), ["d-1", "d-2"]);
  });
});
