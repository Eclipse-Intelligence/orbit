import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { applyMailAction } from "@/lib/mail/actions";
import { listScheduledDrafts, readDraftInput, saveMailDraft, scheduleMailDraft, sendMailDraft } from "@/lib/mail/compose";
import { processDueMail } from "@/lib/mail/due";
import { laterOptions } from "@/lib/mail/later";
import { syncMail } from "@/lib/mail/sync";
import { listThreads, mailNav } from "@/lib/mail/threads";
import { listNotifications } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ORIGIN = "https://orbit.test";

type Call = { method: string; url: string; body: Record<string, unknown> | null };

let draftCount = 0;

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: "conv-renewal",
    subject: "Renewal pricing",
    bodyPreview: "Can we talk?",
    body: { contentType: "html", content: "<p>Can we talk?</p>" },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
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
    webLink: null,
    ...overrides,
  };
}

const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", archive: "f-archive", deleteditems: "f-trash" };

function outlook(state: { inbox: unknown[]; sent: unknown[]; failSend?: boolean; snoozeExists?: boolean }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/me/mailFolders?$filter=")) {
      calls.push({ method, url, body: null });
      return Response.json({ value: state.snoozeExists ? [{ id: "f-snoozed", displayName: "Snoozed" }] : [] });
    }
    if (method !== "GET") {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ method, url, body });
      if (url === `${GRAPH}/me/mailFolders`) return Response.json({ id: "f-snoozed", displayName: "Snoozed" }, { status: 201 });
      const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
      if (url.endsWith("/move")) {
        const destination = String(body?.destinationId);
        return Response.json({ id, parentFolderId: FOLDERS[destination] ?? destination }, { status: 201 });
      }
      if (url === `${GRAPH}/me/messages`) {
        draftCount += 1;
        return Response.json({ id: `draft-${draftCount}`, conversationId: `conv-new-${draftCount}` }, { status: 201 });
      }
      if (/\/(createReply|createReplyAll|createForward)$/.test(url)) {
        draftCount += 1;
        return Response.json({ id: `draft-${draftCount}`, subject: "RE: Renewal pricing", body: { contentType: "html", content: "<html><body></body></html>" } }, { status: 201 });
      }
      if (url.endsWith("/send")) {
        return state.failSend ? Response.json({ error: { code: "ErrorQuotaExceeded", message: "Mailbox is full." } }, { status: 500 }) : new Response(null, { status: 202 });
      }
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
          { id: "f-archive", displayName: "Archive", childFolderCount: 0 },
          { id: "f-trash", displayName: "Deleted Items", childFolderCount: 0 },
        ],
      });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = { "f-inbox": state.inbox, "f-sent": state.sent };
    return Response.json({ value: folder ? (pages[folder] ?? []) : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=${Math.random()}` });
  };
  return { fetchImpl, calls };
}

describe("remind me, send later and follow-ups", () => {
  let owner: UserActor;
  let thread: string;
  let latestId: string;
  const state = { inbox: [message("m-1")], sent: [] as unknown[] };

  before(async () => {
    await resetDatabase();
    owner = await createUser("later@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl });
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    thread = inbox.threads[0].key;
    latestId = inbox.threads[0].latestId;
  });

  after(async () => {
    await getPool().end();
  });

  it("offers sensible times in London", () => {
    const tuesdayMorning = Date.parse("2026-10-20T08:30:00Z");
    assert.deepEqual(
      laterOptions(tuesdayMorning, "Europe/London").map((option) => [option.id, option.at]),
      [
        ["later", "2026-10-20T12:00:00.000Z"],
        ["evening", "2026-10-20T17:00:00.000Z"],
        ["tomorrow", "2026-10-21T07:00:00.000Z"],
        ["weekend", "2026-10-24T08:00:00.000Z"],
        ["next-week", "2026-10-26T08:00:00.000Z"],
      ],
    );
    const saturdayNight = Date.parse("2026-10-24T21:00:00Z");
    assert.deepEqual(laterOptions(saturdayNight, "Europe/London").map((option) => option.id), ["tomorrow", "next-week"]);
  });

  it("snoozes a conversation into a Snoozed folder in Outlook", async () => {
    await assert.rejects(() => applyMailAction(owner, { thread, action: "snooze", view: { role: "inbox" }, until: new Date(Date.now() + 10_000).toISOString() }, outlook(state).fetchImpl), /at least a minute/);
    const { fetchImpl, calls } = outlook(state);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const result = await applyMailAction(owner, { thread, action: "snooze", view: { role: "inbox" }, until }, fetchImpl);
    assert.equal(result.changed, 1);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "").split("?")[0]}`),
      ["GET /me/mailFolders", "POST /me/mailFolders", "POST /me/messages/m-1/move"],
    );
    assert.equal(calls[2].body?.destinationId, "f-snoozed");
    assert.equal((await listThreads(owner, { view: { role: "inbox" } })).threads.length, 0);
    const snoozed = await listThreads(owner, { view: { role: "snoozed" } });
    assert.equal(snoozed.threads[0].key, thread);
    assert.equal(snoozed.threads[0].snoozedUntil, until);
    assert.equal((await mailNav(owner)).snoozed, 1);
  });

  it("brings a snoozed conversation back to the top of the inbox, unread", async () => {
    await getAdminPool().query("update crm.mail_reminders set due_at = now() - interval '1 minute' where kind = 'snooze'");
    const { fetchImpl, calls } = outlook({ ...state, snoozeExists: true });
    const report = await processDueMail(owner, { fetchImpl, origin: ORIGIN });
    assert.equal(report.returned, 1);
    assert.deepEqual(calls.map((call) => [call.method, call.body]), [
      ["POST", { destinationId: "inbox" }],
      ["PATCH", { isRead: false }],
    ]);
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    assert.equal(inbox.threads[0].key, thread);
    assert.equal(inbox.threads[0].unread, true);
    assert.equal(inbox.threads[0].reminder?.kind, "snooze");
    assert.equal((await mailNav(owner)).snoozed, 0);
    await applyMailAction(owner, { thread, action: "archive", view: { role: "inbox" } }, outlook(state).fetchImpl);
    await applyMailAction(owner, { thread, action: "inbox", view: { role: "archive" } }, outlook(state).fetchImpl);
    assert.equal((await listThreads(owner, { view: { role: "inbox" } })).threads[0].reminder, null);
  });

  it("reminds you when nobody replies, and stays quiet when they do", async () => {
    const send = outlook(state);
    await sendMailDraft(
      owner,
      readDraftInput({ mode: "new", sourceId: (await mailNav(owner)).accounts[0].id, to: ["sam@acme.test"], subject: "Intro", body: "Hi Sam", remindHours: 48 }),
      { origin: ORIGIN, fetchImpl: send.fetchImpl },
    );
    const quietKey = `conv-new-${draftCount}`;
    await sendMailDraft(owner, readDraftInput({ mode: "reply", messageId: latestId, to: ["jane@acme.test"], body: "Thoughts?", remindHours: 24 }), {
      origin: ORIGIN,
      fetchImpl: send.fetchImpl,
    });
    const admin = getAdminPool();
    const reminders = await admin.query<{ thread_key: string; due_at: Date }>("select thread_key, due_at from crm.mail_reminders where kind = 'follow_up' order by created_at");
    assert.deepEqual(reminders.rows.map((row) => row.thread_key), [quietKey, "conv-renewal"]);
    assert.ok(reminders.rows[0].due_at.getTime() > Date.now() + 47 * 3_600_000);

    state.sent = [
      message("s-intro", { conversationId: quietKey, subject: "Intro", from: { emailAddress: { address: "mark@eclipse.test" } }, receivedDateTime: new Date().toISOString() }),
    ];
    state.inbox = [message("m-1"), message("m-2", { receivedDateTime: new Date(Date.now() + 60_000).toISOString(), bodyPreview: "Sounds good" })];
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl });
    await admin.query("update crm.mail_reminders set due_at = now() - interval '1 minute' where kind = 'follow_up'");
    const report = await processDueMail(owner, { fetchImpl: outlook(state).fetchImpl, origin: ORIGIN });
    assert.equal(report.followUps, 1);
    const states = await admin.query<{ thread_key: string; state: string }>("select thread_key, state from crm.mail_reminders where kind = 'follow_up' order by created_at");
    assert.deepEqual(states.rows.map((row) => [row.thread_key, row.state]), [
      [quietKey, "due"],
      ["conv-renewal", "done"],
    ]);
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    const intro = inbox.threads.find((item) => item.subject === "Intro");
    assert.equal(intro?.reminder?.kind, "follow_up");
    assert.equal(inbox.threads.find((item) => item.key === thread)?.reminder, null);
    const notes = await listNotifications(owner, 10);
    assert.ok(notes.some((note) => note.title === "No reply yet: Intro"));
  });

  it("sends a scheduled email when it is due and reports a failure", async () => {
    const sourceId = (await mailNav(owner)).accounts[0].id;
    const input = readDraftInput({ mode: "new", sourceId, to: ["sam@acme.test"], subject: "Monday plan", body: "See you Monday" });
    await assert.rejects(() => scheduleMailDraft(owner, { ...input, sendAt: new Date(Date.now() + 5_000).toISOString() }, { origin: ORIGIN, fetchImpl: outlook(state).fetchImpl }), /at least a minute/);
    const scheduled = await scheduleMailDraft(owner, { ...input, sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { origin: ORIGIN, fetchImpl: outlook(state).fetchImpl });
    assert.ok(scheduled.sendAt);
    assert.equal((await mailNav(owner)).scheduled, 1);
    assert.equal((await processDueMail(owner, { fetchImpl: outlook(state).fetchImpl, origin: ORIGIN })).sent, 0);

    const admin = getAdminPool();
    await admin.query("update crm.mail_drafts set send_at = now() - interval '1 minute'");
    const { fetchImpl, calls } = outlook(state);
    const report = await processDueMail(owner, { fetchImpl, origin: ORIGIN });
    assert.equal(report.sent, 1);
    assert.deepEqual(calls.map((call) => call.method), ["POST"]);
    assert.ok(calls[0].url.endsWith("/send"));
    assert.equal((await listScheduledDrafts(owner)).length, 0);

    const failing = await scheduleMailDraft(owner, { ...input, subject: "Will fail", sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { origin: ORIGIN, fetchImpl: outlook(state).fetchImpl });
    await admin.query("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [failing.id]);
    const failed = await processDueMail(owner, { fetchImpl: outlook({ ...state, failSend: true }).fetchImpl, origin: ORIGIN });
    assert.equal(failed.failed, 1);
    const left = await listScheduledDrafts(owner);
    assert.equal(left[0].sendAt, null);
    assert.equal(left[0].sendError, "Mailbox is full.");
    assert.ok((await listNotifications(owner, 10)).some((note) => note.title === "Scheduled email didn't send: Will fail"));
  });

  it("skips the Outlook update when a draft hasn't changed", async () => {
    const sourceId = (await mailNav(owner)).accounts[0].id;
    const input = readDraftInput({ mode: "new", sourceId, to: ["sam@acme.test"], subject: "Same", body: "Unchanged" });
    const first = outlook(state);
    const draft = await saveMailDraft(owner, input, { origin: ORIGIN, fetchImpl: first.fetchImpl });
    assert.equal(first.calls.length, 2);
    const again = outlook(state);
    await saveMailDraft(owner, { ...input, id: draft.id }, { origin: ORIGIN, fetchImpl: again.fetchImpl });
    assert.equal(again.calls.length, 0);
  });
});
