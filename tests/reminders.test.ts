import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getPool } from "@/lib/db/pool";
import { createCompany } from "@/lib/crm/companies";
import { reminderFireAt, reminderHeadline, reminderLabel } from "@/lib/crm/reminder-options";
import { completeTask, createTask, getTask, listDueReminders, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { parseInput, taskMutationSchema } from "@/lib/crm/validation";
import {
  formatDateTimeLabel,
  monthGrid,
  nextQuarterHour,
  quickDates,
  splitDateTime,
} from "@/lib/date-input";
import { createUser, resetDatabase } from "./helpers";

const MINUTE = 60 * 1000;

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("date picker helpers", () => {
  it("lays out months Monday first and only as many weeks as needed", () => {
    const october = monthGrid(2026, 9);
    assert.equal(october[0][0].value, "2026-09-28");
    assert.equal(october[0][0].inMonth, false);
    assert.equal(october[0][3].value, "2026-10-01");
    assert.equal(october.length, 5);
    assert.equal(october.at(-1)?.at(-1)?.value, "2026-11-01");
    assert.equal(monthGrid(2026, 7).length, 6);
  });

  it("reads and labels date-time values", () => {
    assert.deepEqual(splitDateTime("2026-10-16T09:30"), { date: "2026-10-16", time: "09:30" });
    assert.equal(splitDateTime("2026-02-30T09:30"), null);
    assert.equal(splitDateTime("2026-10-16T24:00"), null);
    assert.equal(splitDateTime(""), null);
    assert.equal(formatDateTimeLabel("2026-10-16T09:30", new Date(2026, 9, 15)), "Fri 16 Oct, 09:30");
    assert.equal(formatDateTimeLabel("2027-01-04T17:00", new Date(2026, 9, 15)), "Mon 4 Jan 2027, 17:00");
  });

  it("offers today, tomorrow and next Monday, and rounds times up", () => {
    const thursday = new Date(2026, 9, 15, 16, 7);
    assert.deepEqual(
      quickDates(thursday).map((quick) => quick.value),
      ["2026-10-15", "2026-10-16", "2026-10-19"],
    );
    assert.equal(quickDates(new Date(2026, 9, 19, 10))[2].value, "2026-10-26");
    assert.equal(nextQuarterHour(thursday), "16:15");
    assert.equal(nextQuarterHour(new Date(2026, 9, 15, 16, 15)), "16:30");
    assert.equal(nextQuarterHour(new Date(2026, 9, 15, 23, 50)), null);
  });
});

describe("task reminders", () => {
  let owner: UserActor;
  let companyId: string;

  before(async () => {
    owner = await createUser("reminders@orbit.test", "Mark Ridgeon");
    companyId = (await createCompany(owner, { name: "Reminder Co", domain: "reminder.test" })).body.company.id;
  });

  it("labels and times reminders", () => {
    assert.equal(reminderLabel(null), null);
    assert.equal(reminderLabel(1440), "24 hours before");
    assert.equal(reminderFireAt("2026-10-16T09:00:00.000Z", 10), Date.parse("2026-10-16T08:50:00.000Z"));
    const now = Date.parse("2026-10-16T08:50:00.000Z");
    assert.equal(reminderHeadline("2026-10-16T09:00:00.000Z", now), "Task due in 10 minutes");
    assert.equal(reminderHeadline("2026-10-17T09:00:00.000Z", now), "Task due in 24 hours");
    assert.equal(reminderHeadline("2026-10-16T08:50:00.000Z", now), "Task due now");
  });

  it("saves a reminder with the task and rejects ones not on the list", async () => {
    const due = new Date(Date.now() + 2 * 60 * MINUTE).toISOString();
    const created = (await createTask(owner, { title: "Call Ada", companyId, dueAt: due, remindMinutes: 60 })).body.task;
    assert.equal(created.remindMinutes, 60);
    await assert.rejects(
      createTask(owner, { title: "Odd reminder", companyId, dueAt: due, remindMinutes: 7 }),
      /Pick a reminder from the list/,
    );
    const cleared = (await updateTask(owner, created.id, { remindMinutes: null })).body.task;
    assert.equal(cleared.remindMinutes, null);
    const kept = (await updateTask(owner, created.id, { title: "Call Ada back" })).body.task;
    assert.equal(kept.remindMinutes, null);
    assert.equal((await getTask(owner, created.id)).title, "Call Ada back");
  });

  it("lists reminders that are due soon, and skips done, past and later ones", async () => {
    const now = new Date();
    const at = (minutes: number) => new Date(now.getTime() + minutes * MINUTE).toISOString();
    const soon = (await createTask(owner, { title: "Soon", companyId, dueAt: at(15), remindMinutes: 10 })).body.task;
    const missed = (await createTask(owner, { title: "Missed while closed", companyId, dueAt: at(120), remindMinutes: 1440 })).body.task;
    const later = (await createTask(owner, { title: "Later", companyId, dueAt: at(180), remindMinutes: 60 })).body.task;
    const past = (await createTask(owner, { title: "Past", companyId, dueAt: at(-5), remindMinutes: 10 })).body.task;
    const done = (await createTask(owner, { title: "Done", companyId, dueAt: at(12), remindMinutes: 10 })).body.task;
    const silent = (await createTask(owner, { title: "Silent", companyId, dueAt: at(8) })).body.task;
    await completeTask(owner, done.id);

    const due = await listDueReminders(owner, now);
    const ids = due.map((reminder) => reminder.id);
    assert.deepEqual(ids, [soon.id, missed.id]);
    assert.ok(!ids.includes(later.id));
    assert.ok(!ids.includes(past.id));
    assert.ok(!ids.includes(silent.id));
    assert.equal(due[0].remindMinutes, 10);
    assert.equal(due[0].companyName, "Reminder Co");
  });

  it("accepts reminders through the API schema", () => {
    const parsed = parseInput(taskMutationSchema, { title: "From the API", dueAt: "2026-11-03T14:30", remindMinutes: 30 });
    assert.equal(parsed.remindMinutes, 30);
    assert.throws(() => parseInput(taskMutationSchema, { title: "Bad", remindMinutes: "ten" }));
  });
});
