import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import { dayKey } from "@/lib/crm/task-due";
import { getTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { deferralHint, deferralOptions, resolveDeferral } from "@/lib/mail/deferral-dates";
import { cancelDeferral, moveDeferral } from "@/lib/mail/deferrals";
import { prepareMail, prepareNudge, setMailHelp } from "@/lib/mail/prepare";
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
    assert.equal(resolveDeferral({ precision: "day", date: "2026-11-05" }, now, "Europe/London"), null);
    assert.equal(resolveDeferral({ precision: "year", date: "2028-01-01" }, now, "Europe/London"), null);
    assert.equal(resolveDeferral({ precision: "day", date: "2027-02-30" }, now, "Europe/London"), null);
  });

  it("only asks the model about emails that name a later time", () => {
    assert.ok(deferralHint("Can we pick this up in January?"));
    assert.ok(deferralHint("Let's circle back after Q1."));
    assert.ok(deferralHint("Try me next year, budgets are frozen."));
    assert.ok(!deferralHint("Could you send over the renewal terms this week?"));
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
    assert.equal(task.dueAt, expected);
    assert.equal(task.remindMinutes, 0);
    assert.equal(task.description, `Asked to pick this up in January.\n\n[Acme pilot: proposal and next steps](/mail?thread=${encodeURIComponent(thread)})`);
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
    assert.equal((await getTask(owner, reminder.task_id)).dueAt, later.toISOString());
    assert.equal((await getThread(owner, thread)).deferral?.at, later.toISOString());
    await assert.rejects(moveDeferral(owner, reminder.id, new Date(Date.now() - 60_000).toISOString()), /at least a minute from now/);
  });

  it("asks for a gentle check-in when the day comes", async () => {
    const { fetchImpl, prompts } = model([{ body: "Hi Jane, is now a better time to pick this up? Mark" }]);
    const [sourceId, key] = thread.split("|");
    await setMailHelp(owner, { prepareReplies: true });
    await prepareNudge(owner, sourceId, key, { fetchImpl });
    await setMailHelp(owner, { prepareReplies: false });
    assert.match(prompts[0].system, /asked Mark Ridgeon to pick it up later \("Asked to pick this up in January\."\)/);
  });

  it("Don't follow up removes the reminder and archives the task", async () => {
    const reminder = (await getAdminPool().query<{ id: string; task_id: string }>("select id, task_id from crm.mail_reminders where user_id = $1 and deferred_message_id is not null", [owner.userId])).rows[0];
    await cancelDeferral(owner, reminder.id);
    const state = (await getAdminPool().query<{ state: string }>("select state from crm.mail_reminders where id = $1", [reminder.id])).rows[0].state;
    assert.equal(state, "done");
    assert.ok((await getTask(owner, reminder.task_id)).archivedAt);
    assert.equal((await getThread(owner, thread)).deferral, null);
    await assert.rejects(cancelDeferral(owner, reminder.id), /has gone/);
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
