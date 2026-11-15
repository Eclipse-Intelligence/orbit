import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTaskWithClickUp } from "@/lib/crm/clickup";
import { parsePadWithAi } from "@/lib/crm/task-pad";
import { localInstant } from "@/lib/crm/task-time";
import type { UserActor } from "@/lib/crm/types";
import { shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { keptReading, padReading, padRepeatDue, parseTaskText, type PadAiAnswer } from "@/lib/task-pad";
import { repeatInputOf, type RepeatRule } from "@/lib/task-repeat";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const SATURDAY_10_20 = new Date("2026-11-14T10:20:00Z");

function parse(text: string, now = SATURDAY_10_20) {
  return parseTaskText(text, now);
}

const PHRASES: { phrase: string; rule: RepeatRule; first: string }[] = [
  { phrase: "every day", rule: { freq: "daily", interval: 1 }, first: "2026-11-14" },
  { phrase: "daily", rule: { freq: "daily", interval: 1 }, first: "2026-11-14" },
  { phrase: "weekly", rule: { freq: "weekly", interval: 1, weekdays: ["sa"] }, first: "2026-11-14" },
  { phrase: "monthly", rule: { freq: "monthly", interval: 1, monthDay: 14 }, first: "2026-11-14" },
  { phrase: "yearly", rule: { freq: "yearly", interval: 1 }, first: "2026-11-14" },
  { phrase: "every weekday", rule: { freq: "weekly", interval: 1, weekdays: ["mo", "tu", "we", "th", "fr"] }, first: "2026-11-16" },
  { phrase: "every Monday", rule: { freq: "weekly", interval: 1, weekdays: ["mo"] }, first: "2026-11-16" },
  { phrase: "every Mon and Thu", rule: { freq: "weekly", interval: 1, weekdays: ["mo", "th"] }, first: "2026-11-16" },
  { phrase: "every other Friday", rule: { freq: "weekly", interval: 2, weekdays: ["fr"] }, first: "2026-11-20" },
  { phrase: "every 2 weeks", rule: { freq: "weekly", interval: 2, weekdays: ["sa"] }, first: "2026-11-14" },
  { phrase: "every 3 days", rule: { freq: "daily", interval: 3 }, first: "2026-11-14" },
  { phrase: "every month on the 1st", rule: { freq: "monthly", interval: 1, monthDay: 1 }, first: "2026-12-01" },
  { phrase: "the last Friday of every month", rule: { freq: "monthly", interval: 1, monthWeek: { n: -1, weekday: "fr" } }, first: "2026-11-27" },
  { phrase: "first Monday of the month", rule: { freq: "monthly", interval: 1, monthWeek: { n: 1, weekday: "mo" } }, first: "2026-12-07" },
  { phrase: "every 14 Nov", rule: { freq: "yearly", interval: 1 }, first: "2026-11-14" },
];

const TIMES = [
  { words: "", at: null },
  { words: " at 2pm", at: "14:00" },
];

const ENDS = [
  { words: "", ends: () => ({ never: true }) },
  { words: " until 18 Dec", ends: () => ({ until: "2026-12-18" }) },
  { words: " for 6 weeks", ends: (first: string) => ({ until: shiftDay(first, 41) }) },
  { words: " 10 times", ends: () => ({ count: 10 }) },
];

const NEGATIVES = [
  "Email every client",
  "Email every client about the price change",
  "every time he calls",
  "check every invoice",
  "every one of them",
  "Monday call",
  "weekly report draft",
  "every so often",
  "every day counts",
  "every week counts",
  "Read the daily",
  "Send the weekly update",
  "Our monthly newsletter",
  "Fix the weekly digest",
  "Daily Mail interview",
  "Annually reviewed accounts",
  "every Monday call notes",
  "Thank everyone who came",
  "Everyday carry list",
  "Review every page of the contract",
  "Ask about every other option",
  "every last detail",
  "Call Jane every Monday tomorrow",
  "Review every Friday from Sam",
  "Call every Monday and every Thursday",
  "Read [[every day]] before the call",
  "Mondays are hard",
  "Each of them",
  "Check each invoice",
  "every 1000 users",
  "every first-time buyer",
];

describe("typed repeats", () => {
  it("reads every corpus phrase with and without a time and an end, exactly", () => {
    let cases = 0;
    for (const { phrase, rule, first } of PHRASES) {
      for (const time of TIMES) {
        for (const end of ENDS) {
          const typed = `Water the plants ${phrase}${time.words}${end.words}`;
          const read = parse(typed);
          const label = JSON.stringify(typed);
          assert.equal(read.unsure, false, label);
          assert.equal(read.title, "Water the plants", label);
          assert.equal(read.due, time.at ? `${first}T${time.at}` : first, label);
          assert.deepEqual(read.repeat, { rule, ends: end.ends(first) }, label);
          const lit = read.marks.map((mark) => typed.slice(mark.start, mark.end)).join(" ");
          assert.equal(lit, `${phrase}${time.words}${end.words}`, label);
          cases += 1;
        }
      }
    }
    assert.equal(cases, PHRASES.length * TIMES.length * ENDS.length);
  });

  it("never lights up a repeat for the negatives", () => {
    assert.ok(NEGATIVES.length >= 25);
    for (const typed of NEGATIVES) {
      const read = parse(typed);
      assert.ok(!read.repeat, JSON.stringify(typed));
      if (!read.due) assert.equal(read.title, typed.replace(/\s+/g, " ").trim(), JSON.stringify(typed));
    }
  });

  it("keeps the person's casing and reads the plan's examples", () => {
    const walk = parse("Walk the dog Every Monday at 2PM");
    assert.equal(walk.title, "Walk the dog");
    assert.deepEqual(walk.repeat?.rule, { freq: "weekly", interval: 1, weekdays: ["mo"] });
    assert.deepEqual(parse("Team call every Monday 10am").due, "2026-11-16T10:00");
    assert.equal(parse("Invoice every month on the 1st").due, "2026-12-01");
    assert.equal(parse("Team call every Monday 10am about pricing").title, "Team call about pricing");
    const later = parse("Walk the dog every day at 2pm", new Date("2026-11-14T15:00:00Z"));
    assert.equal(later.due, "2026-11-15T14:00", "after 14:00 the first one is tomorrow");
    assert.equal(parse("Birthday card every 14 Nov at 9am").due, "2027-11-14T09:00");
    const remind = parse("Invoice every month on the 1st at 9am remind me 30 mins before");
    assert.deepEqual({ due: remind.due, remindMinutes: remind.remindMinutes, title: remind.title }, { due: "2026-12-01T09:00", remindMinutes: 30, title: "Invoice" });
  });

  it("sets the first occurrence from a one-off date in the same text", () => {
    const review = parse("Review every other Friday from Monday");
    assert.equal(review.title, "Review");
    assert.equal(review.due, "2026-11-20");
    const later = parse("Gym every Monday from 30 Nov at 6pm");
    assert.equal(later.due, "2026-11-30T18:00");
    assert.equal(later.title, "Gym");
    assert.equal(parse("Team call Monday 23 Nov 10am every week").due, "2026-11-23T10:00");
    assert.equal(parse("Gym every Monday from 30 Nov").repeat?.rule.weekdays?.join(), "mo");
  });

  it("leaves wording it can't settle to the AI reader with nothing lit", () => {
    for (const typed of ["Stand-up every weekday at 9:30", "Call every Monday at 10", "every Monday for 30 mins", "Review every Friday until 31 Feb", "Gym every day 0 times"]) {
      const read = parse(typed);
      assert.equal(read.unsure, true, typed);
      assert.equal(read.due, null, typed);
      assert.ok(!read.repeat, typed);
      assert.deepEqual(read.marks, [], typed);
    }
  });

  it("Keep as text keeps the repeat words and saves no repeat", () => {
    const typed = "Walk the dog every day at 2pm";
    const read = parse(typed);
    const shown = padReading(typed, read, null, []);
    assert.equal(shown.title, "Walk the dog");
    assert.ok(shown.repeat);
    const kept = padReading(typed, read, null, [keptReading(typed, shown.marks).key]);
    assert.deepEqual({ title: kept.title, due: kept.due, repeat: kept.repeat }, { title: typed, due: null, repeat: undefined });
  });

  it("works out the first occurrence for a repeat picked from the menu", () => {
    assert.equal(padRepeatDue({ rule: { freq: "weekly", interval: 1, weekdays: ["mo", "tu", "we", "th", "fr"] }, ends: { never: true } }, "2026-11-14", SATURDAY_10_20), "2026-11-16");
    assert.equal(padRepeatDue({ rule: { freq: "daily", interval: 1 }, ends: { never: true } }, "2026-11-14T09:00", SATURDAY_10_20), "2026-11-15T09:00");
    assert.equal(padRepeatDue({ rule: { freq: "weekly", interval: 2, weekdays: ["fr"] }, ends: { never: true } }, "2026-11-14", SATURDAY_10_20), "2026-11-20");
  });
});

describe("AI read repeats", () => {
  const ask = async (text: string, answer: PadAiAnswer) => {
    const fetchImpl: typeof fetch = async () => Response.json({ model: "test", choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }] });
    const previous = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "llm-test";
    try {
      const reading = await parsePadWithAi(text, SATURDAY_10_20, { fetchImpl });
      return reading && { title: reading.title, due: reading.due, repeat: reading.repeat ?? null, lit: reading.marks.map((mark) => text.slice(mark.start, mark.end)) };
    } finally {
      if (previous === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previous;
    }
  };
  const nothing = (title: string) => ({ title, due: null, repeat: null, lit: [] });
  const base = { remindMinutes: null, durationMinutes: null };

  it("shows a repeat the AI reads when its words agree", async () => {
    assert.deepEqual(await ask("Payroll fortnightly on Thursdays", { ...base, phrases: [], due: "2026-11-19", repeat: { phrase: "fortnightly on Thursdays", every: "week", interval: 2, days: ["th"] } }), {
      title: "Payroll",
      due: "2026-11-19",
      repeat: { rule: { freq: "weekly", interval: 2, weekdays: ["th"] }, ends: { never: true } },
      lit: ["fortnightly on Thursdays"],
    });
    assert.deepEqual(await ask("Stand-up every weekday at 9:30", { ...base, phrases: ["at 9:30"], due: "2026-11-16T09:30", repeat: { phrase: "every weekday", every: "weekday" } }), {
      title: "Stand-up",
      due: "2026-11-16T09:30",
      repeat: { rule: { freq: "weekly", interval: 1, weekdays: ["mo", "tu", "we", "th", "fr"] }, ends: { never: true } },
      lit: ["every weekday", "at 9:30"],
    });
    const counted = await ask("Physio every second day 6 times", { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: "every second day 6 times", every: "day", interval: 2, ends: { after: 6 } } });
    assert.deepEqual(counted?.repeat, { rule: { freq: "daily", interval: 2 }, ends: { count: 6 } });
  });

  it("throws away a repeat the words don't support", async () => {
    const text = "Payroll fortnightly on Thursdays";
    const right = { phrase: "fortnightly on Thursdays", every: "week" as const, interval: 2, days: ["th"] };
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-11-19", repeat: { ...right, days: ["fr"] } }), nothing(text), "another day");
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-11-19", repeat: { ...right, interval: 3 } }), nothing(text), "another interval");
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-11-20", repeat: right }), nothing(text), "a first date off the pattern");
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-11-19", repeat: { ...right, every: "month" } }), nothing(text), "another frequency");
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-11-19", repeat: { ...right, ends: { after: 4 } } }), nothing(text), "an end that wasn't said");
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-11-19", repeat: { ...right, phrase: "fortnightly on Thursday" } }), nothing(text), "a phrase not in the text");
    assert.deepEqual(await ask("every day counts", { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: "every day", every: "day" } }), nothing("every day counts"), "a noun after the pattern");
    assert.deepEqual(await ask("Email every client", { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: "every client", every: "day" } }), nothing("Email every client"), "no pattern");
    assert.deepEqual(await ask("Physio every second day 6 times", { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: "every second day 6 times", every: "day", interval: 2, ends: { after: 7 } } }), nothing("Physio every second day 6 times"));
  });

  it("never turns repeat words into a one-off date", async () => {
    assert.deepEqual(await ask("Team call every Monday", { ...base, phrases: ["every Monday"], due: "2026-11-16" }), nothing("Team call every Monday"));
    assert.deepEqual(await ask("Team call every Monday", { ...base, phrases: ["Monday"], due: "2026-11-16" }), nothing("Team call every Monday"));
    assert.deepEqual(await ask("Payroll fortnightly on Thursdays", { ...base, phrases: ["on Thursdays"], due: "2026-11-19" }), nothing("Payroll fortnightly on Thursdays"));
  });
});

describe("saving a typed repeat", () => {
  let mark: UserActor;
  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@pad-repeat.test", "Mark Ridgeon");
  });
  useServerlessPool();
  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("creates the series on the first occurrence the card showed", async () => {
    for (const typed of ["Walk the dog every day at 11pm", "Review every other Friday", "Invoice every month on the 1st", "Board pack first Monday of the month", "Birthday card every 14 Nov", "Stand-up every weekday at 08:00 until 18 Dec", "Gym every 3 days for 6 weeks"]) {
      const read = parseTaskText(typed);
      assert.ok(read.repeat && read.due, typed);
      const { task } = await createTaskWithClickUp(mark, { title: read.title, ...(read.due.includes("T") ? { dueAt: localInstant(read.due) } : { dueDate: read.due }), repeat: repeatInputOf(read.repeat.rule, read.repeat.ends) }, null);
      assert.equal(task.occursOn, read.due.slice(0, 10), typed);
      assert.equal(task.dueHasTime, read.due.includes("T"), typed);
      assert.equal(task.title, read.title, typed);
      assert.deepEqual(task.repeat?.rule, read.repeat.rule, typed);
    }
  });
});
