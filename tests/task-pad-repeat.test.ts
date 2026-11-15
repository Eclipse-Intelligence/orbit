import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTaskWithClickUp } from "@/lib/crm/clickup";
import { parsePadWithAi } from "@/lib/crm/task-pad";
import { localInstant } from "@/lib/crm/task-time";
import type { UserActor } from "@/lib/crm/types";
import { shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { chipOverrides, keptReading, padReading, padRepeatDue, parseTaskText, type PadAiAnswer } from "@/lib/task-pad";
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
  { phrase: "first Monday of each month", rule: { freq: "monthly", interval: 1, monthWeek: { n: 1, weekday: "mo" } }, first: "2026-12-07" },
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
  { words: " for 10 times", ends: () => ({ count: 10 }) },
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
  "Monthly: send invoices tomorrow",
  "Daily: stand-up notes",
  "3 times daily",
  "twice daily",
  "Stretch 3 times every Monday",
  "every 0 days",
  "every month on the 0th",
  "every month on the 32nd",
  "Pay rent every month on the last",
  "Pay rent every month at 9am on the 1st",
  "Pay rent on the first of the month and the fifteenth",
  "Pay rent every month on the first and third Monday",
  "Pay rent every month on the second and fourth Friday",
  "Pay rent on the first every month",
  "Gym every Monday and Friday at 6pm, and Sunday",
  "Call Jane every week on the phone in March",
  "Pay rent every month on the 5",
  "Pay rent every month on day 5",
  "Call every day next week",
  "Call daily in 2 weeks",
  "Plan Saturday every Friday",
  "Call every Monday on Tuesday",
  "Gym every Monday then Wednesday",
  "Gym every weekday and Saturday",
  "Call Bob Wednesday every Monday",
  "Call Bob every day with Sam on Friday",
  "Send report tomorrow every 20 Nov",
  "Pay rent every month on payday",
  "Call every day until 20 Dec, 5 times",
  "Report each and every day",
  "Stretch 3x daily",
  "Switch to paying monthly",
  "Move Acme to billing monthly",
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

  it("reads a word ordinal as the day of the month and never falls back to today", () => {
    for (const typed of ["Pay rent every month on the first", "Pay rent monthly on the first", "Pay rent the first of every month", "Pay rent on the first of every month"]) {
      const read = parse(typed);
      assert.equal(read.title, "Pay rent", typed);
      assert.equal(read.due, "2026-12-01", typed);
      assert.deepEqual(read.repeat?.rule, { freq: "monthly", interval: 1, monthDay: 1 }, typed);
    }
    assert.deepEqual(parse("Report every month on the third").repeat?.rule, { freq: "monthly", interval: 1, monthDay: 3 });
    for (const typed of ["Pay rent every month on the last", "Pay rent every month on the fifth", "Pay rent monthly at 9am on the 1st"]) {
      const read = parse(typed);
      assert.deepEqual({ unsure: read.unsure, due: read.due, repeat: read.repeat }, { unsure: true, due: null, repeat: undefined }, typed);
    }
  });

  it("goes unsure on a bare count after a repeat with no set day, which can mean times a day", () => {
    for (const typed of ["Take tablets every day 3 times", "Take tablets daily 3 times", "Post every week 3 times"]) assert.equal(parse(typed).unsure, true, typed);
    assert.deepEqual(parse("Take tablets every day for 3 times").repeat?.ends, { count: 3 });
    assert.deepEqual(parse("Review proposals every Wednesday 5 times").repeat?.ends, { count: 5 });
  });

  it("goes unsure on misspelt repeats instead of saving a one-off", () => {
    for (const typed of ["Gym everyday", "Gym everyday at 7am", "Gym every Wedensday at 9am", "Gym every 2wks", "Gym every 3 mths"]) {
      const read = parse(typed);
      assert.deepEqual({ unsure: read.unsure, due: read.due }, { unsure: true, due: null }, typed);
    }
    assert.equal(parse("Buy everyday items").unsure, false);
  });

  it("goes unsure on a deadline, a day word before the repeat, a negation or a hedge", () => {
    for (const typed of ["Gym every day by 15 Dec", "Plan tomorrow every day", "No gym every Monday", "Gym almost every Monday", "Tidy nearly every day"]) {
      const read = parse(typed);
      assert.deepEqual({ unsure: read.unsure, repeat: read.repeat }, { unsure: true, repeat: undefined }, typed);
    }
    assert.equal(parse("Gym every day from tomorrow").due, "2026-11-15");
  });

  it("goes unsure on numbers out of range and counts it can't place", () => {
    for (const typed of ["Gym every 0 days", "Invoice every month on the 0th", "Invoice every month on the 32nd", "Stretch 3 times daily", "Stretch 3 times every Monday", "Stretch twice daily"]) {
      const read = parse(typed);
      assert.deepEqual({ unsure: read.unsure, due: read.due, repeat: read.repeat, title: read.title }, { unsure: true, due: null, repeat: undefined, title: typed }, typed);
    }
  });

  it("reads a Daily, Weekly, Monthly or Yearly label at the start as it did before repeats", () => {
    const monthly = parse("Monthly: send invoices tomorrow");
    assert.deepEqual({ title: monthly.title, due: monthly.due, unsure: monthly.unsure, repeat: monthly.repeat }, { title: "Monthly: send invoices", due: "2026-11-15", unsure: false, repeat: undefined });
    assert.ok(!parse("Weekly: team update Monday 10am").repeat);
  });

  it("lights ordinary titles that only mention a date word away from the repeat", () => {
    const cases: [string, string][] = [
      ["First call every Monday", "First call"],
      ["Pay the first instalment every month", "Pay the first instalment"],
      ["Send the second draft every Friday", "Send the second draft"],
      ["Review first drafts every Friday at 3pm", "Review first drafts"],
      ["Chase last invoice weekly", "Chase last invoice"],
      ["Send the May report every month", "Send the May report"],
      ["Review pipeline every Monday and send notes", "Review pipeline and send notes"],
      ["Call Bob every Monday at 10am and email Sam", "Call Bob and email Sam"],
      ["Stand-up every day, then coffee", "Stand-up, then coffee"],
      ["Call Jane every Monday, urgent", "Call Jane, urgent"],
    ];
    for (const [typed, title] of cases) {
      const read = parse(typed);
      assert.equal(read.unsure, false, typed);
      assert.equal(read.title, title, typed);
      assert.ok(read.repeat, typed);
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

  it("never lights typed words that a repeat picked from the chip would ignore", () => {
    const daily = { rule: { freq: "daily", interval: 1 } as RepeatRule, ends: { never: true as const } };
    const friday = { rule: { freq: "weekly", interval: 1, weekdays: ["fr"] } as RepeatRule, ends: { never: true as const } };
    const shown = (typed: string) => padReading(typed, parse(typed), null, []);
    const none = { set: false, value: null };
    assert.equal(chipOverrides(shown("Call Sam every Friday"), none, daily, null), true, "a repeat typed after the pick");
    assert.equal(chipOverrides(shown("Call Sam every Friday until 18 Dec"), none, daily, null), true, "an end typed after the pick");
    assert.equal(chipOverrides(shown("Gym Tuesday"), none, friday, null), true, "a date off the picked pattern");
    assert.equal(chipOverrides(shown("Gym Friday 10am"), none, friday, null), false, "a date and time on the picked pattern stay lit");
    const typed = shown("Standup every Monday at 10am");
    assert.equal(chipOverrides(typed, none, daily, typed.repeat!), false, "the typed repeat the chip changed stays lit");
    assert.equal(chipOverrides(shown("Gym tomorrow"), { set: true, value: "2026-11-16" }, null, null), true, "a picked due date still wins over a typed one");
  });

  it("keeps a time typed after the chip changed a typed repeat", () => {
    const daily = { rule: { freq: "daily", interval: 1 } as RepeatRule, ends: { never: true as const } };
    const shown = (typed: string) => padReading(typed, parse(typed), null, []);
    const before = shown("Gym every Monday");
    const after = shown("Gym every Monday at 10am");
    assert.equal(chipOverrides(after, { set: false, value: null }, daily, before.repeat!), false);
    assert.equal(after.due, "2026-11-16T10:00");
    assert.equal(chipOverrides(shown("Gym every week at 9am"), { set: false, value: null }, daily, shown("Gym every week").repeat!), false, "a time that moves the first day");
  });

  it("drops a typed repeat when a due date off its pattern is picked", () => {
    const shown = padReading("Gym every Monday", parse("Gym every Monday"), null, []);
    assert.equal(chipOverrides(shown, { set: true, value: "2026-11-18" }, null, null), true, "Wednesday is off every Monday");
    assert.equal(chipOverrides(shown, { set: true, value: "2026-11-23" }, null, null), false, "a later Monday keeps it");
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

  it("checks the month day, interval and days against the words", async () => {
    const text = "Pay rent on the first of every month";
    const right = { phrase: "on the first of every month", every: "month" as const, monthDay: 1 };
    assert.deepEqual((await ask(text, { ...base, phrases: [], due: "2026-12-01", repeat: right }))?.repeat, { rule: { freq: "monthly", interval: 1, monthDay: 1 }, ends: { never: true } });
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-12-05", repeat: { ...right, monthDay: 5 } }), nothing(text), "another month day");
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: right.phrase, every: "month" } }), nothing(text), "no month day");
    assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-12-01", repeat: { ...right, interval: 2 } }), nothing(text), "an interval the words don't give");
    assert.deepEqual(await ask("Gym Mondays and Wednesdays", { ...base, phrases: [], due: "2026-11-16", repeat: { phrase: "Mondays", every: "week", days: ["mo"] } }), nothing("Gym Mondays and Wednesdays"), "a listed day left out");
    assert.deepEqual((await ask("Gym Mondays and Wednesdays", { ...base, phrases: [], due: "2026-11-16", repeat: { phrase: "Mondays and Wednesdays", every: "week", days: ["mo", "we"] } }))?.title, "Gym");
  });

  it("rejects a repeat that leaves its date words in the title or names a day the text doesn't", async () => {
    for (const text of ["Pay rent every month on the fifth", "Pay rent on the 1st every month", "Pay rent every month, on the 3rd"]) {
      assert.deepEqual(await ask(text, { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: "every month", every: "month" } }), nothing(text), text);
    }
    const gym = "Gym every Monday, Wednesday, and Friday";
    assert.deepEqual(parse(gym).repeat?.rule, { freq: "weekly", interval: 1, weekdays: ["mo", "we", "fr"] }, "the rules read the whole list");
    assert.deepEqual(await ask(gym, { ...base, phrases: [], due: "2026-11-16", repeat: { phrase: "every Monday, Wednesday", every: "week", days: ["mo", "we"] } }), nothing(gym));
    const phone = "Call Jane every week on the phone";
    assert.deepEqual(await ask(phone, { ...base, phrases: [], due: "2026-11-16", repeat: { phrase: "every week", every: "week", days: ["mo"] } }), nothing(phone), "an invented Monday");
    assert.deepEqual((await ask(phone, { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: "every week", every: "week" } }))?.repeat?.rule, { freq: "weekly", interval: 1, weekdays: ["sa"] });
    assert.deepEqual(await ask("Gym every 2 weeks", { ...base, phrases: [], due: "2026-11-19", repeat: { phrase: "every 2 weeks", every: "week", interval: 2, days: ["th"] } }), nothing("Gym every 2 weeks"), "an invented Thursday");
    assert.deepEqual(await ask("Gym monthly", { ...base, phrases: [], due: "2026-11-27", repeat: { phrase: "monthly", every: "month", monthWeek: { n: -1, weekday: "fr" } } }), nothing("Gym monthly"), "an invented last Friday");
  });

  it("rejects an AI repeat whose words hold more dates than it encodes", async () => {
    const reject = async (text: string, due: string, repeat: PadAiAnswer["repeat"], phrases: string[] = []) => assert.deepEqual(await ask(text, { ...base, phrases, due, repeat }), nothing(text), text);
    await reject("Pay rent every month on the first and third Monday", "2026-12-07", { phrase: "every month on the first and third Monday", every: "month", monthWeek: { n: 1, weekday: "mo" } });
    await reject("Pay rent every month on the 1st and 15th", "2026-12-01", { phrase: "every month on the 1st and 15th", every: "month", monthDay: 1 });
    await reject("Report every year on 1 Jan and 1 Jul", "2027-01-01", { phrase: "every year on 1 Jan and 1 Jul", every: "year" });
    await reject("Call every Monday and the first Friday", "2026-11-16", { phrase: "every Monday and the first Friday", every: "week", days: ["mo", "fr"] });
    await reject("Call every other Monday and every Friday", "2026-11-16", { phrase: "every other Monday and every Friday", every: "week", interval: 2, days: ["mo", "fr"] });
    await reject("Pay rent every month on the 5", "2026-11-14", { phrase: "every month", every: "month" });
    await reject("Pay rent every month on 1", "2026-11-14", { phrase: "every month", every: "month" });
    await reject("Gym every week on day 2", "2026-11-14", { phrase: "every week", every: "week" });
    await reject("Call every day next week", "2026-11-16", { phrase: "every day", every: "day" }, ["next week"]);
    await reject("Switch to paying monthly", "2026-11-14", { phrase: "monthly", every: "month" });
    for (const [text, due, repeat] of [
      ["Review Monday report every Friday", "2026-11-20", { phrase: "every Friday", every: "week", days: ["fr"] }],
      ["Call Jan every Monday", "2026-11-16", { phrase: "every Monday", every: "week", days: ["mo"] }],
    ] as const) {
      assert.ok((await ask(text, { ...base, phrases: [], due, repeat: { ...repeat, days: [...repeat.days] } }))?.repeat, text);
    }
  });

  it("takes only the first occurrence from now and keeps a stated end", async () => {
    const text = "Payroll fortnightly on Thursdays";
    const right = { phrase: "fortnightly on Thursdays", every: "week" as const, interval: 2, days: ["th"] };
    for (const due of ["2026-12-03", "2027-03-04"]) assert.deepEqual(await ask(text, { ...base, phrases: [], due, repeat: right }), nothing(text), due);
    assert.deepEqual(await ask("Stretch every day until Friday", { ...base, phrases: ["until Friday"], due: "2026-11-20", repeat: { phrase: "every day", every: "day" } }), nothing("Stretch every day until Friday"));
    assert.deepEqual(await ask("Stretch every day for 2 weeks", { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: "every day", every: "day" } }), nothing("Stretch every day for 2 weeks"));
  });

  it("never turns repeat words into a one-off date", async () => {
    assert.deepEqual(await ask("Team call every Monday", { ...base, phrases: ["every Monday"], due: "2026-11-16" }), nothing("Team call every Monday"));
    assert.deepEqual(await ask("Team call every Monday", { ...base, phrases: ["Monday"], due: "2026-11-16" }), nothing("Team call every Monday"));
    assert.deepEqual(await ask("Payroll fortnightly on Thursdays", { ...base, phrases: ["on Thursdays"], due: "2026-11-19" }), nothing("Payroll fortnightly on Thursdays"));
    for (const [text, phrase, due] of [
      ["Review every third Thursday", "Thursday", "2026-11-19"],
      ["Call Mum on Sundays", "on Sundays", "2026-11-15"],
      ["Tidy every weekday except Friday", "Friday", "2026-11-20"],
      ["Review leads twice a week from Monday", "from Monday", "2026-11-16"],
    ]) {
      assert.deepEqual(await ask(text, { ...base, phrases: [phrase], due }), nothing(text), text);
    }
  });

  it("rejects an AI repeat in a clause, after a negation or for, in a name, before an exception or on an ordinal weekday", async () => {
    const cases: [string, string, NonNullable<PadAiAnswer["repeat"]>][] = [
      ["Cancel the cleaner who comes every Friday", "2026-11-20", { phrase: "every Friday", every: "week", days: ["fr"] }],
      ["Stop paying for Netflix every month", "2026-11-14", { phrase: "every month", every: "month" }],
      ["Ask if the standup is daily", "2026-11-14", { phrase: "daily", every: "day" }],
      ["Confirm backups run daily", "2026-11-14", { phrase: "daily", every: "day" }],
      ["Quote Acme for monthly", "2026-11-14", { phrase: "monthly", every: "month" }],
      ["Email Computer Weekly", "2026-11-14", { phrase: "Weekly", every: "week" }],
      ["Don't tidy every day", "2026-11-14", { phrase: "every day", every: "day" }],
      ["Tidy every weekday except Friday", "2026-11-16", { phrase: "every weekday", every: "weekday" }],
      ["Review every third Thursday", "2026-11-19", { phrase: "every third Thursday", every: "week", interval: 3, days: ["th"] }],
      ["Check the reports that run every Monday", "2026-11-16", { phrase: "every Monday", every: "week", days: ["mo"] }],
      ["Gym every Monday, not in December", "2026-11-16", { phrase: "every Monday", every: "week", days: ["mo"] }],
    ];
    for (const [text, due, repeat] of cases) assert.deepEqual(await ask(text, { ...base, phrases: [], due, repeat }), nothing(text), text);
    assert.equal((await ask("Gym every Monday", { ...base, phrases: [], due: "2026-11-16", repeat: { phrase: "every Monday", every: "week", days: ["mo"] } }))?.title, "Gym");
  });
});

describe("AI read repeats from the review", () => {
  const ask = async (text: string, answer: PadAiAnswer) => {
    const fetchImpl: typeof fetch = async () => Response.json({ model: "test", choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }] });
    const previous = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "llm-test";
    try {
      const reading = await parsePadWithAi(text, SATURDAY_10_20, { fetchImpl });
      return reading && { due: reading.due, repeat: reading.repeat ?? null };
    } finally {
      if (previous === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previous;
    }
  };
  const base = { remindMinutes: null, durationMinutes: null };
  const monday = { phrase: "every Monday", every: "week" as const, days: ["mo"] };

  it("rejects readings the typed rules also refuse", async () => {
    const cases: [string, PadAiAnswer][] = [
      ["Check every Monday.com board", { ...base, phrases: [], due: "2026-11-16", repeat: monday }],
      ["Tell Sam I'm free every Monday", { ...base, phrases: [], due: "2026-11-16", repeat: monday }],
      ["Is gym every Monday", { ...base, phrases: [], due: "2026-11-16", repeat: monday }],
      ["Gym every Monday for 6 wks", { ...base, phrases: [], due: "2026-11-16", repeat: monday }],
      ["Gym every Monday", { ...base, phrases: [], due: "2026-11-16", repeat: { ...monday, days: ["moon"] } }],
      ["Review #weekly", { ...base, phrases: [], due: "2026-11-14", repeat: { phrase: "weekly", every: "week" } }],
      ["Pay rent monthly on Friday", { ...base, phrases: ["on Friday"], due: "2026-11-20", repeat: { phrase: "monthly", every: "month", monthDay: 20 } }],
      ["Stand-up every weekday until 13 Nov", { ...base, phrases: [], due: "2026-11-16", repeat: { phrase: "every weekday until 13 Nov", every: "weekday", ends: { on: "2027-11-13" } } }],
      ["Call Sam Monday at 10", { ...base, phrases: ["Monday at 10"], due: "2026-11-16T22:00" }],
    ];
    for (const [text, answer] of cases) assert.deepEqual(await ask(text, answer), { due: null, repeat: null }, text);
    assert.equal((await ask("Call Sam Monday at 10", { ...base, phrases: ["Monday at 10"], due: "2026-11-16T10:00" }))?.due, "2026-11-16T10:00");
    assert.equal((await ask("Drinks Monday at 10", { ...base, phrases: ["Monday at 10"], due: "2026-11-16T22:00" }))?.due, "2026-11-16T22:00");
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
    for (const typed of ["Walk the dog every day at 11pm", "Review every other Friday", "Invoice every month on the 1st", "Board pack first Monday of every month", "Birthday card every 14 Nov", "Stand-up every weekday at 08:00 until 18 Dec", "Gym every 3 days for 6 weeks"]) {
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
