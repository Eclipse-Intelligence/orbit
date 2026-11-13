import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fallbackOrdering,
  packPlan,
  planGroup,
  planReason,
  scheduleRefusal,
  settleOrdering,
  type PlanMeeting,
  type PlanTask,
} from "@/lib/crm/plan-tasks";
import { dayStartIso, nextFreeStart, scheduleChoices } from "@/lib/crm/task-time";
import { DEFAULT_WORKING_HOURS, offDayReason, readWorkingHours, type WorkingHours } from "@/lib/working-hours";

const LONDON = "Europe/London";
const ME = "00000000-0000-4000-8000-0000000000aa";
const NOW = Date.parse("2026-11-12T11:20:00Z");
let serial = 0;

function task(title: string, overrides: Partial<PlanTask> = {}): PlanTask {
  serial += 1;
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    workspaceId: "ws-1",
    title,
    dueAt: null,
    dueHasTime: false,
    durationMinutes: 15,
    scheduledBy: null,
    priority: "normal",
    completedAt: null,
    archivedAt: null,
    ownerId: ME,
    createdAt: `2026-11-01T00:00:${String(serial % 60).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

const onDay = (day: string, overrides: Partial<PlanTask> = {}) => ({ dueAt: dayStartIso(day, LONDON), dueHasTime: false, ...overrides });

function meeting(startsAt: string, endsAt: string, overrides: Partial<PlanMeeting> = {}): PlanMeeting {
  return { subject: "Halden weekly", startsAt, endsAt, isAllDay: false, showAs: "busy", myResponse: null, ...overrides };
}

function pack(tasks: PlanTask[], meetings: PlanMeeting[] = [], extra: Partial<Parameters<typeof packPlan>[0]> = {}) {
  return packPlan({ tasks, meetings, viewerId: ME, now: NOW, timeZone: LONDON, ...extra });
}

const times = (plan: ReturnType<typeof pack>, ids: string[]) => ids.map((id) => plan.placed.find((entry) => entry.taskId === id)?.at ?? null);

describe("Plan's packer", () => {
  it("puts calls back to back late morning on their own day, 5 minutes after a meeting", () => {
    const calls = ["Call Jane Cooper", "Call Emma Lowe", "Ring Daniel Shaw", "Book a demo with Lucy Hart"].map((title) => task(title, onDay("2026-11-13")));
    const plan = pack(calls, [meeting("2026-11-13T10:00:00Z", "2026-11-13T11:00:00Z")]);
    assert.deepEqual(times(plan, calls.map((item) => item.id)), [
      "2026-11-13T11:05:00.000Z",
      "2026-11-13T11:20:00.000Z",
      "2026-11-13T11:35:00.000Z",
      "2026-11-13T11:50:00.000Z",
    ]);
    assert.ok(plan.placed.every((entry) => entry.group === "call"), "a meeting task joins the calls");
    assert.deepEqual(plan.unplaced, []);
  });

  it("breaks a run after 6 tasks or 90 minutes", () => {
    const calls = Array.from({ length: 8 }, (_, index) => task(`Call client ${index + 1}`, onDay("2026-11-16")));
    const plan = pack(calls);
    const starts = times(plan, calls.map((item) => item.id)).map((at) => Date.parse(at!));
    const sorted = [...starts].sort((left, right) => left - right);
    const gaps = sorted.slice(1).map((at, index) => (at - sorted[index]) / 60_000);
    assert.deepEqual(gaps.filter((gap) => gap === 15).length, 6, "six back to back then the next run");
    assert.ok(gaps.some((gap) => gap >= 30), "a break of at least 15 minutes between runs");
    const long = Array.from({ length: 3 }, (_, index) => task(`Call partner ${index + 1}`, onDay("2026-11-17", { durationMinutes: 40 })));
    const longPlan = pack(long);
    const longStarts = times(longPlan, long.map((item) => item.id)).map((at) => Date.parse(at!)).sort((left, right) => left - right);
    assert.equal((longStarts[1] - longStarts[0]) / 60_000, 40, "two 40 minute calls fit one 90 minute run");
    assert.ok((longStarts[2] - longStarts[1]) / 60_000 >= 55, "the third starts after a break");
  });

  it("puts emails in their own run after lunch and other tasks singly", () => {
    const emails = ["Email Halden Group the rollout dates", "Send Raj the Kestrel numbers", "Reply to Marlow & Finch"].map((title) => task(title, onDay("2026-11-12")));
    const call = task("Call Hannah Price for a reference", onDay("2026-11-12"));
    const other = task("Tidy up the Brightwell notes", onDay("2026-11-12", { durationMinutes: 20 }));
    const plan = pack([...emails, call, other], [meeting("2026-11-12T12:00:00Z", "2026-11-12T13:00:00Z")]);
    assert.deepEqual(times(plan, emails.map((item) => item.id)), ["2026-11-12T13:05:00.000Z", "2026-11-12T13:20:00.000Z", "2026-11-12T13:35:00.000Z"]);
    assert.equal(times(plan, [call.id])[0], "2026-11-12T11:20:00.000Z", "the call goes late morning, not in the past");
    assert.equal(times(plan, [other.id])[0], "2026-11-12T11:35:00.000Z", "other tasks take the earliest free time");
    assert.equal(plan.reason, "Calls late morning and emails after lunch by default.");
  });

  it("is blocked by Busy and tentative meetings but not Free, declined or all-day ones", () => {
    const day = "2026-11-16";
    const other = task("Draft the board pack", onDay(day, { durationMinutes: 60 }));
    const open = [
      meeting(`${day}T09:00:00Z`, `${day}T10:00:00Z`, { showAs: "free" }),
      meeting(`${day}T09:00:00Z`, `${day}T10:00:00Z`, { myResponse: "declined" }),
      meeting(`${day}T00:00:00Z`, `2026-11-17T00:00:00Z`, { isAllDay: true }),
    ];
    assert.equal(times(pack([other], open), [other.id])[0], `${day}T09:00:00.000Z`);
    const tentative = [meeting(`${day}T09:00:00Z`, `${day}T10:00:00Z`, { showAs: "tentative" })];
    assert.equal(times(pack([other], tentative), [other.id])[0], `${day}T10:05:00.000Z`);
  });

  it("never places anything in the past, before or after working hours", () => {
    const late = Date.parse("2026-11-12T17:20:00Z");
    const today = task("Write up the notes", onDay("2026-11-12"));
    const plan = packPlan({ tasks: [today], meetings: [], viewerId: ME, now: late, timeZone: LONDON });
    assert.deepEqual(plan.placed, []);
    assert.equal(plan.unplaced[0].reason, "No 15 minute gap left today");
    assert.equal(plan.unplaced[0].nextFree, "2026-11-13T09:00:00.000Z");
    assert.equal(plan.unplaced[0].outside, "2026-11-12T17:30:00.000Z");
    const early = packPlan({ tasks: [task("Prepare the pitch", onDay("2026-11-12"))], meetings: [], viewerId: ME, now: Date.parse("2026-11-12T06:00:00Z"), timeZone: LONDON });
    assert.equal(early.placed[0].at, "2026-11-12T09:00:00.000Z");
  });

  it("skips weekends and bank holidays and says why a dated task couldn't fit", () => {
    const saturday = task("Prepare Monday's agenda", onDay("2026-11-14"));
    const plan = pack([saturday]);
    assert.deepEqual(plan.placed, []);
    assert.equal(plan.unplaced[0].reason, "Sat 14 Nov is outside your working days");
    assert.equal(plan.unplaced[0].nextFree, "2026-11-16T09:00:00.000Z");
    assert.equal(plan.unplaced[0].outside, "2026-11-14T09:00:00.000Z");
    const bankHolidayNow = Date.parse("2026-08-27T10:00:00Z");
    const holiday = task("Send the invoices", onDay("2026-08-31"));
    const undated = Array.from({ length: 40 }, (_, index) => task(`Research prospect ${index + 1}`, { durationMinutes: 60 }));
    const summer = packPlan({ tasks: [holiday, ...undated], meetings: [], viewerId: ME, now: bankHolidayNow, timeZone: LONDON });
    assert.equal(summer.unplaced.find((item) => item.taskId === holiday.id)?.reason, "Mon 31 Aug is a bank holiday");
    const days = new Set(summer.placed.map((entry) => entry.at.slice(0, 10)));
    assert.ok(!days.has("2026-08-29") && !days.has("2026-08-30") && !days.has("2026-08-31"), "no weekend or bank holiday blocks");
  });

  it("uses wall-clock London time across the clock changes", () => {
    const allWeek: WorkingHours = DEFAULT_WORKING_HOURS.map((day) => ({ ...day, works: true }));
    const spring = Date.parse("2026-03-27T10:00:00Z");
    const sunday = task("Plan the week", onDay("2026-03-29"));
    const monday = task("Review the forecast", onDay("2026-03-30"));
    const saturday = task("Read the board pack", onDay("2026-03-28"));
    const springPlan = packPlan({ tasks: [sunday, monday, saturday], meetings: [], viewerId: ME, now: spring, timeZone: LONDON, hours: allWeek });
    assert.deepEqual(times(springPlan, [saturday.id, sunday.id, monday.id]), ["2026-03-28T09:00:00.000Z", "2026-03-29T08:00:00.000Z", "2026-03-30T08:00:00.000Z"]);
    const autumn = Date.parse("2026-10-23T09:00:00Z");
    const before = task("Plan the week", onDay("2026-10-24"));
    const change = task("Review the forecast", onDay("2026-10-25"));
    const afterChange = task("Call the bank", onDay("2026-10-26"));
    const autumnPlan = packPlan({ tasks: [before, change, afterChange], meetings: [], viewerId: ME, now: autumn, timeZone: LONDON, hours: allWeek });
    assert.deepEqual(times(autumnPlan, [before.id, change.id]), ["2026-10-24T08:00:00.000Z", "2026-10-25T09:00:00.000Z"]);
    assert.equal(times(autumnPlan, [afterChange.id])[0], "2026-10-26T10:30:00.000Z", "calls late morning in GMT");
  });

  it("gives an undated task any day and leaves timed tasks alone", () => {
    const busyToday = Array.from({ length: 20 }, (_, index) =>
      task(`Fixed block ${index}`, { dueAt: new Date(Date.parse("2026-11-12T11:20:00Z") + index * 20 * 60_000).toISOString(), dueHasTime: true, scheduledBy: "person", durationMinutes: 20 }),
    );
    const undated = task("Write the case study", { durationMinutes: 60 });
    const plan = pack([...busyToday, undated]);
    assert.equal(plan.placed.length, 1, "timed tasks are not proposed again");
    assert.equal(plan.placed[0].taskId, undated.id);
    assert.equal(plan.placed[0].at, "2026-11-13T09:00:00.000Z", "today is full of fixed blocks, so the next day");
  });

  it("keeps overdue tasks where they are and suggests today, then the next free day", () => {
    const timed = task("Ring Ashby Freight about the pilot invoice", { dueAt: "2026-11-10T14:00:00.000Z", dueHasTime: true, scheduledBy: "person" });
    const dated = task("Send Tom Becker the signed order form", onDay("2026-11-11"));
    const plan = pack([timed, dated], [meeting("2026-11-12T11:20:00Z", "2026-11-12T15:15:00Z")]);
    assert.deepEqual(plan.placed, []);
    assert.deepEqual(
      plan.overdue.map((item) => [item.title, item.at]),
      [
        ["Ring Ashby Freight about the pilot invoice", "2026-11-12T15:20:00.000Z"],
        ["Send Tom Becker the signed order form", "2026-11-12T15:35:00.000Z"],
      ],
    );
    const full = pack([timed], [meeting("2026-11-12T11:00:00Z", "2026-11-12T17:30:00Z")]);
    assert.equal(full.overdue[0].at, "2026-11-13T10:30:00.000Z");
  });

  it("only replans blocks Plan placed, on the same day, and never a block the person placed", () => {
    const planned = task("Email Raj the numbers", { dueAt: "2026-11-16T16:00:00.000Z", dueHasTime: true, scheduledBy: "planner" });
    const mine = task("Email Oliver Grant", { dueAt: "2026-11-16T13:00:00.000Z", dueHasTime: true, scheduledBy: "person" });
    const kept = pack([planned, mine]);
    assert.deepEqual(kept.placed, [], "without Replan my blocks nothing timed moves");
    const moved = pack([planned, mine], [], { replan: true });
    assert.deepEqual(moved.placed.map((entry) => [entry.taskId, entry.at]), [[planned.id, "2026-11-16T13:15:00.000Z"]]);
    assert.ok(!moved.placed.some((entry) => entry.taskId === mine.id));
    const past = task("Call Ben Archer", { dueAt: "2026-11-12T10:00:00.000Z", dueHasTime: true, scheduledBy: "planner", durationMinutes: 15 });
    const replanned = pack([past], [], { replan: true });
    assert.deepEqual(replanned.placed, []);
    assert.equal(replanned.overdue[0].taskId, past.id, "a planner block already gone by is overdue, not replanned");
  });

  it("ignores its own unlocked blocks when replanning, so they free their time", () => {
    const planned = task("Call Jane Cooper", { dueAt: "2026-11-16T10:30:00.000Z", dueHasTime: true, scheduledBy: "planner" });
    const dated = task("Call Emma Lowe", onDay("2026-11-16"));
    const plan = pack([planned, dated], [], { replan: true });
    assert.deepEqual(times(plan, [planned.id, dated.id]).sort(), ["2026-11-16T10:30:00.000Z", "2026-11-16T10:45:00.000Z"], "back to back in the slot the block had");
    const without = pack([planned, dated]);
    assert.equal(times(without, [dated.id])[0], "2026-11-16T10:45:00.000Z", "without replanning the block still counts as busy");
  });

  it("lists a dated task under Couldn't fit when its day is full, with the next free day and a time outside hours", () => {
    const big = task("Draft the Halden rollout plan", onDay("2026-11-16", { durationMinutes: 120 }));
    const meetings = [meeting("2026-11-16T09:00:00Z", "2026-11-16T10:30:00Z"), meeting("2026-11-16T11:30:00Z", "2026-11-16T13:00:00Z"), meeting("2026-11-16T14:00:00Z", "2026-11-16T16:00:00Z")];
    const plan = pack([big], meetings);
    assert.deepEqual(plan.placed, []);
    const missed = plan.unplaced[0];
    assert.equal(missed.reason, "No 2 hour gap on Mon 16 Nov");
    assert.equal(missed.nextFree, "2026-11-17T09:00:00.000Z");
    assert.equal(missed.outside, "2026-11-16T17:30:00.000Z");
  });

  it("follows the AI's order and durations but never a duration the person set, and can't add tasks", () => {
    const set = task("Write the proposal", onDay("2026-11-13", { durationMinutes: 45 }));
    const fresh = task("Tidy up the Brightwell notes", onDay("2026-11-13"));
    const plan = pack([set, fresh], [], {
      ordering: [
        { id: fresh.id, group: "other", minutes: 30 },
        { id: set.id, group: "other", minutes: 90 },
        { id: "00000000-0000-4000-8000-999999999999", group: "call", minutes: 15 },
      ],
    });
    const byId = new Map(plan.placed.map((entry) => [entry.taskId, entry]));
    assert.equal(byId.get(fresh.id)?.durationMinutes, 30);
    assert.equal(byId.get(fresh.id)?.suggested, true);
    assert.equal(byId.get(set.id)?.durationMinutes, 45, "the person's duration stays");
    assert.equal(byId.get(set.id)?.suggested, false);
    assert.equal(byId.get(fresh.id)?.at, "2026-11-13T09:00:00.000Z", "the AI put it first");
    assert.equal(plan.placed.length, 2);
    assert.match(plan.reason ?? "", /Durations in purple are suggested\./);
  });

  it("orders by kind, due date and priority without the AI", () => {
    const later = task("Call Ben", onDay("2026-11-20"));
    const soon = task("Call Amy", onDay("2026-11-13"));
    const email = task("Email Cara", onDay("2026-11-13"));
    const urgent = task("Draft terms", onDay("2026-11-13", { priority: "high" }));
    const normal = task("Draft memo", onDay("2026-11-13"));
    assert.deepEqual(
      fallbackOrdering([normal, urgent, email, later, soon]).map((item) => item.id),
      [soon.id, later.id, email.id, urgent.id, normal.id],
    );
    assert.deepEqual(settleOrdering([soon], [{ id: soon.id, group: "nonsense" as "call", minutes: 7 }]), [{ id: soon.id, group: "call", minutes: 5 }]);
    assert.equal(planGroup("Book a meeting with Halden"), "call");
  });

  it("only plans the viewer's own open tasks", () => {
    const theirs = task("Call for Sam", { ...onDay("2026-11-13"), ownerId: "someone-else" });
    const unassigned = task("Call nobody", { ...onDay("2026-11-13"), ownerId: null });
    const done = task("Call done", { ...onDay("2026-11-13"), completedAt: "2026-11-12T10:00:00Z" });
    assert.deepEqual(pack([theirs, unassigned, done]).placed, []);
  });

  it("words the reason honestly", () => {
    assert.equal(planReason([]), null);
    assert.equal(planReason([{ group: "other", suggested: false }]), null);
    assert.equal(planReason([{ group: "email", suggested: false }]), "Emails after lunch by default.");
    assert.equal(
      planReason([{ group: "call", suggested: false }], { call: { from: 600, to: 720, learned: true }, email: null, other: null }),
      "Calls in the morning, as you usually do.",
    );
  });
});

describe("Schedule rules", () => {
  const base = { viewerId: ME, now: NOW, timeZone: LONDON };
  const entry = (at: string, extra: Partial<{ durationMinutes: number; moveDay: string | null }> = {}) => ({ taskId: "x", at, durationMinutes: 15, moveDay: null, ...extra });

  it("keeps a dated task on its day and moves an overdue one only when the new day is named", () => {
    const dated = task("Call Jane", onDay("2026-11-16"));
    assert.equal(scheduleRefusal(dated, entry("2026-11-16T10:00:00Z"), { ...base, mode: "agent" }), null);
    assert.match(scheduleRefusal(dated, entry("2026-11-17T10:00:00Z"), { ...base, mode: "agent" })!, /due Mon 16 Nov, so it stays on that day/);
    assert.match(scheduleRefusal(dated, entry("2026-11-17T10:00:00Z", { moveDay: "2026-11-17" }), { ...base, mode: "agent" })!, /stays on that day/);
    assert.equal(scheduleRefusal(dated, entry("2026-11-17T10:00:00Z", { moveDay: "2026-11-17" }), { ...base, mode: "plan" }), null, "a click in the preview may move it");
    const overdue = task("Ring Ashby", onDay("2026-11-10"));
    assert.match(scheduleRefusal(overdue, entry("2026-11-12T14:00:00Z"), { ...base, mode: "agent" })!, /overdue from Tue 10 Nov\. Name the new day/);
    assert.equal(scheduleRefusal(overdue, entry("2026-11-12T14:00:00Z", { moveDay: "2026-11-12" }), { ...base, mode: "agent" }), null);
    const undated = task("Research Halden");
    assert.equal(scheduleRefusal(undated, entry("2026-11-18T14:00:00Z"), { ...base, mode: "agent" }), null);
  });

  it("refuses a person's block, someone else's task, the past, time outside working hours and clashes", () => {
    const placed = task("Email Oliver", { dueAt: "2026-11-16T13:00:00Z", dueHasTime: true, scheduledBy: "person" });
    assert.match(scheduleRefusal(placed, entry("2026-11-16T14:00:00Z"), { ...base, mode: "plan" })!, /You placed “Email Oliver” yourself/);
    const planned = task("Email Raj", { dueAt: "2026-11-16T13:00:00Z", dueHasTime: true, scheduledBy: "planner" });
    assert.equal(scheduleRefusal(planned, entry("2026-11-16T14:00:00Z"), { ...base, mode: "agent" }), null);
    assert.match(scheduleRefusal(task("Theirs", { ownerId: "other" }), entry("2026-11-16T14:00:00Z"), { ...base, mode: "agent" })!, /isn't yours/);
    assert.match(scheduleRefusal(task("Late"), entry("2026-11-12T10:00:00Z"), { ...base, mode: "plan" })!, /in the past/);
    assert.match(scheduleRefusal(task("Evening"), entry("2026-11-16T18:00:00Z"), { ...base, mode: "agent" })!, /outside your working hours \(09:00 to 17:30\)/);
    assert.equal(scheduleRefusal(task("Evening"), entry("2026-11-16T18:00:00Z"), { ...base, mode: "plan" }), null, "Outside hours is the person's click");
    assert.match(scheduleRefusal(task("Weekend"), entry("2026-11-14T10:00:00Z"), { ...base, mode: "agent" })!, /can't go on Sat 14 Nov: it's outside your working days/);
    assert.match(scheduleRefusal(task("Holiday"), entry("2026-12-28T10:00:00Z"), { ...base, mode: "agent" })!, /it's over Christmas/);
    const meetings = [meeting("2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z"), meeting("2026-11-16T12:00:00Z", "2026-11-16T13:00:00Z", { showAs: "free", subject: "Lunch" })];
    assert.match(scheduleRefusal(task("Clash"), entry("2026-11-16T10:30:00Z"), { ...base, mode: "agent", meetings })!, /clashes with Halden weekly/);
    assert.equal(scheduleRefusal(task("Free"), entry("2026-11-16T12:15:00Z"), { ...base, mode: "agent", meetings }), null);
    const other = task("Existing block", { dueAt: "2026-11-16T15:00:00Z", dueHasTime: true, scheduledBy: "person", durationMinutes: 30 });
    assert.match(scheduleRefusal(task("Clash"), entry("2026-11-16T15:15:00Z"), { ...base, mode: "agent", others: [other] })!, /clashes with “Existing block”/);
    const mover = task("Mover");
    const batch = [entry("2026-11-16T15:00:00Z", { durationMinutes: 30 }), { ...entry("2026-11-16T15:15:00Z"), taskId: mover.id }];
    assert.match(scheduleRefusal(mover, batch[1], { ...base, mode: "agent", batch })!, /overlaps another block/);
  });
});

describe("Working hours", () => {
  it("reads seven days and refuses a finish before the start or off the quarter hour", () => {
    assert.deepEqual(readWorkingHours(DEFAULT_WORKING_HOURS), DEFAULT_WORKING_HOURS);
    assert.equal(readWorkingHours(DEFAULT_WORKING_HOURS.slice(1)), null);
    assert.equal(readWorkingHours(DEFAULT_WORKING_HOURS.map((day) => ({ ...day, start: 600, end: 540 }))), null);
    assert.equal(readWorkingHours(DEFAULT_WORKING_HOURS.map((day) => ({ ...day, start: 545 }))), null);
    assert.equal(offDayReason("2026-11-14", DEFAULT_WORKING_HOURS), "outside your working days");
    const saturdays = DEFAULT_WORKING_HOURS.map((day, index) => (index === 6 ? { ...day, works: true } : day));
    assert.equal(offDayReason("2026-11-14", saturdays), null);
  });

  it("drives Schedule's next free slot and morning choices", () => {
    const friday = DEFAULT_WORKING_HOURS.map((day, index) => (index === 4 ? { works: true, start: 8 * 60, end: 16 * 60 } : day));
    assert.equal(new Date(nextFreeStart(Date.parse("2026-11-12T06:30:00Z"), 15, [], LONDON, friday)!).toISOString(), "2026-11-12T08:00:00.000Z");
    assert.equal(nextFreeStart(Date.parse("2026-11-12T15:50:00Z"), 15, [], LONDON, friday), null, "finishes at 16:00 on a Thursday");
    const choices = scheduleChoices({ durationMinutes: 15, now: Date.parse("2026-11-11T11:20:00Z"), hours: friday }, LONDON);
    assert.deepEqual(choices.find((choice) => choice.id === "tomorrow")?.at, "2026-11-12T08:00:00.000Z");
    const weekend = DEFAULT_WORKING_HOURS.map((day, index) => (index === 6 ? { works: true, start: 600, end: 720 } : day));
    const fromFriday = scheduleChoices({ durationMinutes: 15, now: Date.parse("2026-11-13T18:00:00Z"), hours: weekend }, LONDON);
    assert.deepEqual(fromFriday.map((choice) => [choice.label, choice.at]), [
      ["Tomorrow morning", "2026-11-14T10:00:00.000Z"],
      ["Monday morning", "2026-11-16T09:00:00.000Z"],
    ]);
  });
});
