import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Reminder } from "@/lib/crm/reminders";
import {
  addKeyFor,
  blockChoice,
  CARD_MARGIN,
  clampCardPosition,
  dayLabel,
  defaultCardPosition,
  draftOfRepeat,
  EMPTY_DRAFT,
  dueChange,
  dueCount,
  groupReminders,
  optimisticReminder,
  readAddLine,
  readCardPosition,
  reminderDue,
  reminderInputOf,
  repeatWords,
  taskStartOf,
  toggledBlock,
  withoutStaleBlock,
} from "@/lib/reminders-card";
import type { PadAiParse } from "@/lib/crm/task-pad";
import { padSaveOutcome } from "@/lib/task-pad";
import { repeatInputOf } from "@/lib/task-repeat";

const TODAY = "2026-11-19";
const NOW = new Date("2026-11-19T12:00:00Z");

let next = 0;
function reminder(fields: Partial<Reminder> & { title: string }): Reminder {
  next += 1;
  return {
    id: fields.id ?? `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    dueOn: null,
    dueAt: null,
    time: null,
    blocksTime: false,
    durationMinutes: 15,
    repeat: null,
    repeatText: null,
    completedAt: null,
    repeatOf: null,
    movedTo: null,
    link: null,
    createdAt: `2026-11-01T09:00:${String(next % 60).padStart(2, "0")}.000Z`,
    updatedAt: "2026-11-01T09:00:00.000Z",
    ...fields,
  };
}

function titles(rows: { reminder: Reminder }[]) {
  return rows.map((row) => row.reminder.title);
}

describe("reminders card", () => {
  describe("saving", () => {
    it("uses one key for the same reminder until it changes", () => {
      let made = 0;
      const fresh = () => `key-${(made += 1)}`;
      const first = addKeyFor(null, { title: "Bins out", dueOn: TODAY }, fresh);
      assert.equal(addKeyFor(first, { title: "Bins out", dueOn: TODAY }, fresh), first);
      const changed = addKeyFor(first, { title: "Bins out", dueOn: "2026-11-20" }, fresh);
      assert.notEqual(changed.key, first.key);
    });

    it("treats a task as saved even when its reminder couldn't be removed", () => {
      assert.equal(padSaveOutcome({ reminderError: "Couldn't remove the reminder. Try again." } as { error?: string }), "saved");
      assert.equal(padSaveOutcome({}), "saved");
      assert.equal(padSaveOutcome({ error: "Enter a task." }), "failed");
      assert.equal(padSaveOutcome(null), "retry");
    });
  });

  describe("groups", () => {
    const overdue = reminder({ title: "Renew car tax", dueOn: "2026-11-18" });
    const older = reminder({ title: "Old one", dueOn: "2026-11-02" });
    const bins = reminder({ title: "Bins out", dueOn: TODAY, repeat: { every: "week", days: ["th"], ends: null } });
    const call = reminder({ title: "Call Mum back", dueOn: TODAY, dueAt: "2026-11-19T18:30:00.000Z", time: "18:30" });
    const dentist = reminder({ title: "Dentist", dueOn: "2026-11-20", dueAt: "2026-11-20T08:45:00.000Z", time: "08:45", blocksTime: true });
    const flights = reminder({ title: "Book flights", dueOn: "2026-11-25" });
    const boiler = reminder({ title: "Boiler quotes" });
    const done = reminder({ title: "Dry cleaning", dueOn: TODAY, completedAt: "2026-11-19T10:00:00.000Z" });
    const doneEarlier = reminder({ title: "Earlier", completedAt: "2026-11-17T10:00:00.000Z" });
    const all = [flights, boiler, done, dentist, call, bins, overdue, doneEarlier, older];

    it("puts overdue and today's reminders under Today, oldest first, with the overdue ones marked", () => {
      const groups = groupReminders(all, {}, TODAY);
      assert.deepEqual(titles(groups.today), ["Old one", "Renew car tax", "Bins out", "Call Mum back"]);
      assert.deepEqual(
        groups.today.map((row) => row.overdue),
        [true, true, false, false],
      );
      assert.deepEqual(titles(groups.upcoming), ["Dentist", "Book flights"]);
      assert.deepEqual(titles(groups.noDate), ["Boiler quotes"]);
      assert.deepEqual(
        groups.done.map((item) => item.title),
        ["Dry cleaning", "Earlier"],
      );
    });

    it("keeps a ticked reminder in place, crossed out, until the card closes", () => {
      const ticked = { ...call, completedAt: "2026-11-19T12:00:00.000Z" };
      const list = all.map((item) => (item.id === call.id ? ticked : item));
      const groups = groupReminders(list, { [call.id]: { snapshot: call, doneId: call.id } }, TODAY);
      assert.deepEqual(titles(groups.today), ["Old one", "Renew car tax", "Bins out", "Call Mum back"]);
      assert.equal(groups.today[3].ticked, true);
      assert.equal(groups.done.some((item) => item.id === call.id), false);
    });

    it("hides the open row while the tick is on its way", () => {
      const groups = groupReminders(all, { [bins.id]: { snapshot: bins, doneId: null } }, TODAY);
      assert.deepEqual(
        groups.today.filter((row) => row.reminder.id === bins.id).map((row) => row.ticked),
        [true],
      );
    });

    it("shows a ticked repeating reminder crossed out and its next date under Upcoming", () => {
      const moved = { ...bins, dueOn: "2026-11-26" };
      const copy = reminder({ title: "Bins out", dueOn: TODAY, completedAt: "2026-11-19T12:00:00.000Z", repeatOf: bins.id, movedTo: "2026-11-26" });
      const list = [...all.map((item) => (item.id === bins.id ? moved : item)), copy];
      const groups = groupReminders(list, { [bins.id]: { snapshot: bins, doneId: copy.id } }, TODAY);
      assert.deepEqual(
        groups.today.filter((row) => row.reminder.title === "Bins out").map((row) => row.ticked),
        [true],
      );
      assert.deepEqual(titles(groups.upcoming), ["Dentist", "Book flights", "Bins out"]);
      assert.equal(groups.done.some((item) => item.id === copy.id), false);
    });

    it("counts open reminders due today or overdue", () => {
      assert.equal(dueCount(all, TODAY), 4);
      assert.equal(dueCount([dentist, flights, boiler, done], TODAY), 0);
      assert.equal(dueCount(all, "2026-11-20"), 5);
    });

    it("labels days relative to today", () => {
      assert.equal(dayLabel("2026-11-18", TODAY), "Yesterday");
      assert.equal(dayLabel(TODAY, TODAY), "Today");
      assert.equal(dayLabel("2026-11-20", TODAY), "Tomorrow");
      assert.equal(dayLabel("2026-11-25", TODAY, NOW), "Wed 25 Nov");
    });

    it("words a repeat without its time", () => {
      assert.equal(repeatWords(bins), "Every Thursday");
      assert.equal(repeatWords(boiler), null);
    });
  });

  describe("add line", () => {
    const blank = { kept: [] as string[] };

    it("reads a date and time and turns it into a timed reminder", () => {
      const reading = readAddLine("Washing machine repair thu 10am", blank, NOW);
      assert.equal(reading.title, "Washing machine repair");
      assert.equal(reading.due, "2026-11-26T10:00");
      assert.equal(reading.phrase, "thu 10am");
      assert.deepEqual(reminderInputOf(reading), { title: "Washing machine repair", dueAt: "2026-11-26T10:00:00.000Z" });
    });

    it("reads a date on its own as a day", () => {
      const reading = readAddLine("Send Jo a card tomorrow", blank, NOW);
      assert.deepEqual(reminderInputOf(reading), { title: "Send Jo a card", dueOn: "2026-11-20" });
    });

    it("reads a repeat and starts it on its first day", () => {
      const reading = readAddLine("Bins out every tuesday", blank, NOW);
      assert.deepEqual(reminderInputOf(reading), { title: "Bins out", dueOn: "2026-11-24", repeat: { every: "week", days: ["tu"], ends: null } });
    });

    it("turns a typed time range into Block time", () => {
      const reading = readAddLine("Dentist tomorrow 9-10am", blank, NOW);
      assert.equal(reading.unsure, true);
      assert.deepEqual(reminderInputOf(reading), { title: "Dentist", dueAt: "2026-11-20T09:00:00.000Z", blocksTime: true, durationMinutes: 60 });
    });

    it("never blocks time without a time", () => {
      assert.deepEqual(reminderInputOf({ title: "Dentist", due: "2026-11-20", repeat: null, durationMinutes: 60 }), { title: "Dentist", dueOn: "2026-11-20" });
    });

    it("ignores a typed reminder lead and leaves its words in the title", () => {
      const reading = readAddLine("Pay the plumber tomorrow 9am remind me 10 minutes before", blank, NOW);
      const input = reminderInputOf(reading);
      assert.equal(input.dueAt, "2026-11-20T09:00:00.000Z");
      assert.equal(input.title, "Pay the plumber remind me 10 minutes before");
      assert.equal("remindMinutes" in input, false);
      assert.equal(input.blocksTime, undefined);
    });

    it("reads a typed length as Block time when there is a time", () => {
      const cases: [string, number][] = [
        ["Dentist tomorrow 9am for 1 hour", 60],
        ["Dentist tomorrow 9am for 1 hr", 60],
        ["Dentist tomorrow 9am for 30 mins", 30],
        ["Dentist tomorrow 9am for 30 minutes", 30],
        ["Dentist tomorrow 9am for 1.5 hours", 90],
        ["Dentist tomorrow 9am for 2h", 120],
        ["Dentist for 45 min tomorrow 9am", 45],
      ];
      for (const [text, minutes] of cases) {
        const reading = readAddLine(text, blank, NOW);
        assert.deepEqual(reminderInputOf(reading), { title: "Dentist", dueAt: "2026-11-20T09:00:00.000Z", blocksTime: true, durationMinutes: minutes }, text);
        assert.equal(reading.length?.minutes, minutes, text);
      }
    });

    it("never reads a bare m as minutes", () => {
      for (const text of ["Swim for 100m tomorrow 7am", "Budget for 20m tomorrow 10am", "Sell shares for 5m tomorrow 9am"]) {
        const reading = readAddLine(text, blank, NOW);
        assert.equal(reading.length, null, text);
        assert.equal(reminderInputOf(reading).blocksTime, undefined, text);
        assert.match(reminderInputOf(reading).title ?? "", / for \d+m\b/, text);
      }
    });

    it("keeps a length's words when its chip is removed", () => {
      const reading = readAddLine("Dentist tomorrow 9am for 1 hour", blank, NOW);
      assert.ok(reading.length);
      const kept = readAddLine("Dentist tomorrow 9am for 1 hour", { kept: [reading.length.key] }, NOW);
      assert.equal(kept.length, null);
      assert.deepEqual(reminderInputOf(kept), { title: "Dentist for 1 hour", dueAt: "2026-11-20T09:00:00.000Z" });
    });

    it("never blocks time for a length without a time, or outside 5 to 480 minutes", () => {
      assert.deepEqual(reminderInputOf(readAddLine("Dentist tomorrow for 1 hour", blank, NOW)), { title: "Dentist for 1 hour", dueOn: "2026-11-20" });
      for (const text of ["Gym tomorrow 9am for 9 hours", "Gym tomorrow 9am for 2 mins", "Gym tomorrow 9am for 2.5 mins"]) {
        const input = reminderInputOf(readAddLine(text, blank, NOW));
        assert.equal(input.blocksTime, undefined, text);
      }
      assert.equal(readAddLine("Gym tomorrow 9am for 2 months", blank, NOW).length, null);
    });

    it("keeps the words as text when asked", () => {
      const reading = readAddLine("Washing machine repair thu 10am", blank, NOW);
      const kept = readAddLine("Washing machine repair thu 10am", { kept: [reading.key] }, NOW);
      assert.equal(kept.due, null);
      assert.deepEqual(reminderInputOf(kept), { title: "Washing machine repair thu 10am" });
    });

    it("shows a guess like any other reading and saves it", () => {
      const cases: [string, string, string][] = [
        ["Call Mum back 6:30", "Call Mum back", "2026-11-19T18:30:00.000Z"],
        ["Call plumber tomorrow at 9", "Call plumber", "2026-11-20T09:00:00.000Z"],
        ["Dentist Tuesday 25th November 2026 at 3:30pm", "Dentist", "2026-11-25T15:30:00.000Z"],
      ];
      for (const [text, title, dueAt] of cases) {
        const reading = readAddLine(text, blank, NOW);
        assert.equal(reading.unsure, true, text);
        assert.ok(reading.phrase, text);
        assert.ok(reading.marks.length > 0, text);
        assert.deepEqual(reminderInputOf(reading), { title, dueAt }, text);
      }
    });

    it("keeps a guess's words as text with no date when its chip is removed", () => {
      for (const text of ["Call plumber tomorrow at 9", "Dentist Tuesday 25th November 2026 at 3:30pm"]) {
        const reading = readAddLine(text, blank, NOW);
        const kept = readAddLine(text, { kept: [reading.key] }, NOW);
        assert.equal(kept.due, null, text);
        assert.deepEqual(kept.marks, [], text);
        assert.deepEqual(reminderInputOf(kept), { title: text }, text);
      }
    });

    it("applies the AI's reading of an unsure phrase, and keeps it as text when asked", () => {
      const text = "Call plumber tomorrow at 9";
      const start = text.indexOf("tomorrow");
      const value: PadAiParse = { title: "Call plumber", due: "2026-11-20T21:00", remindMinutes: null, durationMinutes: null, marks: [{ start, end: text.length, kind: "when" }] };
      const reading = readAddLine(text, { kept: [], ai: { text, value } }, NOW);
      assert.equal(reading.phrase, "tomorrow at 9");
      assert.deepEqual(reminderInputOf(reading), { title: "Call plumber", dueAt: "2026-11-20T21:00:00.000Z" });
      const stale = readAddLine(`${text}am`, { kept: [], ai: { text, value } }, NOW);
      assert.equal(stale.due, "2026-11-20T09:00");
      const kept = readAddLine(text, { kept: [reading.key], ai: { text, value } }, NOW);
      assert.deepEqual(reminderInputOf(kept), { title: text });
      const guessKept = readAddLine(text, { kept: [readAddLine(text, blank, NOW).key], ai: { text, value } }, NOW);
      assert.deepEqual(reminderInputOf(guessKept), { title: text });
    });

    it("falls back to the guess when the AI finds no date", () => {
      const text = "Call plumber tomorrow at 9";
      const value: PadAiParse = { title: text, due: null, remindMinutes: null, durationMinutes: null, marks: [] };
      assert.deepEqual(reminderInputOf(readAddLine(text, { kept: [], ai: { text, value } }, NOW)), { title: "Call plumber", dueAt: "2026-11-20T09:00:00.000Z" });
    });

    it("still reads the phrases it reads for sure", () => {
      const cases: [string, Record<string, unknown>][] = [
        ["Washing machine repair thu 10am", { title: "Washing machine repair", dueAt: "2026-11-26T10:00:00.000Z" }],
        ["Dentist 25 November at 3pm", { title: "Dentist", dueAt: "2026-11-25T15:00:00.000Z" }],
        ["Dentist 25/11/2026 3pm", { title: "Dentist", dueAt: "2026-11-25T15:00:00.000Z" }],
        ["Car MOT 3 December", { title: "Car MOT", dueOn: "2026-12-03" }],
        ["Bins out every Thursday", { title: "Bins out", dueOn: "2026-11-19", repeat: { every: "week", days: ["th"], ends: null } }],
        ["Pick up parcel friday morning", { title: "Pick up parcel", dueAt: "2026-11-20T09:00:00.000Z" }],
        ["Dentist next Wednesday at 2pm", { title: "Dentist", dueAt: "2026-11-25T14:00:00.000Z" }],
        ["Boiler service 26 Nov 10am for 1 hour", { title: "Boiler service", dueAt: "2026-11-26T10:00:00.000Z", blocksTime: true, durationMinutes: 60 }],
      ];
      for (const [text, input] of cases) {
        const reading = readAddLine(text, blank, NOW);
        assert.equal(reading.unsure, false, text);
        assert.deepEqual(reminderInputOf(reading), input, text);
      }
    });

    it("leaves phrases it can't place as text", () => {
      const reading = readAddLine("Pay rent on the 5th?", blank, NOW);
      assert.equal(reading.due, null);
      assert.deepEqual(reminderInputOf(reading), { title: "Pay rent on the 5th?" });
    });

    it("never reads records out of the text", () => {
      const reading = readAddLine("Ask Sarah Okafor about Hiscox tomorrow", blank, NOW);
      assert.deepEqual(reminderInputOf(reading), { title: "Ask Sarah Okafor about Hiscox", dueOn: "2026-11-20" });
    });
  });

  describe("Block time while adding", () => {
    const text = "Boiler service thu 10am";

    it("starts off, and turns on with the task default length", () => {
      const reading = readAddLine(text, { kept: [] }, NOW);
      assert.equal(reading.durationMinutes, null);
      assert.equal(reading.blockMinutes, 15);
      const on = readAddLine(text, { kept: [], block: blockChoice(reading, true, reading.blockMinutes) }, NOW);
      assert.deepEqual(reminderInputOf(on), { title: "Boiler service", dueAt: "2026-11-26T10:00:00.000Z", blocksTime: true, durationMinutes: 15 });
      const longer = readAddLine(text, { kept: [], block: blockChoice(on, true, 45) }, NOW);
      assert.equal(reminderInputOf(longer).durationMinutes, 45);
      const off = readAddLine(text, { kept: [], block: blockChoice(longer, false, 45) }, NOW);
      assert.deepEqual(reminderInputOf(off), { title: "Boiler service", dueAt: "2026-11-26T10:00:00.000Z" });
    });

    it("keeps a typed length when Block time is switched off and back on", () => {
      const typed = "Call Sam at 3pm for 1 hour";
      const start = { ...EMPTY_DRAFT, text: typed };
      const first = readAddLine(typed, { kept: start.kept, block: start.block }, NOW);
      assert.equal(first.durationMinutes, 60);
      const off = toggledBlock(start, first);
      const offReading = readAddLine(typed, { kept: off.kept, block: off.block }, NOW);
      assert.equal(offReading.durationMinutes, null);
      assert.equal(offReading.title, "Call Sam for 1 hour");
      const on = toggledBlock(off, offReading);
      const onReading = readAddLine(typed, { kept: on.kept, block: on.block }, NOW);
      assert.equal(onReading.durationMinutes, 60);
      assert.equal(onReading.title, "Call Sam");
    });

    it("switches Block time on and off without a typed length", () => {
      const start = { ...EMPTY_DRAFT, text };
      const on = toggledBlock(start, readAddLine(text, { kept: [], block: null }, NOW));
      assert.equal(readAddLine(text, { kept: on.kept, block: on.block }, NOW).durationMinutes, 15);
      const off = toggledBlock(on, readAddLine(text, { kept: on.kept, block: on.block }, NOW));
      assert.equal(readAddLine(text, { kept: off.kept, block: off.block }, NOW).durationMinutes, null);
    });

    it("lets a typed length turn it on with that length", () => {
      const reading = readAddLine(text, { kept: [] }, NOW);
      const block = blockChoice(reading, true, 15);
      const typed = readAddLine(`${text} for 2 hours`, { kept: [], block }, NOW);
      assert.equal(reminderInputOf(typed).durationMinutes, 120);
      const changed = readAddLine(`${text} for 2 hours`, { kept: [], block: blockChoice(typed, true, 30) }, NOW);
      assert.equal(reminderInputOf(changed).durationMinutes, 30);
    });

    it("never blocks time without a time, and clears the choice when the time goes", () => {
      const reading = readAddLine(text, { kept: [] }, NOW);
      const block = blockChoice(reading, true, 30);
      assert.equal(reminderInputOf(readAddLine("Boiler service thu", { kept: [], block }, NOW)).blocksTime, undefined);
      const draft = { ...EMPTY_DRAFT, text, block };
      assert.equal(withoutStaleBlock(draft, NOW), draft);
      assert.equal(withoutStaleBlock({ ...draft, text: "Boiler service thu" }, NOW).block, null);
      assert.equal(withoutStaleBlock({ ...draft, kept: [reading.key] }, NOW).block, null);
    });

    it("changes the add key when it changes, and resets with the draft", () => {
      let made = 0;
      const fresh = () => `key-${(made += 1)}`;
      const reading = readAddLine(text, { kept: [] }, NOW);
      const off = addKeyFor(null, reminderInputOf(reading), fresh);
      const on = addKeyFor(off, reminderInputOf(readAddLine(text, { kept: [], block: blockChoice(reading, true, 15) }, NOW)), fresh);
      assert.notEqual(on.key, off.key);
      const longer = addKeyFor(on, reminderInputOf(readAddLine(text, { kept: [], block: blockChoice(reading, true, 30) }, NOW)), fresh);
      assert.notEqual(longer.key, on.key);
      assert.equal(EMPTY_DRAFT.block, null);
      assert.equal(readAddLine(text, { kept: EMPTY_DRAFT.kept, block: EMPTY_DRAFT.block }, NOW).durationMinutes, null);
    });
  });

  describe("details", () => {
    const timed = reminder({ title: "Dentist", dueOn: "2026-11-20", dueAt: "2026-11-20T09:00:00.000Z", time: "09:00", blocksTime: true, durationMinutes: 30 });

    it("shows date, time and repeat changes straight away, so a second edit builds on the first", () => {
      const moved = optimisticReminder(timed, { dueOn: "2026-11-23" });
      assert.deepEqual([moved.dueOn, moved.time, moved.dueAt, moved.blocksTime], ["2026-11-23", "09:00", "2026-11-23T09:00:00.000Z", true]);
      const later = optimisticReminder(moved, { dueAt: "2026-11-23T14:30:00.000Z" });
      assert.deepEqual([later.dueOn, later.time], ["2026-11-23", "14:30"]);
      const dayOnly = optimisticReminder(later, { dueOn: "2026-11-23", dueAt: null });
      assert.deepEqual([dayOnly.dueOn, dayOnly.time, dayOnly.dueAt, dayOnly.blocksTime], ["2026-11-23", null, null, false]);
      const repeating = optimisticReminder(dayOnly, { repeat: { every: "week", days: ["mo"], ends: null } });
      assert.deepEqual(repeating.repeat, { every: "week", days: ["mo"], ends: null });
      assert.equal(repeatWords(repeating), "Every Monday");
      const cleared = optimisticReminder(timed, { dueOn: null });
      assert.deepEqual([cleared.dueOn, cleared.time, cleared.blocksTime], [null, null, false]);
      assert.equal(optimisticReminder(timed, { title: "Dentist again" }).title, "Dentist again");
    });

    it("turns a repeating reminder into a task with only the repeats left", () => {
      const counted = reminder({ title: "Water plants", dueOn: "2026-11-21", repeat: { every: "week", days: ["sa"], ends: { after: 2 } } });
      const start = taskStartOf(counted);
      assert.equal(start.due, "2026-11-21");
      assert.deepEqual(start.repeat?.ends, { count: 2 });
      assert.deepEqual(taskStartOf(timed), { title: "Dentist", due: "2026-11-20T09:00", durationMinutes: 30, repeat: null });
    });

    it("turns a picked date or time into the engine's fields", () => {
      assert.deepEqual(dueChange(null), { dueOn: null });
      assert.deepEqual(dueChange("2026-11-21"), { dueOn: "2026-11-21", dueAt: null });
      assert.deepEqual(dueChange("2026-11-21T10:15"), { dueAt: "2026-11-21T10:15:00.000Z" });
      assert.deepEqual(dueChange("2026-07-01T10:15"), { dueAt: "2026-07-01T09:15:00.000Z" });
      assert.equal(reminderDue({ dueOn: "2026-11-21", time: "10:15" }), "2026-11-21T10:15");
      assert.equal(reminderDue({ dueOn: "2026-11-21", time: null }), "2026-11-21");
      assert.equal(reminderDue({ dueOn: null, time: null }), null);
    });

    it("rebuilds the repeat picker's value from a reminder's repeat", () => {
      const cases = [
        { every: "day" as const, ends: null },
        { every: "weekday" as const, ends: { after: 3 } },
        { every: "week" as const, days: ["mo", "th"], ends: null },
        { every: "month" as const, monthDay: 19, ends: { on: "2027-06-01" } },
        { every: "month" as const, monthWeek: { n: 3, weekday: "th" }, ends: null },
        { every: "year" as const, interval: 2, ends: null },
      ];
      for (const input of cases) {
        const draft = draftOfRepeat(input, TODAY);
        assert.ok(draft);
        assert.deepEqual(repeatInputOf(draft.rule, draft.ends), input);
      }
      assert.equal(draftOfRepeat(null, TODAY), null);
      assert.equal(draftOfRepeat({ every: "day" }, null), null);
    });
  });

  describe("card position", () => {
    const size = { width: 340, height: 600 };
    const viewport = { width: 1280, height: 800 };

    it("starts at the top right", () => {
      assert.deepEqual(defaultCardPosition(size, viewport), { x: 922, y: 64 });
    });

    it("keeps the card inside the window", () => {
      assert.deepEqual(clampCardPosition({ x: -50, y: -20 }, size, viewport), { x: CARD_MARGIN, y: CARD_MARGIN });
      assert.deepEqual(clampCardPosition({ x: 5000, y: 5000 }, size, viewport), { x: 932, y: 800 - 88 - CARD_MARGIN });
      assert.deepEqual(clampCardPosition({ x: 400.4, y: 300.6 }, size, viewport), { x: 400, y: 301 });
    });

    it("keeps clear of an open side panel", () => {
      assert.deepEqual(defaultCardPosition(size, viewport, 480), { x: 442, y: 64 });
      assert.deepEqual(clampCardPosition({ x: 922, y: 64 }, size, viewport, 480), { x: 452, y: 64 });
    });

    it("pulls the card back in when the window shrinks", () => {
      assert.deepEqual(clampCardPosition({ x: 922, y: 600 }, size, { width: 1024, height: 500 }), { x: 676, y: 500 - 88 - CARD_MARGIN });
    });

    it("reads a stored position and ignores anything else", () => {
      assert.deepEqual(readCardPosition('{"x":10,"y":20}'), { x: 10, y: 20 });
      assert.equal(readCardPosition(null), null);
      assert.equal(readCardPosition("not json"), null);
      assert.equal(readCardPosition('{"x":"10","y":20}'), null);
      assert.equal(readCardPosition("[1,2]"), null);
    });
  });
});
