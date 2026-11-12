import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { snoozeTask } from "@/lib/crm/action-needed";
import { dueLabel } from "@/lib/crm/capture-format";
import { onWorkingDay, taskRemindChoices, taskSnoozeChoices } from "@/lib/crm/task-snooze";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { dayKeyAt } from "@/lib/crm/working-days";
import { getPool } from "@/lib/db/pool";
import {
  atKeepingKind,
  dayStartIso,
  durationLabel,
  durationWords,
  isTaskDuration,
  isPastTime,
  isTaskOverdue,
  nextFreeStart,
  onDayKeepingKind,
  reminderTimeFor,
  scheduleChoices,
  taskDueDay,
} from "@/lib/crm/task-time";
import { taskDueLabel } from "@/lib/crm/task-views";
import { createUser, resetDatabase } from "./helpers";

const LONDON = "Europe/London";

describe("task durations", () => {
  it("labels and checks durations", () => {
    assert.equal(durationLabel(5), "5m");
    assert.equal(durationLabel(60), "1h");
    assert.equal(durationLabel(90), "1h 30m");
    assert.equal(durationWords(15), "15 minutes");
    assert.equal(durationWords(60), "1 hour");
    assert.equal(durationWords(90), "1 hour 30 minutes");
    assert.ok(isTaskDuration(5) && isTaskDuration(480));
    assert.ok(!isTaskDuration(4) && !isTaskDuration(481) && !isTaskDuration(12.5));
  });
});

describe("date-only and timed tasks", () => {
  it("keeps a date-only task due today until the end of the London day, across summer time", () => {
    const summer = { dueAt: dayStartIso("2026-07-01", LONDON), dueHasTime: false };
    assert.equal(summer.dueAt, "2026-06-30T23:00:00.000Z");
    assert.equal(taskDueDay(summer.dueAt, LONDON), "2026-07-01");
    assert.equal(isTaskOverdue(summer, Date.parse("2026-07-01T22:59:00Z"), LONDON), false);
    assert.equal(isTaskOverdue(summer, Date.parse("2026-07-01T23:00:00Z"), LONDON), true);
    const winter = { dueAt: dayStartIso("2026-11-12", LONDON), dueHasTime: false };
    assert.equal(isTaskOverdue(winter, Date.parse("2026-11-12T23:59:00Z"), LONDON), false);
    assert.equal(isTaskOverdue(winter, Date.parse("2026-11-13T00:00:00Z"), LONDON), true);
    const timed = { dueAt: "2026-11-12T14:30:00.000Z", dueHasTime: true };
    assert.equal(isTaskOverdue(timed, Date.parse("2026-11-12T14:29:00Z"), LONDON), false);
    assert.equal(isTaskOverdue(timed, Date.parse("2026-11-12T14:31:00Z"), LONDON), true);
    assert.equal(isTaskOverdue({ ...timed, completedAt: "2026-11-12T15:00:00Z" }, Date.parse("2026-11-13T00:00:00Z"), LONDON), false);
  });

  it("shows a time only for timed tasks", () => {
    const now = Date.parse("2026-11-12T10:00:00Z");
    assert.equal(taskDueLabel({ dueAt: "2026-11-12T14:30:00Z", dueHasTime: true }, now, LONDON), "Today 14:30");
    assert.equal(taskDueLabel({ dueAt: dayStartIso("2026-11-12", LONDON), dueHasTime: false }, now, LONDON), "Today");
    assert.equal(taskDueLabel({ dueAt: "2026-11-13T11:15:00Z", dueHasTime: true }, now, LONDON), "Fri 13 Nov, 11:15");
    assert.equal(taskDueLabel({ dueAt: dayStartIso("2026-11-13", LONDON), dueHasTime: false }, now, LONDON), "Fri 13 Nov");
    assert.equal(taskDueLabel({ dueAt: "2026-11-10T14:00:00Z", dueHasTime: true }, now, LONDON), "Tue 10 Nov, 14:00");
    assert.equal(taskDueLabel({ dueAt: null, dueHasTime: false }, now, LONDON), "No date");
    assert.equal(dueLabel(dayStartIso("2026-11-12", LONDON), now, LONDON, false), "Today");
    assert.equal(dueLabel("2026-11-12T00:00:00Z", now, LONDON, true), "Today 00:00");
  });

  it("moves a task to another day keeping its kind", () => {
    assert.deepEqual(onDayKeepingKind({ dueAt: dayStartIso("2026-11-12", LONDON), dueHasTime: false }, "2026-11-16", LONDON), { dueDate: "2026-11-16" });
    assert.deepEqual(onDayKeepingKind({ dueAt: "2026-07-01T13:30:00Z", dueHasTime: true }, "2026-11-16", LONDON), { dueAt: "2026-11-16T14:30:00.000Z" });
    assert.deepEqual(atKeepingKind({ dueAt: null, dueHasTime: false }, "2026-07-01T23:30:00Z", LONDON), { dueDate: "2026-07-02" });
    assert.deepEqual(atKeepingKind({ dueAt: "2026-07-01T09:00:00Z", dueHasTime: true }, "2026-07-02T09:00:00.000Z", LONDON), { dueAt: "2026-07-02T09:00:00.000Z" });
  });

  it("offers Remind me choices that keep the task's kind", () => {
    const now = new Date("2026-11-12T10:00:00Z");
    const dateOnly = taskRemindChoices({ dueAt: dayStartIso("2026-11-12", LONDON), dueHasTime: false }, now, LONDON);
    assert.deepEqual(
      dateOnly.map((choice) => [choice.id, choice.detail]),
      [
        ["tomorrow", "Fri"],
        ["next-week", "Mon"],
      ],
      "no Later today and no time for a date-only task",
    );
    const timed = taskSnoozeChoices({ dueAt: "2026-11-12T15:00:00Z", dueHasTime: true }, now, LONDON);
    assert.equal(timed[0].at, "2026-11-13T15:00:00.000Z");
    assert.match(timed[0].detail, /15:00/);
  });
});

describe("Schedule", () => {
  it("finds the next free slot today at the task's duration", () => {
    const now = Date.parse("2026-11-12T11:20:00Z");
    assert.equal(new Date(nextFreeStart(now, 15, [], LONDON)!).toISOString(), "2026-11-12T11:30:00.000Z");
    const busy = [{ start: Date.parse("2026-11-12T11:30:00Z"), end: Date.parse("2026-11-12T12:10:00Z") }];
    assert.equal(new Date(nextFreeStart(now, 15, busy, LONDON)!).toISOString(), "2026-11-12T12:15:00.000Z");
    assert.equal(nextFreeStart(Date.parse("2026-11-12T17:20:00Z"), 15, [], LONDON), null);
    assert.equal(new Date(nextFreeStart(Date.parse("2026-11-12T06:40:00Z"), 15, [], LONDON)!).toISOString(), "2026-11-12T09:00:00.000Z", "never before 09:00");
    assert.equal(nextFreeStart(Date.parse("2026-11-14T11:00:00Z"), 15, [], LONDON), null, "not on a Saturday");
    assert.equal(nextFreeStart(Date.parse("2026-12-25T11:00:00Z"), 15, [], LONDON), null, "not on a bank holiday");
    assert.equal(nextFreeStart(Date.parse("2026-11-12T17:00:00Z"), 45, [], LONDON), null, "must finish by 17:30");
  });

  it("suggests a reminder time that isn't in the past", () => {
    const now = Date.parse("2026-11-12T11:20:00Z");
    assert.equal(reminderTimeFor("2026-11-12", 0, now, LONDON), "11:30");
    assert.equal(reminderTimeFor("2026-11-12", 15, now, LONDON), "11:45");
    assert.equal(reminderTimeFor("2026-11-12", 0, Date.parse("2026-11-12T11:30:00Z"), LONDON), "11:45");
    assert.equal(reminderTimeFor("2026-11-13", 60, now, LONDON), "09:00");
    assert.equal(reminderTimeFor("2026-11-11", 0, now, LONDON), null);
    assert.equal(reminderTimeFor("2026-11-12", 0, Date.parse("2026-11-12T23:50:00Z"), LONDON), null);
    assert.equal(reminderTimeFor("2026-07-01", 0, Date.parse("2026-07-01T08:05:00Z"), LONDON), "09:15", "London summer time");
    assert.equal(isPastTime("2026-11-12", "11:00", now, LONDON), true);
    assert.equal(isPastTime("2026-11-12", "14:00", now, LONDON), false);
  });

  it("lists next free today, tomorrow morning and Monday morning", () => {
    const thursday = scheduleChoices({ durationMinutes: 15, now: Date.parse("2026-11-12T11:20:00Z") }, LONDON);
    assert.deepEqual(
      thursday.map((choice) => [choice.label, choice.detail, choice.at]),
      [
        ["Next free 15 minutes", "11:30", "2026-11-12T11:30:00.000Z"],
        ["Tomorrow morning", "Fri 09:00", "2026-11-13T09:00:00.000Z"],
        ["Monday morning", "Mon 09:00", "2026-11-16T09:00:00.000Z"],
      ],
    );
    const friday = scheduleChoices({ durationMinutes: 30, now: Date.parse("2026-11-13T18:00:00Z") }, LONDON);
    assert.deepEqual(
      friday.map((choice) => [choice.id, choice.label]),
      [["tomorrow", "Monday morning"]],
      "after hours on a Friday the next working morning is Monday",
    );
  });
});

describe("Remind me on a task keeps its kind", () => {
  let mark: UserActor;

  before(async () => {
    await resetDatabase();
    mark = await createUser("timing-snooze@orbit.test", "Mark Ridgeon");
  });

  after(async () => {
    await getPool().end();
  });

  it("moves a date-only task to another day and a timed task keeping its time of day", async () => {
    const now = new Date();
    const dateOnly = (await createTask(mark, { title: "Call Jane", dueDate: dayKeyAt(now) })).body.task;
    const timed = (await createTask(mark, { title: "Call Tom", dueAt: new Date(now.getTime() + 3_600_000).toISOString() })).body.task;
    const forDay = taskSnoozeChoices(dateOnly, now).find((choice) => choice.id === "tomorrow")!;
    const moved = (await snoozeTask(mark, dateOnly.id, forDay.at)).body.task;
    assert.equal(moved.dueHasTime, false);
    assert.equal(moved.dueDate, dayKeyAt(onWorkingDay(new Date(forDay.at))));
    assert.equal(moved.dueAt, dayStartIso(moved.dueDate!));
    const forTime = taskSnoozeChoices(timed, now).find((choice) => choice.id === "tomorrow")!;
    const kept = (await snoozeTask(mark, timed.id, forTime.at)).body.task;
    assert.equal(kept.dueHasTime, true);
    assert.equal(kept.scheduledBy, "person");
    assert.equal(kept.dueAt, onWorkingDay(new Date(forTime.at)).toISOString());
  });
});
