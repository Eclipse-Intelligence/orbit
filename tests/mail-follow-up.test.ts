import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { readDraftInput, saveMailDraft, scheduleMailDraft, sendMailDraft } from "@/lib/mail/compose";
import { processDueMail } from "@/lib/mail/due";
import { followUpDueAt } from "@/lib/mail/follow-up-rules";
import { FOLLOW_UP_ROW_COLUMNS, followUpUnwritten, restoreFollowUp, saveFollowUpBody, sendDueFollowUp, sendFollowUpNow, writeFollowUpNow, type SendFollowUpRow } from "@/lib/mail/follow-up";
import { addFollowUp, cancelFollowUp, setMailHelp } from "@/lib/mail/prepare";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads, mailNav } from "@/lib/mail/threads";
import { listNotifications } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ORIGIN = "https://orbit.test";
const MARK = { emailAddress: { name: "Mark Ridgeon", address: "mark@eclipse.test" } };
const JANE = { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } };

type Call = { method: string; url: string; body: Record<string, unknown> | null };

let draftCount = 0;

function message(id: string, conversationId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId,
    subject: "Acme pilot",
    bodyPreview: "Could you send the pilot proposal?",
    body: { contentType: "text", content: "Could you send the pilot proposal?" },
    from: JANE,
    toRecipients: [MARK],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: "2026-11-02T16:05:00Z",
    receivedDateTime: "2026-11-02T16:05:00Z",
    isRead: true,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
    ...overrides,
  };
}

function mine(id: string, conversationId: string, body = "Here's the pilot.") {
  const now = new Date(Date.now() + 1_000).toISOString();
  return message(id, conversationId, {
    from: MARK,
    toRecipients: [JANE],
    body: { contentType: "text", content: body },
    bodyPreview: body,
    sentDateTime: now,
    receivedDateTime: now,
  });
}

const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", archive: "f-archive", deleteditems: "f-trash" };

const mailbox = { inbox: [] as unknown[], sent: [] as unknown[], remote: [] as unknown[] };

const graph = { draftInternetId: null as string | null, checkFails: false, sendFails: false };

function outlook(model: { reply?: string; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const prompts: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!url.startsWith(GRAPH) && !url.includes("login.microsoftonline.com")) {
      prompts.push(String(init?.body ?? ""));
      if (model.fail || model.reply === undefined) return Response.json({ error: { message: "Model unavailable" } }, { status: 503 });
      return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify({ body: model.reply }) }, finish_reason: "stop" }] });
    }
    if (method !== "GET") {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ method, url, body });
      const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
      if (url === `${GRAPH}/me/messages`) {
        draftCount += 1;
        return Response.json({ id: `draft-${draftCount}`, conversationId: `conv-new-${draftCount}` }, { status: 201 });
      }
      if (/\/(createReply|createReplyAll|createForward)$/.test(url)) {
        draftCount += 1;
        return Response.json({ id: `draft-${draftCount}`, subject: "RE: Acme pilot", body: { contentType: "html", content: "<html><body></body></html>" } }, { status: 201 });
      }
      if (url.endsWith("/send")) return graph.sendFails ? Response.json({ error: { message: "Outlook is down" } }, { status: 500 }) : new Response(null, { status: 202 });
      return Response.json({ id });
    }
    const conversation = url.match(/\/me\/messages\?\$filter=([^&]+)/)?.[1];
    if (conversation) {
      calls.push({ method, url, body: null });
      if (graph.checkFails) return Response.json({ error: { message: "Try later" } }, { status: 503 });
      const wanted = decodeURIComponent(conversation).match(/conversationId eq '(.+)'$/)?.[1];
      const all = [...mailbox.inbox, ...mailbox.sent, ...mailbox.remote] as { conversationId: string }[];
      return Response.json({ value: all.filter((item) => item.conversationId === wanted) });
    }
    if (/\/me\/messages\/[^/?]+\?\$select=internetMessageId$/.test(url)) return Response.json({ internetMessageId: graph.draftInternetId ?? undefined });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: [
          { id: "f-inbox", displayName: "Inbox", childFolderCount: 0 },
          { id: "f-sent", displayName: "Sent Items", childFolderCount: 0 },
          { id: "f-drafts", displayName: "Drafts", childFolderCount: 0 },
        ],
      });
    }
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = { "f-inbox": mailbox.inbox, "f-sent": mailbox.sent };
    return Response.json({ value: folder ? (pages[folder] ?? []) : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=${Math.random()}` });
  };
  return { fetchImpl, calls, prompts };
}

function sends(calls: Call[]) {
  return calls.filter((call) => call.url.endsWith("/send"));
}

function patched(calls: Call[]) {
  return calls.find((call) => call.method === "PATCH")?.body as { body: { content: string }; toRecipients: { emailAddress: { address: string } }[]; ccRecipients: unknown[] } | undefined;
}

describe("follow-ups Orbit sends when nobody replies", () => {
  let owner: UserActor;
  const admin = () => getAdminPool();

  async function sync() {
    delete process.env.LLM_API_KEY;
    try {
      await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    } finally {
      process.env.LLM_API_KEY = "test-llm-key";
    }
  }

  async function threadFor(conversation: string) {
    const all = [...(await listThreads(owner, { view: { role: "inbox" } })).threads, ...(await listThreads(owner, { view: { role: "sent" } })).threads];
    const found = all.find((item) => item.key.endsWith(`|${conversation}`));
    assert.ok(found, `no thread for ${conversation}`);
    return found;
  }

  async function startThread(conversation: string, input: { followUpDays: number; followUpBody?: string | null; syncSent?: boolean }) {
    mailbox.inbox.push(message(`in-${conversation}`, conversation));
    await sync();
    const thread = await threadFor(conversation);
    await sendMailDraft(
      owner,
      readDraftInput({ mode: "reply", messageId: thread.latestId, to: ["jane@acme.test"], body: "Here's the pilot.", followUpDays: input.followUpDays, followUpBody: input.followUpBody ?? null }),
      { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl },
    );
    if (input.syncSent !== false) {
      mailbox.sent.push(mine(`out-${conversation}`, conversation));
      await sync();
    }
    return thread.key;
  }

  async function reminder(conversation: string) {
    const result = await admin().query<{ id: string; state: string; action: string; due_at: Date; follow_up_body: string | null; recipients: unknown; sent_at: Date | null }>(
      "select id, state, action, due_at, follow_up_body, recipients, sent_at from crm.mail_reminders where thread_key = $1 order by created_at desc limit 1",
      [conversation],
    );
    return result.rows[0];
  }

  async function sendRow(conversation: string) {
    const result = await admin().query<SendFollowUpRow>(
      `select ${FOLLOW_UP_ROW_COLUMNS} from crm.mail_reminders where thread_key = $1 and action = 'send' order by created_at desc limit 1`,
      [conversation],
    );
    return result.rows[0];
  }

  async function notes() {
    return listNotifications(owner, 100);
  }

  async function makeDue(conversation: string) {
    await admin().query("update crm.mail_reminders set due_at = now() - interval '1 minute' where thread_key = $1 and state = 'waiting'", [conversation]);
  }

  before(async () => {
    await resetDatabase();
    process.env.LLM_API_KEY = "test-llm-key";
    owner = await createUser("followups@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" });
    await setMailHelp(owner, { prepareReplies: false, autoRemindDays: null });
  });

  after(async () => {
    delete process.env.LLM_API_KEY;
    await getPool().end();
  });

  it("is due at 09:00 London time after working days, skipping weekends, bank holidays and Christmas", () => {
    assert.equal(followUpDueAt(Date.parse("2026-11-04T08:12:00Z"), 3).toISOString(), "2026-11-09T09:00:00.000Z");
    assert.equal(followUpDueAt(Date.parse("2026-11-06T17:30:00Z"), 1).toISOString(), "2026-11-09T09:00:00.000Z");
    assert.equal(followUpDueAt(Date.parse("2026-11-07T10:00:00Z"), 1).toISOString(), "2026-11-09T09:00:00.000Z");
    assert.equal(followUpDueAt(Date.parse("2026-08-28T10:00:00Z"), 1).toISOString(), "2026-09-01T08:00:00.000Z");
    assert.equal(followUpDueAt(Date.parse("2026-12-23T10:00:00Z"), 1).toISOString(), "2027-01-04T09:00:00.000Z");
    assert.equal(followUpDueAt(Date.parse("2026-11-04T08:12:00Z"), 5).toISOString(), "2026-11-11T09:00:00.000Z");
  });

  it("sends the written follow-up once, in the same thread, to the same people", async () => {
    const key = await startThread("conv-written", { followUpDays: 3, followUpBody: "Hi Jane, just checking this reached you.\n\nMark" });
    const waiting = await reminder("conv-written");
    assert.equal(waiting.action, "send");
    assert.equal(waiting.state, "waiting");
    assert.ok(Math.abs(waiting.due_at.getTime() - followUpDueAt(Date.now(), 3).getTime()) < 120_000);
    assert.deepEqual(waiting.recipients, { to: [{ address: "jane@acme.test", name: null }], cc: [], bcc: [] });

    const detail = await getThread(owner, key);
    assert.equal(detail.followUp?.action, "send");
    assert.equal(detail.followUp?.body, "Hi Jane, just checking this reached you.\n\nMark");
    assert.equal((await threadFor("conv-written")).followUpAt, waiting.due_at.toISOString());

    await makeDue("conv-written");
    const run = outlook();
    const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(report.followUpsSent, 1);
    assert.equal(sends(run.calls).length, 1);
    assert.ok(run.calls.some((call) => call.url === `${GRAPH}/me/messages/out-conv-written/createReply`));
    const draft = patched(run.calls);
    assert.deepEqual(draft?.toRecipients.map((item) => item.emailAddress.address), ["jane@acme.test"]);
    assert.match(draft?.body.content ?? "", /just checking this reached you/);
    assert.equal(run.prompts.length, 0);
    const done = await reminder("conv-written");
    assert.equal(done.state, "sent");
    assert.ok(done.sent_at);
    assert.ok((await listNotifications(owner, 10)).some((note) => note.title === "Follow-up sent to Jane"));

    const again = outlook();
    await makeDue("conv-written");
    await processDueMail(owner, { fetchImpl: again.fetchImpl, origin: ORIGIN });
    assert.equal(sends(again.calls).length, 0);
  });

  it("writes it in the user's voice when it's due, even with prepared replies off", async () => {
    await startThread("conv-unwritten", { followUpDays: 2 });
    const reviewed = outlook({ reply: "Hi Jane, a draft you can see first.\n\nMark" });
    await writeFollowUpNow(owner, (await reminder("conv-unwritten")).id, { fetchImpl: reviewed.fetchImpl });
    assert.match(reviewed.prompts[0], /What the CRM knows about the people/, "a follow-up the user reviews gets the full context");
    await saveFollowUpBody(owner, (await reminder("conv-unwritten")).id, "");
    await makeDue("conv-unwritten");
    const run = outlook({ reply: "Hi Jane, did the pilot proposal land? Happy to talk it through.\n\nMark" });
    const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(report.followUpsSent, 1);
    assert.equal(run.prompts.length, 1);
    assert.match(run.prompts[0], /The conversation so far/);
    assert.doesNotMatch(run.prompts[0], /What the CRM knows|Notes from recent calls|what [^ ]+ actually sent|About /, "an unreviewed send only reads the thread and the user's voice");
    assert.ok(run.calls.some((call) => call.url.includes("/me/messages?$filter=")), "Outlook is checked for a reply just before sending");
    assert.match(patched(run.calls)?.body.content ?? "", /did the pilot proposal land/);
    assert.equal((await reminder("conv-unwritten")).follow_up_body, "Hi Jane, did the pilot proposal land? Happy to talk it through.\n\nMark");
  });

  it("cancels when someone replies, and says so in the thread", async () => {
    const key = await startThread("conv-replied", { followUpDays: 2, followUpBody: "Any thoughts?" });
    mailbox.inbox.push(
      message("reply-conv-replied", "conv-replied", { receivedDateTime: new Date(Date.now() + 60_000).toISOString(), sentDateTime: new Date(Date.now() + 60_000).toISOString(), bodyPreview: "Looks good" }),
    );
    await sync();
    const detail = await getThread(owner, key);
    assert.equal(detail.followUp, null);
    assert.equal(detail.followUpReplied?.name, "Jane");
    assert.equal(detail.followUpReplied?.messageId, detail.messages.at(-1)?.id);
    assert.equal((await threadFor("conv-replied")).followUpAt, null);

    await makeDue("conv-replied");
    const run = outlook({ reply: "Should not be used" });
    await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-replied")).state, "replied");
    assert.equal((await getThread(owner, key)).followUpReplied?.name, "Jane");
  });

  it("falls back to a reminder and sends nothing when the model fails", async () => {
    await startThread("conv-model", { followUpDays: 1 });
    await makeDue("conv-model");
    const run = outlook({ fail: true });
    const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(report.followUpsSent, 0);
    assert.equal(report.followUps, 1);
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-model")).state, "due");
    assert.equal((await threadFor("conv-model")).reminder?.kind, "follow_up");
    assert.ok((await listNotifications(owner, 20)).some((note) => note.title === "Follow-up not sent: RE: Acme pilot"));
  });

  it("doesn't send when the latest email in the thread isn't the user's", async () => {
    await startThread("conv-theirs", { followUpDays: 1, followUpBody: "Any news?", syncSent: false });
    await makeDue("conv-theirs");
    const run = outlook({ reply: "unused" });
    await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-theirs")).state, "due");
  });

  it("never sends for reminders Orbit set by itself", async () => {
    mailbox.inbox.push(message("in-conv-auto", "conv-auto"));
    mailbox.sent.push(mine("out-conv-auto", "conv-auto"));
    await sync();
    const sourceId = (await mailNav(owner)).accounts[0].id;
    await assert.rejects(
      () =>
        admin().query(
          `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, action, due_at, automatic, follow_up_body)
           values ($1, $2, $3, 'conv-auto', 'follow_up', 'send', now(), true, 'Hi')`,
          [owner.workspaceId, owner.userId, sourceId],
        ),
      /mail_reminders_action/,
    );
    await admin().query(
      `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, automatic)
       values ($1, $2, $3, 'conv-auto', 'follow_up', now() - interval '1 minute', true)`,
      [owner.workspaceId, owner.userId, sourceId],
    );
    const run = outlook({ reply: "Hi Jane" });
    const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(report.followUpsSent, 0);
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-auto")).state, "due");
  });

  it("sends now from the thread, and edits the text first", async () => {
    await startThread("conv-now", { followUpDays: 3 });
    const id = (await reminder("conv-now")).id;
    assert.deepEqual(await saveFollowUpBody(owner, id, "  Quick nudge on this.\n\nMark  "), { body: "Quick nudge on this.\n\nMark" });
    const run = outlook();
    assert.deepEqual(await sendFollowUpNow(owner, id, { origin: ORIGIN, fetchImpl: run.fetchImpl }), { sent: true, to: "Jane" });
    assert.equal(sends(run.calls).length, 1);
    await assert.rejects(() => sendFollowUpNow(owner, id, { origin: ORIGIN, fetchImpl: outlook().fetchImpl }), /already sent or cancelled/);
  });

  it("keeps the follow-up on drafts and counts from when a scheduled email actually sends", async () => {
    const sourceId = (await mailNav(owner)).accounts[0].id;
    const input = readDraftInput({ mode: "new", sourceId, to: ["jane@acme.test"], subject: "Pilot dates", body: "Shall we start on the 16th?", followUpDays: 3, followUpBody: "Any thoughts on the 16th?" });
    const saved = await saveMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    assert.equal(saved.followUpDays, 3);
    assert.equal(saved.followUpBody, "Any thoughts on the 16th?");
    assert.equal(saved.remindHours, null);
    const untouched = await saveMailDraft(owner, { ...readDraftInput({ mode: "new", sourceId, to: ["jane@acme.test"], subject: "Pilot dates", body: "Shall we start on the 16th?" }), id: saved.id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    assert.equal(untouched.followUpDays, 3);

    const scheduled = await scheduleMailDraft(owner, { ...input, id: saved.id, followUpDays: 2, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl });
    assert.equal(scheduled.followUpDays, 2);
    const threadKey = (await admin().query<{ thread_key: string }>("select thread_key from crm.mail_drafts where id = $1", [saved.id])).rows[0].thread_key;
    await admin().query("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [saved.id]);
    const report = await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: ORIGIN });
    assert.equal(report.sent, 1);
    const row = await reminder(threadKey);
    assert.equal(row.action, "send");
    assert.equal(row.follow_up_body, "Any thoughts on the 16th?");
    assert.ok(Math.abs(row.due_at.getTime() - followUpDueAt(Date.now(), 2).getTime()) < 120_000);
  });

  it("lets the assistant's send_email set a follow-up, shown on the approval card", async () => {
    mailbox.inbox.push(message("in-conv-tool", "conv-tool"));
    await sync();
    const thread = await threadFor("conv-tool");
    const args = { replyToEmailId: thread.latestId, body: "Hi Jane,\n\nHere's the pilot.\n\nMark", followUp: { afterDays: 4, body: "Hi Jane, one more on this.\n\nMark" } };
    const card = describeAction("send_email", args, await recordNames(owner, [args]));
    assert.ok(card.lines.includes("Follow-up after 4 working days if no reply:"));
    assert.ok(card.lines.includes("Hi Jane, one more on this.\n\nMark"));
    const unwritten = describeAction("send_email", { ...args, followUp: { afterDays: 1 } }, await recordNames(owner, [args]));
    assert.ok(unwritten.lines.includes("Follow-up after 1 working day if no reply. Orbit writes it then."));

    const env = outlook();
    const original = globalThis.fetch;
    globalThis.fetch = env.fetchImpl;
    try {
      const sent = (await runTool(owner, "send_email", args)) as { sent: boolean; followUpAt: string };
      assert.equal(sent.sent, true);
      assert.ok(Math.abs(Date.parse(sent.followUpAt) - followUpDueAt(Date.now(), 4).getTime()) < 120_000);
    } finally {
      globalThis.fetch = original;
    }
    const row = await reminder("conv-tool");
    assert.equal(row.action, "send");
    assert.equal(row.follow_up_body, "Hi Jane, one more on this.\n\nMark");
    const refused = (await runTool(owner, "send_email", { ...args, from: "agent" })) as { error: string };
    assert.match(refused.error, /followUp/);
  });

  it("cancelling after Orbit has claimed it stops the send, and says so once it's sending", async () => {
    await startThread("conv-claimed", { followUpDays: 1, followUpBody: "Any news?" });
    await admin().query("update crm.mail_reminders set state = 'due' where thread_key = 'conv-claimed' and state = 'waiting'");
    const row = await sendRow("conv-claimed");
    assert.equal(await cancelFollowUp(owner, row.id), 1);
    assert.equal((await reminder("conv-claimed")).state, "cancelled");
    const run = outlook();
    assert.equal(await sendDueFollowUp(owner, row, { origin: ORIGIN, fetchImpl: run.fetchImpl }), "gone");
    assert.equal(sends(run.calls).length, 0);
    await admin().query("update crm.mail_reminders set state = 'sending' where id = $1", [row.id]);
    assert.equal(await cancelFollowUp(owner, row.id), 0, "the route answers 409 when nothing changed");
    await admin().query("update crm.mail_reminders set state = 'cancelled' where id = $1", [row.id]);
  });

  it("recovers a follow-up stuck while sending without sending it again", async () => {
    await startThread("conv-stuck", { followUpDays: 1, followUpBody: "Any news?" });
    await admin().query("update crm.mail_reminders set state = 'sending', sending_at = now() - interval '11 minutes' where thread_key = 'conv-stuck'");
    const run = outlook();
    const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(report.stuck, 1);
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-stuck")).state, "due");
    assert.ok((await notes()).some((note) => note.title === "Check Sent: follow-up may not have sent"));
    const again = await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: ORIGIN });
    assert.equal(again.stuck, 0);
  });

  it("stops claiming when the deadline is close", async () => {
    await startThread("conv-deadline", { followUpDays: 1, followUpBody: "Any news?" });
    await makeDue("conv-deadline");
    const run = outlook();
    const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN, deadline: Date.now() + 1_000 });
    assert.equal(report.followUpsSent + report.followUps, 0);
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-deadline")).state, "waiting", "left for the next run");
    await admin().query("update crm.mail_reminders set state = 'cancelled' where thread_key = 'conv-deadline'");
  });

  it("checks Outlook for a reply the mirror hasn't seen yet", async () => {
    await startThread("conv-remote", { followUpDays: 1, followUpBody: "Any news?" });
    const later = new Date(Date.now() + 60_000).toISOString();
    mailbox.remote.push(message("reply-conv-remote", "conv-remote", { receivedDateTime: later, sentDateTime: later }));
    await makeDue("conv-remote");
    const run = outlook();
    const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(report.followUpsSent, 0);
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-remote")).state, "replied");
  });

  it("doesn't send when Outlook can't be checked for a reply", async () => {
    await startThread("conv-nocheck", { followUpDays: 1, followUpBody: "Any news?" });
    await makeDue("conv-nocheck");
    graph.checkFails = true;
    const run = outlook();
    try {
      const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
      assert.equal(report.followUps, 1);
    } finally {
      graph.checkFails = false;
    }
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-nocheck")).state, "due");
    assert.ok((await notes()).some((note) => /Couldn't check Outlook for a reply/.test(note.body ?? "")));
  });

  it("Undo only brings back a follow-up that's still to come and alone on the thread", async () => {
    const key = await startThread("conv-undo", { followUpDays: 3, followUpBody: "Any news?" });
    const id = (await reminder("conv-undo")).id;
    assert.equal(await cancelFollowUp(owner, id), 1);
    assert.deepEqual(await restoreFollowUp(owner, id), { restored: true });
    assert.equal(await cancelFollowUp(owner, id), 1);
    const other = await addFollowUp(owner, { thread: key, dueAt: new Date(Date.now() + 86_400_000), subject: "Acme pilot" });
    await assert.rejects(restoreFollowUp(owner, id), (error: { status?: number; message: string }) => error.status === 409 && /can't be brought back/.test(error.message));
    await cancelFollowUp(owner, other.id);
    await admin().query("update crm.mail_reminders set due_at = now() - interval '1 minute' where id = $1", [id]);
    await assert.rejects(restoreFollowUp(owner, id), (error: { status?: number }) => error.status === 409);
  });

  it("Send now keeps what Orbit wrote before sending, and a conflict is a 409", async () => {
    await startThread("conv-keep", { followUpDays: 3 });
    const id = (await reminder("conv-keep")).id;
    assert.equal(await followUpUnwritten(owner, id), true);
    graph.sendFails = true;
    try {
      await assert.rejects(
        sendFollowUpNow(owner, id, { origin: ORIGIN, fetchImpl: outlook({ reply: "Hi Jane, any thoughts?\n\nMark" }).fetchImpl }),
        (error: { status?: number }) => error.status === 502,
      );
    } finally {
      graph.sendFails = false;
    }
    const kept = await reminder("conv-keep");
    assert.equal(kept.state, "waiting");
    assert.equal(kept.follow_up_body, "Hi Jane, any thoughts?\n\nMark");
    assert.equal(await followUpUnwritten(owner, id), false);

    await startThread("conv-their-turn", { followUpDays: 3, followUpBody: "Any news?", syncSent: false });
    await assert.rejects(
      sendFollowUpNow(owner, (await reminder("conv-their-turn")).id, { origin: ORIGIN, fetchImpl: outlook().fetchImpl }),
      (error: { status?: number; message: string }) => error.status === 409 && /isn't yours/.test(error.message),
    );
  });

  it("only replies to the email it was set on, to the same people", async () => {
    graph.draftInternetId = "<out-conv-orig-ok@mail.test>";
    try {
      await startThread("conv-orig-ok", { followUpDays: 1, followUpBody: "Any news?" });
      assert.equal((await sendRow("conv-orig-ok")).original_internet_id, "<out-conv-orig-ok@mail.test>");
      await makeDue("conv-orig-ok");
      const run = outlook();
      assert.equal((await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN })).followUpsSent, 1);
      assert.equal(sends(run.calls).length, 1);

      graph.draftInternetId = "<out-conv-orig@mail.test>";
      await startThread("conv-orig", { followUpDays: 1, followUpBody: "Any news?" });
      const at = new Date(Date.now() + 2_000).toISOString();
      mailbox.sent.push(message("out2-conv-orig", "conv-orig", { from: MARK, toRecipients: [JANE], sentDateTime: at, receivedDateTime: at, bodyPreview: "One more thing" }));
      await sync();
      await makeDue("conv-orig");
      const other = outlook();
      await processDueMail(owner, { fetchImpl: other.fetchImpl, origin: ORIGIN });
      assert.equal(sends(other.calls).length, 0);
      assert.equal((await reminder("conv-orig")).state, "due");
      assert.ok((await notes()).some((note) => /sent another email since/.test(note.body ?? "")));
    } finally {
      graph.draftInternetId = null;
    }

    await startThread("conv-people", { followUpDays: 1, followUpBody: "Any news?", syncSent: false });
    mailbox.sent.push({ ...mine("out-conv-people", "conv-people"), ccRecipients: [{ emailAddress: { name: "Sam", address: "sam@acme.test" } }] });
    await sync();
    await makeDue("conv-people");
    const run = outlook();
    await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(sends(run.calls).length, 0);
    assert.ok((await notes()).some((note) => /recipients have changed/.test(note.body ?? "")));
  });

  it("won't send from a different address when the one it was sent from has gone", async () => {
    await startThread("conv-identity", { followUpDays: 1, followUpBody: "Any news?" });
    await admin().query("update crm.mail_reminders set used_identity = true, identity_id = null where thread_key = 'conv-identity'");
    await makeDue("conv-identity");
    const run = outlook();
    await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(sends(run.calls).length, 0);
    assert.equal((await reminder("conv-identity")).state, "due");
    assert.ok((await notes()).some((note) => /From address is no longer in Orbit/.test(note.body ?? "")));
  });

  it("shows who replied only for the newest follow-up with nothing else waiting", async () => {
    const key = (await threadFor("conv-replied")).key;
    assert.equal((await getThread(owner, key)).followUpReplied?.name, "Jane");
    const waiting = await addFollowUp(owner, { thread: key, dueAt: new Date(Date.now() + 86_400_000), subject: "Acme pilot" });
    assert.equal((await getThread(owner, key)).followUpReplied, null);
    await cancelFollowUp(owner, waiting.id);
    const sourceId = key.split("|")[0];
    await admin().query(
      `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, action, due_at, state, created_at)
       values ($1, $2, $3, 'conv-replied', 'follow_up', 'send', now() + interval '1 day', 'cancelled', now() + interval '2 minutes')`,
      [owner.workspaceId, owner.userId, sourceId],
    );
    assert.equal((await getThread(owner, key)).followUpReplied, null, "a newer cancelled follow-up hides the old note");
  });

  it("keeps a draft's follow-up when the assistant sends the draft", async () => {
    mailbox.inbox.push(message("in-conv-draft", "conv-draft"));
    await sync();
    const thread = await threadFor("conv-draft");
    const draft = await saveMailDraft(
      owner,
      readDraftInput({ mode: "reply", messageId: thread.latestId, to: ["jane@acme.test"], body: "Here's the pilot.", followUpDays: 2, followUpBody: "Any thoughts on the pilot?" }),
      { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook().fetchImpl },
    );
    const args = { draftId: draft.id, body: "Hi Jane,\n\nHere's the pilot.\n\nMark" };
    const card = describeAction("send_email", args, await recordNames(owner, [args]));
    assert.ok(card.lines.includes("Follow-up after 2 working days if no reply:"));
    assert.ok(card.lines.includes("Any thoughts on the pilot?"));
    const env = outlook();
    const original = globalThis.fetch;
    globalThis.fetch = env.fetchImpl;
    try {
      const sent = (await runTool(owner, "send_email", args)) as { sent: boolean; followUpAt?: string };
      assert.equal(sent.sent, true);
      assert.ok(sent.followUpAt);
    } finally {
      globalThis.fetch = original;
    }
    const row = await reminder("conv-draft");
    assert.equal(row.action, "send");
    assert.equal(row.follow_up_body, "Any thoughts on the pilot?");
  });
});
