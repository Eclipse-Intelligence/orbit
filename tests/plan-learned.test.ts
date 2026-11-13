import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packPlan, planReason, type PlanMeeting, type PlanTask } from "@/lib/crm/plan-tasks";
import { preferencesFromSpread } from "@/lib/crm/schedule-preferences";
import { dayStartIso } from "@/lib/crm/task-time";
import {
  addSignal,
  emptySpread,
  isLearned,
  learnedCaption,
  learnedView,
  LEARN_THRESHOLD,
  signalCount,
  slotAt,
  learnedPeriods,
  periodScore,
  slotWeights,
  type LearnedSpread,
} from "@/lib/learned-times";

const LONDON = "Europe/London";
const ME = "00000000-0000-4000-8000-0000000000aa";
let serial = 0;

function task(title: string, day: string): PlanTask {
  serial += 1;
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    workspaceId: "ws-1",
    title,
    dueAt: dayStartIso(day, LONDON),
    dueHasTime: false,
    durationMinutes: 15,
    scheduledBy: null,
    priority: "normal",
    completedAt: null,
    archivedAt: null,
    ownerId: ME,
    createdAt: "2026-11-01T00:00:00.000Z",
  };
}

function meeting(startsAt: string, endsAt: string): PlanMeeting {
  return { subject: "Halden weekly", startsAt, endsAt, isAllDay: false, showAs: "busy", myResponse: null };
}

function callsAt(times: Record<string, number>, spread = emptySpread()): LearnedSpread {
  for (const [at, count] of Object.entries(times)) for (let index = 0; index < count; index += 1) addSignal(spread, "call", "placed", at, LONDON);
  return spread;
}

function afternoonCalls(count = 12): LearnedSpread {
  return callsAt({ "2026-11-03T15:00:00Z": Math.ceil(count / 3), "2026-11-04T15:00:00Z": Math.ceil(count / 3), "2026-11-05T15:00:00Z": count - 2 * Math.ceil(count / 3) });
}

function datedTask(title: string, day: string, extra: Partial<PlanTask> = {}): PlanTask {
  return { ...task(title, day), ...extra };
}

describe("Learned times", () => {
  it("weighs a time placed by hand above a meeting booked, and both above a task ticked off", () => {
    const spread = emptySpread();
    addSignal(spread, "call", "placed", "2026-11-10T10:00:00Z", LONDON);
    addSignal(spread, "call", "booked", "2026-11-10T10:10:00Z", LONDON);
    addSignal(spread, "call", "ticked", "2026-11-10T10:20:00Z", LONDON);
    const slot = slotAt("2026-11-10T10:00:00Z", LONDON)!;
    assert.equal(spread.call.slots[slot], 7);
    assert.deepEqual([spread.call.placed, spread.call.booked, spread.call.ticked], [1, 1, 1]);
    assert.equal(signalCount(spread.call), 2, "two ticks count as one signal");
  });

  it("needs about ten signals before a kind counts as learned", () => {
    const spread = emptySpread();
    for (let index = 0; index < LEARN_THRESHOLD - 1; index += 1) addSignal(spread, "email", "placed", "2026-11-10T14:00:00Z", LONDON);
    assert.equal(isLearned(spread.email), false);
    assert.deepEqual(preferencesFromSpread(spread).email, { from: 13 * 60, to: 15 * 60 + 30, learned: false }, "the default stays");
    addSignal(spread, "email", "ticked", "2026-11-10T14:00:00Z", LONDON);
    assert.equal(isLearned(spread.email), false, "one tick is half a signal");
    addSignal(spread, "email", "placed", "2026-11-10T14:00:00Z", LONDON);
    assert.equal(isLearned(spread.email), true);
    assert.equal(preferencesFromSpread(spread).email?.learned, true);
    const ticks = emptySpread();
    for (let index = 0; index < 2 * LEARN_THRESHOLD; index += 1) addSignal(ticks, "other", "ticked", "2026-11-10T16:00:00Z", LONDON);
    assert.equal(isLearned(ticks.other), true, "twenty ticks are enough on their own");
  });

  it("reads the wall clock in London either side of the clock change", () => {
    assert.equal(slotAt("2026-07-14T09:00:00Z", LONDON), slotAt("2026-01-13T10:00:00Z", LONDON), "10:00 on a Tuesday in summer and winter");
    assert.equal(slotAt("2026-10-25T00:30:00Z", LONDON), slotAt("2026-10-25T01:30:00Z", LONDON), "the repeated hour lands in the same half hour");
    const spread = afternoonCalls();
    const before = packPlan({ tasks: [task("Call Jane Cooper", "2026-10-23")], meetings: [], viewerId: ME, now: Date.parse("2026-10-23T06:00:00Z"), timeZone: LONDON, preferences: preferencesFromSpread(spread) });
    const after = packPlan({ tasks: [task("Call Jane Cooper", "2026-10-26")], meetings: [], viewerId: ME, now: Date.parse("2026-10-23T06:00:00Z"), timeZone: LONDON, preferences: preferencesFromSpread(spread) });
    assert.equal(before.placed[0]?.at, "2026-10-23T13:30:00.000Z", "14:30 in summer time");
    assert.equal(after.placed[0]?.at, "2026-10-26T14:30:00.000Z", "14:30 after the clocks go back");
  });

  it("places tasks in learned times first, then the nearest of the rest of working hours", () => {
    const preferences = preferencesFromSpread(afternoonCalls());
    const now = Date.parse("2026-11-12T08:00:00Z");
    const call = task("Call Jane Cooper", "2026-11-13");
    const learned = packPlan({ tasks: [call], meetings: [], viewerId: ME, now, timeZone: LONDON, preferences });
    assert.equal(learned.placed[0]?.at, "2026-11-13T14:30:00.000Z", "the start of the learned afternoon");
    const fallback = packPlan({ tasks: [call], meetings: [], viewerId: ME, now, timeZone: LONDON });
    assert.equal(fallback.placed[0]?.at, "2026-11-13T10:30:00.000Z", "late morning without learning");
    const busy = packPlan({ tasks: [call], meetings: [meeting("2026-11-13T14:30:00Z", "2026-11-13T16:30:00Z")], viewerId: ME, now, timeZone: LONDON, preferences });
    assert.equal(busy.placed[0]?.at, "2026-11-13T14:15:00.000Z", "the nearest free time to the learned afternoon");
    const email = task("Email Raj the numbers", "2026-11-13");
    assert.equal(
      packPlan({ tasks: [email], meetings: [], viewerId: ME, now, timeZone: LONDON, preferences }).placed[0]?.at,
      "2026-11-13T13:00:00.000Z",
      "emails keep their default until learned",
    );
  });

  it("only says learned times helped when the blocks sit in them", () => {
    const preferences = preferencesFromSpread(afternoonCalls());
    const now = Date.parse("2026-11-12T08:00:00Z");
    const calls = [task("Call Jane Cooper", "2026-11-13"), task("Ring Daniel Shaw", "2026-11-13")];
    const email = task("Email Raj the numbers", "2026-11-13");
    const plan = packPlan({ tasks: [...calls, email], meetings: [], viewerId: ME, now, timeZone: LONDON, preferences });
    assert.equal(plan.reason, "Calls after lunch, as you usually do. Emails after lunch by default.");
    const crowded = packPlan({
      tasks: calls,
      meetings: [meeting("2026-11-13T13:30:00Z", "2026-11-13T16:30:00Z")],
      viewerId: ME,
      now,
      timeZone: LONDON,
      preferences,
    });
    assert.equal(crowded.placed.length, 2);
    assert.equal(crowded.reason, null, "no claim when the calls couldn't go in their usual time");
    const morning = emptySpread();
    for (let index = 0; index < 12; index += 1) addSignal(morning, "call", "placed", "2026-11-10T09:30:00Z", LONDON);
    for (let index = 0; index < 12; index += 1) addSignal(morning, "email", "placed", "2026-11-10T13:30:00Z", LONDON);
    assert.equal(
      planReason(
        [
          { group: "call", suggested: false, at: "2026-11-13T09:30:00Z", durationMinutes: 15 },
          { group: "email", suggested: true, at: "2026-11-13T13:30:00Z", durationMinutes: 15 },
        ],
        preferencesFromSpread(morning),
        LONDON,
      ),
      "Calls in the morning and emails after lunch, as you usually do. Durations in purple are suggested.",
    );
  });

  it("describes what it learned for Settings", () => {
    const spread = emptySpread();
    for (let index = 0; index < 23; index += 1) addSignal(spread, "call", "placed", "2026-11-10T11:00:00Z", LONDON);
    for (let index = 0; index < 9; index += 1) addSignal(spread, "call", "booked", "2026-11-11T11:30:00Z", LONDON);
    for (let index = 0; index < 31; index += 1) addSignal(spread, "email", "placed", "2026-11-10T14:00:00Z", LONDON);
    for (let index = 0; index < 40; index += 1) addSignal(spread, "email", "ticked", "2026-11-10T14:00:00Z", LONDON);
    for (let index = 0; index < 4; index += 1) addSignal(spread, "other", "placed", "2026-11-10T16:00:00Z", LONDON);
    assert.equal(learnedCaption("call", spread.call), "Learned from 23 calls you placed and 9 meetings you booked.");
    assert.equal(learnedCaption("email", spread.email), "Learned from 31 emails you placed and 40 you ticked off.");
    assert.equal(learnedCaption("other", spread.other), "Not enough yet (4 of about 10). Any time in working hours until then.");
    const calls = learnedView("call", spread.call);
    assert.equal(calls.label, "Late morning");
    assert.equal(calls.week.length, 5);
    assert.ok(calls.week.every((row) => row.length === 20));
    assert.equal(Math.max(...calls.week[0]), 1, "the busiest half hour is the darkest");
    assert.equal(learnedView("email", spread.email).label, "After lunch");
    assert.equal(learnedView("other", spread.other).label, "Any time");
    assert.equal(learnedView("other", emptySpread().other).week.flat().every((value) => value === 0), true);
    assert.equal(Math.max(...learnedView("other", spread.other).week.flat()), 0.4, "a kind still learning shows faintly");
    assert.equal(slotWeights(spread.call).length, 7 * 48);
  });
});

describe("Learned periods", () => {
  const now = Date.parse("2026-11-12T06:00:00Z");
  const pack = (tasks: PlanTask[], spread: LearnedSpread, extra: Partial<Parameters<typeof packPlan>[0]> = {}) =>
    packPlan({ tasks, meetings: [], viewerId: ME, now, timeZone: LONDON, preferences: preferencesFromSpread(spread), ...extra });

  it("names where the blocks went when a kind has a morning and an afternoon", () => {
    const spread = callsAt({ "2026-11-10T09:30:00Z": 12, "2026-11-11T15:00:00Z": 10 });
    assert.deepEqual(learnedPeriods(spread.call), [
      { from: 540, to: 630 },
      { from: 870, to: 960 },
    ]);
    const plan = pack([task("Call Jane Cooper", "2026-11-13")], spread, { meetings: [meeting("2026-11-13T08:30:00Z", "2026-11-13T12:00:00Z")] });
    assert.equal(plan.placed[0]?.at, "2026-11-13T14:30:00.000Z");
    assert.equal(plan.reason, "Calls after lunch, as you usually do.");
    assert.equal(learnedView("call", spread.call).label, "Morning and late afternoon");
  });

  it("uses every learned period on every working day, and the line says which one it used", () => {
    const spread = callsAt({ "2026-11-10T09:30:00Z": 12, "2026-11-12T15:00:00Z": 8 });
    assert.deepEqual(learnedPeriods(spread.call), [
      { from: 540, to: 630 },
      { from: 900, to: 930 },
    ]);
    const plan = pack([task("Call Jane Cooper", "2026-11-12")], spread);
    assert.equal(plan.placed[0]?.at, "2026-11-12T09:00:00.000Z", "Thursday's call goes in the first learned period");
    assert.equal(plan.reason, "Calls in the morning, as you usually do.");
    const both = pack(
      [task("Call Jane Cooper", "2026-11-13"), task("Ring Daniel Shaw", "2026-11-16")],
      spread,
      { meetings: [meeting("2026-11-13T08:30:00Z", "2026-11-13T12:00:00Z")] },
    );
    assert.deepEqual(both.placed.map((entry) => entry.at), ["2026-11-13T15:00:00.000Z", "2026-11-16T09:00:00.000Z"]);
    assert.equal(both.reason, "Calls in the morning or in the afternoon, as you usually do.");
  });

  it("checks the whole block against a period, and falls back to the nearest time, not the earliest", () => {
    assert.equal(periodScore([{ from: 870, to: 960 }], 930, 30), 0);
    assert.equal(periodScore([{ from: 870, to: 960 }], 945, 30), 1);
    assert.equal(periodScore([{ from: 870, to: 960 }], 600, 15), 1 + 255);
    const late = callsAt({ "2026-11-10T16:00:00Z": 12 });
    const plan = pack([task("Call Jane Cooper", "2026-11-13")], late, { meetings: [meeting("2026-11-13T14:55:00Z", "2026-11-13T17:30:00Z")] });
    assert.equal(plan.placed[0]?.at, "2026-11-13T14:40:00.000Z", "straight before the meeting, the closest to 15:30");
    assert.equal(plan.reason, null);
  });

  it("places a kind learned outside working hours as close to it as working hours allow", () => {
    const evening = callsAt({ "2026-11-10T19:00:00Z": 12 });
    const plan = pack([task("Call Jane Cooper", "2026-11-13")], evening);
    assert.equal(plan.placed[0]?.at, "2026-11-13T17:15:00.000Z");
    assert.equal(plan.reason, null, "no claim, since the block isn't in the learned time");
  });

  it("moves a Replan block into learned times when its time no longer works", () => {
    const planned = datedTask("Call Jane Cooper", "2026-11-13", { dueAt: "2026-11-13T10:00:00.000Z", dueHasTime: true, scheduledBy: "planner" });
    const plan = pack([planned], afternoonCalls(), { replan: true, meetings: [meeting("2026-11-13T10:00:00Z", "2026-11-13T10:30:00Z")] });
    assert.equal(plan.placed[0]?.at, "2026-11-13T14:30:00.000Z");
  });

  it("leaves blocks dragged in the preview out of the reason line", () => {
    const spread = emptySpread();
    for (let index = 0; index < 12; index += 1) addSignal(spread, "other", "placed", "2026-11-10T15:00:00Z", LONDON);
    const chores = [task("Tidy the Brightwell notes", "2026-11-13"), task("Draft the Halden terms", "2026-11-13"), task("Update the price list", "2026-11-13")];
    const keep = [
      { taskId: chores[0].id, at: "2026-11-13T09:00:00.000Z", durationMinutes: 15 },
      { taskId: chores[1].id, at: "2026-11-13T09:30:00.000Z", durationMinutes: 15 },
    ];
    const plan = pack(chores, spread, { keep });
    assert.equal(plan.placed.find((entry) => entry.taskId === chores[2].id)?.at, "2026-11-13T14:30:00.000Z");
    assert.equal(plan.reason, "Other tasks after lunch, as you usually do.", "the two dragged blocks don't outvote it");
  });

  it("gives an undated task the earliest learned time in the next 3 working days, or else the earliest room", () => {
    const later = Date.parse("2026-11-12T16:00:00Z");
    const undated = { ...task("Call Jane Cooper", "2026-11-13"), dueAt: null };
    const learned = pack([undated], afternoonCalls(), { now: later });
    assert.equal(learned.placed[0]?.at, "2026-11-13T14:30:00.000Z", "tomorrow's learned time beats the rest of today");
    const full = ["2026-11-12", "2026-11-13", "2026-11-16"].map((day) => meeting(`${day}T14:00:00Z`, `${day}T17:00:00Z`));
    const fallback = pack([undated], afternoonCalls(), { now: later, meetings: full });
    assert.equal(fallback.placed[0]?.at, "2026-11-12T17:05:00.000Z", "no learned time free, so the earliest day with room");
    const defaults = pack([undated], emptySpread(), { now: later });
    assert.equal(defaults.placed[0]?.at, "2026-11-12T16:00:00.000Z", "defaults keep the earliest day with room");
  });
});
