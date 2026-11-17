import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { scopesForRole } from "@/lib/crm/scopes";
import { createWorkspace } from "@/lib/crm/workspaces";
import { saveMailbox } from "@/lib/crm/inbox";
import { dayKey, dayKeyAt } from "@/lib/crm/task-due";
import { clockLabel, dayStartIso } from "@/lib/crm/task-time";
import { archiveTask, getTask, updateTask } from "@/lib/crm/tasks";
import { setTaskRepeat } from "@/lib/crm/task-series";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { deferralOptions, normalizeDeferral, resolveDeferral } from "@/lib/mail/deferral-dates";
import { applyDeferral, cancelDeferral, moveDeferral, settleDeferrals } from "@/lib/mail/deferrals";
import { finishReminder, waitingMail } from "@/lib/mail/waiting";
import { addFollowUp, cancelFollowUp, prepareMail, prepareNudge, setMailHelp } from "@/lib/mail/prepare";
import { syncMail } from "@/lib/mail/sync";
import { getThread } from "@/lib/mail/threads";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function ago(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function message(id: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: "Acme pilot: proposal and next steps",
    bodyPreview: "",
    body: { contentType: "text", content: text },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: ago(1),
    receivedDateTime: ago(1),
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
    ...overrides,
  };
}

function mailbox(state: { inbox: unknown[]; sent: unknown[] }): typeof fetch {
  return async (input) => {
    const url = String(input);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }, { id: "f-sent", displayName: "Sent Items", childFolderCount: 0 }] });
    }
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = { "f-inbox": state.inbox, "f-sent": state.sent };
    const value = folder ? (pages[folder] ?? []) : [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${Math.random()}` });
  };
}

function model(replies: unknown[]) {
  const prompts: { system: string; user: string }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push({ system: body.messages[0].content, user: body.messages[1].content });
    return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify(replies.shift()) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, prompts };
}

const soon = () => Date.now() + 60_000;

function monthsAhead(months: number) {
  const now = new Date();
  const index = now.getUTCMonth() + months;
  return dayKey(now.getUTCFullYear() + Math.floor(index / 12), (index % 12) + 1, 1);
}

before(async () => {
  await resetDatabase();
});

after(async () => {
  delete process.env.LLM_API_KEY;
  await getPool().end();
});

describe("resolving when someone asked to pick things up", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");

  it("turns a month into a working Monday at 09:00, later in January after the Christmas break", () => {
    assert.equal(resolveDeferral({ precision: "month", date: "2027-01-01" }, now, "Europe/London")?.toISOString(), "2027-01-11T09:00:00.000Z");
    assert.equal(resolveDeferral({ precision: "year", date: "2027-01-01" }, now, "Europe/London")?.toISOString(), "2027-01-11T09:00:00.000Z", "next year means January");
    assert.equal(resolveDeferral({ precision: "month", date: "2027-02-01" }, now, "Europe/London")?.toISOString(), "2027-02-01T09:00:00.000Z");
  });

  it("puts after Q1 in early April and skips bank holidays", () => {
    assert.equal(resolveDeferral({ precision: "quarter", date: "2027-04-01" }, now, "Europe/London")?.toISOString(), "2027-04-05T08:00:00.000Z");
    const march = Date.parse("2026-03-02T12:00:00Z");
    assert.equal(resolveDeferral({ precision: "month", date: "2026-04-01" }, march, "Europe/London")?.toISOString(), "2026-04-07T08:00:00.000Z", "Easter Monday moves it to Tuesday");
  });

  it("uses the Monday for a week and the next working day for a day", () => {
    assert.equal(resolveDeferral({ precision: "week", date: "2026-11-11" }, now, "Europe/London")?.toISOString(), "2026-11-09T09:00:00.000Z");
    assert.equal(resolveDeferral({ precision: "day", date: "2026-11-20" }, now, "Europe/London")?.toISOString(), "2026-11-20T09:00:00.000Z");
    assert.equal(resolveDeferral({ precision: "day", date: "2026-12-25" }, now, "Europe/London")?.toISOString(), "2027-01-04T09:00:00.000Z");
  });

  it("ignores dates in the past, too soon, too far off or not real", () => {
    assert.equal(resolveDeferral({ precision: "month", date: "2026-10-01" }, now, "Europe/London"), null);
    assert.equal(resolveDeferral({ precision: "day", date: "2026-11-03" }, now, "Europe/London"), null);
    assert.equal(resolveDeferral({ precision: "year", date: "2028-01-01" }, now, "Europe/London"), null);
    assert.equal(resolveDeferral({ precision: "day", date: "2027-02-30" }, now, "Europe/London"), null);
  });

  it("starts a named period that has already begun from the next working day", () => {
    const tuesday = Date.parse("2026-11-17T10:00:00Z");
    assert.equal(resolveDeferral({ precision: "month", date: "2026-11-01" }, tuesday, "Europe/London")?.toISOString(), "2026-11-18T09:00:00.000Z", "later this month");
    assert.equal(resolveDeferral({ precision: "day", date: "2026-11-18" }, tuesday, "Europe/London")?.toISOString(), "2026-11-18T09:00:00.000Z", "speak tomorrow, said after 09:00");
    assert.equal(resolveDeferral({ precision: "day", date: "2026-11-17" }, tuesday, "Europe/London"), null, "today isn't a deferral");
    const sundayEvening = Date.parse("2026-11-22T20:00:00Z");
    assert.equal(resolveDeferral({ precision: "week", date: "2026-11-23" }, sundayEvening, "Europe/London")?.toISOString(), "2026-11-23T09:00:00.000Z", "next week, sent on a Sunday evening");
    const january = Date.parse("2027-01-20T10:00:00Z");
    assert.equal(resolveDeferral({ precision: "quarter", date: "2027-01-01" }, january, "Europe/London")?.toISOString(), "2027-01-21T09:00:00.000Z", "in Q1, said in January");
    const newYear = Date.parse("2026-01-03T10:00:00Z");
    assert.equal(resolveDeferral({ precision: "year", date: "2027-01-01" }, newYear, "Europe/London")?.toISOString(), "2027-01-11T09:00:00.000Z", "next year, said early in January");
  });

  it("reads loose model answers and refuses ones it can't place", () => {
    assert.deepEqual(normalizeDeferral({ precision: "Months", date: "2027-01" }), { precision: "month", date: "2027-01-01" });
    assert.deepEqual(normalizeDeferral({ precision: "year", date: "2027" }), { precision: "year", date: "2027-01-01" });
    assert.deepEqual(normalizeDeferral({ precision: "day", date: "2026-11-25T09:00:00Z" }), { precision: "day", date: "2026-11-25" });
    assert.equal(normalizeDeferral({ precision: "soon", date: "2027-01-01" }), null);
    assert.equal(normalizeDeferral({ precision: "day", date: "next week" }), null);
  });

  it("offers later dates to change to", () => {
    const options = deferralOptions(now, "Europe/London");
    assert.deepEqual(options.map((option) => option.label), ["Next week", "In two weeks", "Next month", "In three months"]);
    assert.equal(options[0].at, "2026-11-09T09:00:00.000Z");
    assert.equal(options[2].at, "2026-12-07T09:00:00.000Z");
  });
});

describe("not now replies", () => {
  let owner: UserActor;
  let thread: string;
  const when = monthsAhead(2);

  before(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    owner = await createUser("defer@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const acme = (await createCompany(owner, { name: "Acme", domain: "acme.test" })).body.company.id;
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test", companyId: acme });
    await setMailHelp(owner, { prepareReplies: false, autoRemindDays: null });
    await syncMail(owner, {
      budgetMs: 30_000,
      fetchImpl: mailbox({
        inbox: [
          message("m-defer", "Hi Mark,\n\nThanks for sending this over. Can we pick this up in January? Next year's budget is signed off just before Christmas.\n\nJane"),
          message("m-stranger", "Love to chat, but try me next quarter.", { from: { emailAddress: { name: "Sam Stranger", address: "sam@unknown-co.test" } } }),
        ],
        sent: [],
      }),
    });
    const row = (await getAdminPool().query<{ source_id: string; thread_key: string }>("select source_id, thread_key from crm.mail_messages where provider_message_id = 'm-defer'")).rows[0];
    thread = `${row.source_id}|${row.thread_key}`;
  });

  it("creates one reminder and one linked task, even with prepared replies off", async () => {
    const { fetchImpl, prompts } = model([{ deferrals: [{ n: 1, note: "Asked to pick this up in January.", precision: "month", date: when }] }]);
    const report = await prepareMail(owner, { deadline: soon(), fetchImpl });
    assert.equal(report.deferrals, 1);
    assert.equal(prompts.length, 1, "one batched call, and none for a sender who isn't in Orbit");
    assert.match(prompts[0].user, /pick this up in January/);
    assert.doesNotMatch(prompts[0].user, /Sam Stranger/);

    const expected = resolveDeferral({ precision: "month", date: when })!.toISOString();
    const reminders = await getAdminPool().query<{ id: string; due_at: Date; task_id: string; defer_note: string; kind: string; state: string }>(
      "select id, due_at, task_id, defer_note, kind, state from crm.mail_reminders where user_id = $1 and deferred_message_id is not null",
      [owner.userId],
    );
    assert.equal(reminders.rows.length, 1);
    const reminder = reminders.rows[0];
    assert.equal(reminder.kind, "follow_up");
    assert.equal(reminder.state, "waiting");
    assert.equal(reminder.due_at.toISOString(), expected);
    assert.equal(reminder.defer_note, "Asked to pick this up in January.");

    const task = await getTask(owner, reminder.task_id);
    assert.equal(task.title, "Check in with Jane Doe");
    assert.equal(task.contactName, "Jane Doe");
    assert.equal(task.companyName, "Acme");
    assert.equal(task.dueDate, dayKeyAt(new Date(expected)));
    assert.equal(task.dueHasTime, false);
    assert.equal(task.dueAt, dayStartIso(task.dueDate!));
    assert.equal(task.remindMinutes, null);
    assert.equal(task.description, "Asked to pick this up in January.");
    assert.equal(task.mailThreadKey, thread);
    assert.equal(task.mailThread?.readable, true);
    const audit = await getAdminPool().query<{ operation: string; source: string }>("select operation, source from crm.audit_events where entity_id = $1 and event_type = 'task.created'", [task.id]);
    assert.deepEqual(audit.rows, [{ operation: "defer_follow_up", source: "mail" }]);

    const detail = await getThread(owner, thread);
    assert.equal(detail.deferral?.id, reminder.id);
    assert.equal(detail.deferral?.at, expected);
    assert.equal(detail.messages.find((item) => item.id === detail.deferral?.messageId)?.from?.address, "jane@acme.test");
    assert.equal(detail.followUp, null, "the deferral isn't shown twice");

    const again = model([{ deferrals: [{ n: 1, note: "Asked to pick this up in January.", precision: "month", date: when }] }]);
    await prepareMail(owner, { deadline: soon(), fetchImpl: again.fetchImpl });
    assert.equal(again.prompts.length, 0, "each email is checked once");
    assert.equal((await getAdminPool().query("select 1 from crm.tasks where title = 'Check in with Jane Doe'")).rowCount, 1);
  });

  it("changing the date moves the reminder and the task", async () => {
    const reminder = (await getAdminPool().query<{ id: string; task_id: string }>("select id, task_id from crm.mail_reminders where user_id = $1 and deferred_message_id is not null", [owner.userId])).rows[0];
    const later = new Date(Date.now() + 40 * 86_400_000);
    later.setUTCHours(10, 30, 0, 0);
    await moveDeferral(owner, reminder.id, later.toISOString());
    const moved = (await getAdminPool().query<{ due_at: Date }>("select due_at from crm.mail_reminders where id = $1", [reminder.id])).rows[0];
    assert.equal(moved.due_at.toISOString(), later.toISOString());
    const movedTask = await getTask(owner, reminder.task_id);
    assert.equal(movedTask.dueDate, dayKeyAt(later));
    assert.equal(movedTask.dueHasTime, false);
    assert.equal((await getThread(owner, thread)).deferral?.at, later.toISOString());
    await assert.rejects(moveDeferral(owner, reminder.id, new Date(Date.now() - 60_000).toISOString()), /at least a minute from now/);

    await updateTask(owner, reminder.task_id, { dueAt: `${dayKeyAt(later)}T15:45`, remindMinutes: 30 });
    const further = new Date(later.getTime() + 7 * 86_400_000);
    await moveDeferral(owner, reminder.id, further.toISOString());
    const timed = await getTask(owner, reminder.task_id);
    assert.equal(timed.dueDate, dayKeyAt(further));
    assert.equal(timed.dueHasTime, true);
    assert.equal(clockLabel(timed.dueAt!), "15:45");
    assert.equal(timed.remindMinutes, 30);
    const sameDay = new Date(Date.parse(`${dayKeyAt(further)}T00:00:00Z`) + 19 * 3_600_000);
    await moveDeferral(owner, reminder.id, sameDay.toISOString());
    const laterToday = await getTask(owner, reminder.task_id);
    assert.equal(laterToday.dueAt, sameDay.toISOString());
    assert.equal(laterToday.dueHasTime, true);
  });

  it("asks for a gentle check-in when the day comes", async () => {
    const { fetchImpl, prompts } = model([{ body: "Hi Jane, is now a better time to pick this up? Mark" }]);
    const [sourceId, key] = thread.split("|");
    await setMailHelp(owner, { prepareReplies: true });
    await prepareNudge(owner, sourceId, key, { fetchImpl });
    await setMailHelp(owner, { prepareReplies: false });
    assert.match(prompts[0].system, /asked Mark Ridgeon to pick it up later/);
    assert.doesNotMatch(prompts[0].system, /Asked to pick this up in January/, "the note is material, not part of the instructions");
    assert.match(prompts[0].user, /Orbit's note of what they asked[^\n]*\n"""\nAsked to pick this up in January\.\n"""/);
  });

  it("Cancel removes the reminder and archives the task", async () => {
    const reminder = (await getAdminPool().query<{ id: string; task_id: string }>("select id, task_id from crm.mail_reminders where user_id = $1 and deferred_message_id is not null", [owner.userId])).rows[0];
    await cancelDeferral(owner, reminder.id);
    const state = (await getAdminPool().query<{ state: string }>("select state from crm.mail_reminders where id = $1", [reminder.id])).rows[0].state;
    assert.equal(state, "cancelled");
    assert.ok((await getTask(owner, reminder.task_id)).archivedAt);
    assert.equal((await getThread(owner, thread)).deferral, null);
    await assert.rejects(cancelDeferral(owner, reminder.id), /has gone/);
  });

  it("Cancel leaves a follow-up that now repeats alone", async () => {
    const reminder = (await getAdminPool().query<{ id: string; task_id: string }>("select id, task_id from crm.mail_reminders where user_id = $1 and deferred_message_id is not null", [owner.userId])).rows[0];
    await getAdminPool().query("update crm.tasks set archived_at = null where id = $1", [reminder.task_id]);
    await getAdminPool().query("update crm.mail_reminders set state = 'waiting' where id = $1", [reminder.id]);
    await setTaskRepeat(owner, reminder.task_id, { every: "week" });
    const before = await getTask(owner, reminder.task_id);
    const result = await cancelDeferral(owner, reminder.id);
    assert.equal(result.taskArchived, false);
    const after = await getTask(owner, reminder.task_id);
    assert.equal(after.archivedAt, null);
    assert.equal(after.occursOn, before.occursOn, "the repeating task isn't skipped either");
    await setTaskRepeat(owner, reminder.task_id, null);
  });

  it("reads the deferral from the prepared reply call when replies are on", async () => {
    await setMailHelp(owner, { prepareReplies: true });
    await syncMail(owner, {
      budgetMs: 30_000,
      fetchImpl: mailbox({ inbox: [message("m-next-year", "Not the right time for us. Try me next year.", { conversationId: "conv-next-year", subject: "Renewal" })], sent: [] }),
    });
    const { fetchImpl, prompts } = model([
      { needsReply: true, body: "Hi Jane, will do. Mark", defer: { note: "Asked to try again next year.", precision: "month", date: when } },
      { needsReply: false, body: null },
      { needsReply: false, body: null },
    ]);
    const report = await prepareMail(owner, { deadline: soon(), fetchImpl });
    assert.equal(prompts.length, 3, "one reply call for each waiting email");
    assert.match(prompts[0].user, /Try me next year/);
    assert.match(prompts[0].system, /defer is set when the latest email is a deferral/);
    assert.ok(prompts.slice(1).every((prompt) => !/defer is set/.test(prompt.system)), "emails already checked aren't asked again");
    assert.ok(prompts.every((prompt) => !/put the conversation off until later/.test(prompt.system)), "no separate deferral call");
    assert.equal(report.deferrals, 0, "found by the reply call, not the batch");
    const rows = await getAdminPool().query<{ defer_note: string }>(
      "select r.defer_note from crm.mail_reminders r join crm.mail_messages m on m.id = r.deferred_message_id where m.provider_message_id = 'm-next-year'",
    );
    assert.deepEqual(rows.rows, [{ defer_note: "Asked to try again next year." }]);
  });

  it("keeps deferral checks private", async () => {
    const other = await createUser("someone@orbit.test", "Someone Else");
    assert.ok((await queryAsUser(owner.userId, "select message_id from crm.mail_deferral_checks")).length > 0);
    assert.equal((await queryAsUser(other.userId, "select message_id from crm.mail_deferral_checks")).length, 0);
  });
});

describe("deferral bookkeeping", () => {
  let owner: UserActor;
  let sourceId: string;
  const when = monthsAhead(2);
  const admin = () => getAdminPool();
  const inbox: unknown[] = [];

  async function sync() {
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: mailbox({ inbox, sent: [] }) });
  }

  before(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    owner = await createUser("bookkeeping@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const acme = (await createCompany(owner, { name: "Acme", domain: "acme.test" })).body.company.id;
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test", companyId: acme });
    await setMailHelp(owner, { prepareReplies: false, autoRemindDays: null });
    inbox.push(message("m-book", "Thanks Mark. Can we pick this up in January? Budgets are frozen until then.\n\nJane"));
    await sync();
    sourceId = (await admin().query<{ source_id: string }>("select source_id from crm.mail_messages where provider_message_id = 'm-book'")).rows[0].source_id;
  });

  async function deferrals() {
    return (
      await admin().query<{ id: string; state: string; deferred_message_id: string | null; task_id: string | null; defer_note: string }>(
        "select id, state, deferred_message_id, task_id, defer_note from crm.mail_reminders where user_id = $1 and deferral order by created_at",
        [owner.userId],
      )
    ).rows;
  }

  it("closes a waiting send follow-up as replied, and generic follow-up paths leave the deferral alone", async () => {
    const insert = (action: string) =>
      admin().query(
        `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, action, due_at)
         values ($1, $2, $3, 'conv-m-book', 'follow_up', $4, now() + interval '2 days') returning id`,
        [owner.workspaceId, owner.userId, sourceId, action],
      );
    const send = (await insert("send")).rows[0].id;
    const remind = (await insert("remind")).rows[0].id;
    const { fetchImpl } = model([{ deferrals: [{ n: 1, note: 'Asked to "pick this up" {in} [January] <later>.', precision: "month", date: when }] }]);
    await prepareMail(owner, { deadline: soon(), fetchImpl });
    const states = await admin().query<{ id: string; state: string }>("select id, state from crm.mail_reminders where id = any($1::uuid[])", [[send, remind]]);
    assert.equal(states.rows.find((row) => row.id === send)?.state, "replied");
    assert.equal(states.rows.find((row) => row.id === remind)?.state, "done");
    const [deferral] = await deferrals();
    assert.equal(deferral.state, "waiting");
    assert.equal(deferral.defer_note, "Asked to pick this up in January later.", "quotes, braces and brackets are stripped");

    await addFollowUp(owner, { thread: `${sourceId}|conv-m-book`, dueAt: new Date(Date.now() + 86_400_000), subject: "Acme" });
    assert.equal((await deferrals())[0].state, "waiting", "setting a reminder doesn't end the deferral");
    assert.equal(await cancelFollowUp(owner, deferral.id), 0, "cancelling a reminder can't end a deferral");
    assert.equal((await deferrals())[0].state, "waiting");
  });

  it("survives its email moving, and the new copy is reattached rather than counted twice", async () => {
    const [before] = await deferrals();
    await admin().query("delete from crm.mail_messages where provider_message_id = 'm-book'");
    const orphan = (await deferrals())[0];
    assert.equal(orphan.deferred_message_id, null);
    inbox.splice(0, inbox.length, message("m-book-moved", "Thanks Mark. Can we pick this up in January? Budgets are frozen until then.\n\nJane", { conversationId: "conv-m-book" }));
    await sync();
    const moved = (await admin().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'm-book-moved'")).rows[0].id;
    const detail = await getThread(owner, `${sourceId}|conv-m-book`);
    assert.equal(detail.deferral?.id, before.id, "the thread still shows the deferral");
    assert.equal(detail.deferral?.messageId, moved);

    const { fetchImpl } = model([{ deferrals: [{ n: 1, note: "Asked to pick this up in January.", precision: "month", date: when }] }]);
    await prepareMail(owner, { deadline: soon(), fetchImpl });
    const after = await deferrals();
    assert.equal(after.length, 1);
    assert.equal(after[0].deferred_message_id, moved);
    assert.equal((await admin().query("select 1 from crm.tasks where title = 'Check in with Jane Doe' and workspace_id = $1", [owner.workspaceId])).rowCount, 1);
  });

  it("only checks the newest email in a conversation", async () => {
    inbox.push(
      message("m-old", "Can we pick this up in January?", { conversationId: "conv-pair", receivedDateTime: ago(5), sentDateTime: ago(5) }),
      message("m-new", "Thanks, that all works.", { conversationId: "conv-pair", receivedDateTime: ago(2), sentDateTime: ago(2) }),
    );
    await sync();
    const { fetchImpl, prompts } = model([{ deferrals: [] }]);
    await prepareMail(owner, { deadline: soon(), fetchImpl });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].user, /that all works/, "every email from someone in the CRM goes to the model, whatever its wording");
    assert.doesNotMatch(prompts[0].user, /pick this up in January/, "an email they followed up an hour later isn't asked about");
    const checked = await admin().query("select 1 from crm.mail_deferral_checks d join crm.mail_messages m on m.id = d.message_id where m.provider_message_id = 'm-old'");
    assert.equal(checked.rowCount, 0);
  });
});

describe("deferrals after review", () => {
  let owner: UserActor;
  let sourceId: string;
  const admin = () => getAdminPool();
  const inbox: unknown[] = [];
  const sent: unknown[] = [];
  const when = monthsAhead(2);
  const laterWhen = monthsAhead(3);

  async function sync() {
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: mailbox({ inbox, sent }) });
  }

  async function messageId(provider: string) {
    return (await admin().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = $1", [provider])).rows[0].id;
  }

  async function threadDeferrals(conversation: string) {
    return (
      await admin().query<{ id: string; state: string; due_at: Date; task_id: string | null; defer_note: string; created_at: Date }>(
        "select id, state, due_at, task_id, defer_note, created_at from crm.mail_reminders where user_id = $1 and thread_key = $2 and deferral order by created_at",
        [owner.userId, conversation],
      )
    ).rows;
  }

  function candidate(id: string, conversation: string) {
    return { id, sourceId, threadKey: conversation, subject: "Proposal", fromEmail: "ross@hvac.test", fromName: "Ross Burke" };
  }

  before(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    owner = await createUser("review@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const hvac = (await createCompany(owner, { name: "Ambient HVAC", domain: "hvac.test" })).body.company.id;
    await createContact(owner, { firstName: "Ross", lastName: "Burke", email: "ross@hvac.test", companyId: hvac });
    await setMailHelp(owner, { prepareReplies: false, autoRemindDays: null });
    const ross = { from: { emailAddress: { name: "Ross Burke", address: "ross@hvac.test" } } };
    inbox.push(
      message("r-defer", "Thanks Mark. We will pick this up in a couple of months.", { ...ross, conversationId: "conv-redefer", receivedDateTime: ago(30), sentDateTime: ago(30) }),
      message("r-own", "Thanks Mark, let's pick this up in January.", { ...ross, conversationId: "conv-own", receivedDateTime: ago(3), sentDateTime: ago(3) }),
    );
    sent.push(
      message("r-own-reply", "No problem, speak then.", {
        conversationId: "conv-own",
        from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
        toRecipients: [{ emailAddress: { name: "Ross", address: "ross@hvac.test" } }],
        receivedDateTime: ago(2),
        sentDateTime: ago(2),
      }),
    );
    await sync();
    sourceId = (await admin().query<{ source_id: string }>("select source_id from crm.mail_messages where provider_message_id = 'r-defer'")).rows[0].source_id;
  });

  it("still finds a deferral after a quick reply of your own", async () => {
    const { fetchImpl, prompts } = model([{ deferrals: [{ n: 1, note: "Asked to pick this up in January.", precision: "month", date: when }] }]);
    await prepareMail(owner, { deadline: soon(), fetchImpl });
    assert.match(prompts[0]?.user ?? "", /pick this up in January/);
    assert.equal((await threadDeferrals("conv-own")).length, 1);
  });

  it("moves the date, note and task when they put it off again", async () => {
    await applyDeferral(owner, candidate(await messageId("r-defer"), "conv-redefer"), { note: "Asked to pick this up in a couple of months.", precision: "month", date: when });
    const [first] = await threadDeferrals("conv-redefer");
    await admin().query("update crm.mail_reminders set created_at = now() - interval '1 day' where id = $1", [first.id]);
    inbox.push(
      message("r-again", "Sorry Mark, make that a month later.", {
        from: { emailAddress: { name: "Ross Burke", address: "ross@hvac.test" } },
        conversationId: "conv-redefer",
        receivedDateTime: ago(1),
        sentDateTime: ago(1),
      }),
    );
    await sync();
    await applyDeferral(owner, candidate(await messageId("r-again"), "conv-redefer"), { note: "Asked to make it a month later.", precision: "month", date: laterWhen });
    const after = await threadDeferrals("conv-redefer");
    assert.equal(after.length, 1, "one deferral per conversation");
    assert.equal(after[0].id, first.id);
    assert.equal(after[0].state, "waiting");
    assert.equal(after[0].defer_note, "Asked to make it a month later.");
    const expected = resolveDeferral({ precision: "month", date: laterWhen })!;
    assert.equal(after[0].due_at.toISOString(), expected.toISOString());
    const task = await getTask(owner, after[0].task_id!);
    assert.equal(task.dueDate, dayKeyAt(expected));
    assert.equal(task.description, "Asked to make it a month later.");
    assert.equal((await admin().query("select 1 from crm.tasks where title = 'Check in with Ross Burke' and archived_at is null")).rowCount, 2, "no extra task");

    const listed = (await waitingMail(owner, [owner], new Date(Date.now() + 7 * 86_400_000))).replies.map((item) => item.key);
    assert.ok(!listed.includes(`${sourceId}|conv-redefer`), "the second deferral is held back from Replies too");
  });

  it("keeps the check-in and its task in step both ways", async () => {
    const [deferral] = await threadDeferrals("conv-redefer");
    const target = "2027-03-10";
    await updateTask(owner, deferral.task_id!, { dueDate: target });
    const moved = (await threadDeferrals("conv-redefer"))[0];
    assert.equal(dayKeyAt(moved.due_at), target, "re-dating the task moves the check-in");
    assert.equal(moved.due_at.toISOString(), "2027-03-10T09:00:00.000Z");
    await updateTask(owner, deferral.task_id!, { dueAt: `${target}T15:00` });
    assert.equal((await threadDeferrals("conv-redefer"))[0].due_at.toISOString(), "2027-03-10T09:00:00.000Z", "a time on the same day leaves it at 09:00");

    await updateTask(owner, deferral.task_id!, { completed: true });
    assert.equal((await threadDeferrals("conv-redefer"))[0].state, "done", "completing the task ends the check-in");
    await admin().query("update crm.mail_reminders set state = 'waiting' where id = $1", [deferral.id]);
    await admin().query("update crm.tasks set completed_at = null where id = $1", [deferral.task_id]);
    await archiveTask(owner, deferral.task_id!);
    assert.equal((await threadDeferrals("conv-redefer"))[0].state, "cancelled", "deleting the task cancels the check-in, so the email can come back");

    const [own] = await threadDeferrals("conv-own");
    await admin().query("update crm.mail_reminders set state = 'due', surfaced_at = now() where id = $1", [own.id]);
    await finishReminder(owner, own.id);
    assert.ok((await getTask(owner, own.task_id!)).completedAt, "Done in Capture completes the task");
  });

  it("completes the task once you send the check-in", async () => {
    const thread = "conv-own";
    const [own] = await threadDeferrals(thread);
    await admin().query("update crm.mail_reminders set state = 'due', surfaced_at = now() - interval '1 hour' where id = $1", [own.id]);
    await admin().query("update crm.tasks set completed_at = null where id = $1", [own.task_id]);
    sent.push(
      message("r-check-in", "Hi Ross, is now a good time?", {
        conversationId: thread,
        from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
        toRecipients: [{ emailAddress: { name: "Ross", address: "ross@hvac.test" } }],
        receivedDateTime: new Date().toISOString(),
        sentDateTime: new Date().toISOString(),
      }),
    );
    await sync();
    assert.equal(await settleDeferrals(owner), 1);
    assert.equal((await threadDeferrals(thread))[0].state, "done");
    assert.ok((await getTask(owner, own.task_id!)).completedAt);

    await admin().query("update crm.mail_reminders set state = 'due', surfaced_at = now() where id = $1", [own.id]);
    await admin().query("update crm.tasks set completed_at = null where id = $1", [own.task_id]);
    inbox.push(
      message("r-wrote-first", "Morning Mark, ready when you are.", {
        from: { emailAddress: { name: "Ross Burke", address: "ross@hvac.test" } },
        conversationId: thread,
        receivedDateTime: new Date(Date.now() + 60_000).toISOString(),
        sentDateTime: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    await sync();
    assert.equal(await settleDeferrals(owner), 1, "their email after the check-in surfaced ends it too");
    assert.ok((await getTask(owner, own.task_id!)).completedAt);
  });

  it("retries an answer it can't place instead of forgetting the email", async () => {
    inbox.push(
      message("r-odd", "Let's pick this up after half term.", {
        from: { emailAddress: { name: "Ross Burke", address: "ross@hvac.test" } },
        conversationId: "conv-odd",
      }),
    );
    await sync();
    const odd = { note: "Asked to pick this up after half term.", precision: "soonish", date: "after half term" };
    const { fetchImpl } = model([{ deferrals: [1, 2, 3, 4].map((n) => ({ n, ...odd })) }]);
    await prepareMail(owner, { deadline: soon(), fetchImpl });
    const check = (await admin().query<{ state: string }>("select state from crm.mail_deferral_checks where message_id = $1", [await messageId("r-odd")])).rows[0];
    assert.equal(check.state, "failed");
  });

  it("never brings back a cancelled deferral when its email moves, and never doubles one from a second mailbox", async () => {
    inbox.push(
      message("r-cancel", "Let's pick this up in January.", { from: { emailAddress: { name: "Ross Burke", address: "ross@hvac.test" } }, conversationId: "conv-cancel", receivedDateTime: ago(4), sentDateTime: ago(4) }),
    );
    await sync();
    await applyDeferral(owner, candidate(await messageId("r-cancel"), "conv-cancel"), { note: "Asked to pick this up in January.", precision: "month", date: when });
    const [made] = await threadDeferrals("conv-cancel");
    await cancelDeferral(owner, made.id);
    await admin().query("delete from crm.mail_messages where provider_message_id = 'r-cancel'");
    inbox.splice(inbox.findIndex((item) => (item as { id: string }).id === "r-cancel"), 1);
    inbox.push(message("r-cancel-moved", "Let's pick this up in January.", { from: { emailAddress: { name: "Ross Burke", address: "ross@hvac.test" } }, conversationId: "conv-cancel", receivedDateTime: ago(4), sentDateTime: ago(4) }));
    await sync();
    await applyDeferral(owner, candidate(await messageId("r-cancel-moved"), "conv-cancel"), { note: "Asked to pick this up in January.", precision: "month", date: when });
    assert.deepEqual((await threadDeferrals("conv-cancel")).map((row) => row.state), ["cancelled"]);

    const original = (await admin().query<{ workspace_id: string }>("select workspace_id from crm.mail_messages where provider_message_id = 'r-defer'")).rows[0];
    const account = (
      await admin().query<{ id: string }>(
        `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token)
         values ($1, $2, 'microsoft', 'mark@other.test', 'connected', 'cipher') returning id`,
        [original.workspace_id, owner.userId],
      )
    ).rows[0].id;
    const other = (
      await admin().query<{ id: string }>(
        "insert into crm.mail_sources (workspace_id, user_id, account_id, email) values ($1, $2, $3, 'mark@other.test') returning id",
        [original.workspace_id, owner.userId, account],
      )
    ).rows[0].id;
    const folder = (
      await admin().query<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'other-inbox', 'Inbox', 'inbox') returning id",
        [original.workspace_id, owner.userId, other],
      )
    ).rows[0].id;
    const copy = (
      await admin().query<{ id: string }>(
        `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, body_text, from_email, from_name, to_recipients, received_at, sent_at)
         select workspace_id, user_id, $1, $2, 'r-defer-copy', internet_message_id, 'conv-copy', subject, body_text, from_email, from_name, to_recipients, received_at, sent_at
         from crm.mail_messages where provider_message_id = 'r-defer' returning id`,
        [other, folder],
      )
    ).rows[0].id;
    const result = await applyDeferral(owner, { ...candidate(copy, "conv-copy"), sourceId: other }, { note: "Asked to pick this up later.", precision: "month", date: when });
    assert.equal(result, null);
    assert.equal((await threadDeferrals("conv-copy")).length, 0);
    const held = await admin().query("select 1 from crm.capture_dismissals where user_id = $1 and source_id = $2 and thread_key = 'conv-copy'", [owner.userId, other]);
    assert.equal(held.rowCount, 1, "the second copy is held back from Replies too");
  });

  it("puts the check-in in the other workspace when only that one knows the sender", async () => {
    const created = await createWorkspace(owner, { name: "Ridgeon Consulting" });
    const consulting: UserActor = { ...owner, workspaceId: created.id, workspaceName: "Ridgeon Consulting", role: "owner", scopes: scopesForRole("owner") };
    await createContact(consulting, { firstName: "Priya", lastName: "Shah", email: "priya@northwind.test" });
    inbox.push(
      message("r-other", "Let's pick this up in January.", {
        from: { emailAddress: { name: "Priya Shah", address: "priya@northwind.test" } },
        conversationId: "conv-other",
      }),
    );
    await sync();
    const result = await applyDeferral(
      owner,
      { ...candidate(await messageId("r-other"), "conv-other"), fromEmail: "priya@northwind.test", fromName: "Priya Shah" },
      { note: "Asked to pick this up in January.", precision: "month", date: when },
    );
    assert.ok(result?.taskId);
    const task = (await admin().query<{ workspace_id: string; title: string }>("select workspace_id, title from crm.tasks where id = $1", [result!.taskId])).rows[0];
    assert.equal(task.workspace_id, created.id);
    assert.equal(task.title, "Check in with Priya Shah");
  });
});
