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
import { saveFollowUpBody, sendFollowUpNow } from "@/lib/mail/follow-up";
import { setMailHelp } from "@/lib/mail/prepare";
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

const mailbox = { inbox: [] as unknown[], sent: [] as unknown[] };

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
      if (url.endsWith("/send")) return new Response(null, { status: 202 });
      return Response.json({ id });
    }
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
    await makeDue("conv-unwritten");
    const run = outlook({ reply: "Hi Jane, did the pilot proposal land? Happy to talk it through.\n\nMark" });
    const report = await processDueMail(owner, { fetchImpl: run.fetchImpl, origin: ORIGIN });
    assert.equal(report.followUpsSent, 1);
    assert.equal(run.prompts.length, 1);
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
    await assert.rejects(() => sendFollowUpNow(owner, id, { origin: ORIGIN, fetchImpl: outlook().fetchImpl }), /isn't waiting any more/);
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
    assert.ok(card.lines.includes("Follow-up: sent in the same thread at 09:00 after 4 working days if nobody replies:"));
    assert.ok(card.lines.includes("Hi Jane, one more on this.\n\nMark"));
    const unwritten = describeAction("send_email", { ...args, followUp: { afterDays: 1 } }, await recordNames(owner, [args]));
    assert.ok(unwritten.lines.includes("Follow-up: sent in the same thread at 09:00 after 1 working day if nobody replies. Orbit writes it then, in your voice."));

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
});
