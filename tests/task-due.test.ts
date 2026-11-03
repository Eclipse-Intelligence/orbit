import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bankHolidays, dueDayFrom, nextWorkingDay, planTaskDue } from "@/lib/crm/task-due";

const LONDON = "Europe/London";

function at(iso: string) {
  return new Date(iso);
}

describe("automatic task due dates", () => {
  it("knows the bank holidays in England and Wales", () => {
    assert.deepEqual([...bankHolidays(2027)].sort(), ["2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28"]);
    assert.ok(bankHolidays(2026).has("2026-12-28"));
    assert.ok(bankHolidays(2022).has("2022-01-03"));
  });

  it("moves a 60 day revisit off Saturday 2 January to the next working morning", () => {
    const plan = planTaskDue({ days: 60 }, at("2026-11-03T13:05:00Z"), LONDON);
    assert.equal(plan?.dueAt, "2027-01-04T09:00:00.000Z");
    assert.equal(plan?.note, "Due Mon 4 Jan because Sat 2 Jan is a Saturday.");
  });

  it("skips Christmas, Sundays and bank holidays", () => {
    assert.equal(nextWorkingDay("2026-12-24"), "2027-01-04");
    assert.equal(nextWorkingDay("2027-03-26"), "2027-03-30");
    assert.equal(nextWorkingDay("2026-11-08"), "2026-11-09");
    const plan = planTaskDue({ on: "2027-05-31" }, at("2027-05-20T10:00:00Z"), LONDON);
    assert.equal(plan?.dueAt, "2027-06-01T08:00:00.000Z");
    assert.match(plan?.note ?? "", /Mon 31 May is a bank holiday/);
  });

  it("skips days when the calendar is full and picks the first free half hour", () => {
    const busy = [
      { start: Date.parse("2026-11-09T08:00:00Z"), end: Date.parse("2026-11-09T17:30:00Z") },
      { start: Date.parse("2026-11-10T09:00:00Z"), end: Date.parse("2026-11-10T11:10:00Z") },
    ];
    const plan = planTaskDue({ days: 6, busy }, at("2026-11-03T13:05:00Z"), LONDON);
    assert.equal(plan?.dueAt, "2026-11-10T11:15:00.000Z");
    assert.equal(plan?.note, "Due Tue 10 Nov because your calendar is full that day.");
    const quiet = planTaskDue({ days: 6, busy: [] }, at("2026-11-03T13:05:00Z"), LONDON);
    assert.equal(quiet?.dueAt, "2026-11-09T09:00:00.000Z");
    assert.equal(quiet?.note, null);
  });

  it("keeps a task for today on a working day, and moves a weekend or evening one to the next morning", () => {
    assert.equal(planTaskDue({ days: 0 }, at("2026-11-04T10:00:00Z"), LONDON)?.dueAt, "2026-11-04T10:00:00.000Z");
    assert.equal(planTaskDue({ days: 0 }, at("2026-11-07T10:00:00Z"), LONDON)?.dueAt, "2026-11-09T09:00:00.000Z");
    assert.equal(planTaskDue({ days: 0 }, at("2026-11-04T19:00:00Z"), LONDON)?.dueAt, "2026-11-05T09:00:00.000Z");
  });

  it("uses a date worked out by an AI step, ignoring past or unreadable ones", () => {
    assert.equal(dueDayFrom("2027-01-11"), "2027-01-11");
    assert.equal(dueDayFrom("Follow up on 2027-01-11, gently"), "2027-01-11");
    assert.equal(dueDayFrom("2027-02-30"), null);
    assert.equal(dueDayFrom(""), null);
    assert.equal(planTaskDue({ on: "2027-01-11", days: 60 }, at("2026-11-03T13:05:00Z"), LONDON)?.dueAt, "2027-01-11T09:00:00.000Z");
    assert.equal(planTaskDue({ on: "2026-10-01", days: 2 }, at("2026-11-03T13:05:00Z"), LONDON)?.dueAt, "2026-11-05T09:00:00.000Z");
    assert.equal(planTaskDue({ days: null }, at("2026-11-03T13:05:00Z"), LONDON), null);
  });
});
