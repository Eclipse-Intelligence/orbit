import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkEnds,
  checkRule,
  endWords,
  isOccurrenceDay,
  lastOccurrence,
  nextOccurrence,
  occurrenceAfter,
  occurrenceDays,
  occurrenceEnd,
  occurrenceOnOrAfter,
  occurrencesBetween,
  occurrenceTiming,
  remainingCount,
  repeatChip,
  repeatPhrase,
  repeatPresets,
  repeatShort,
  repeatSummary,
  rollThreshold,
  toRrule,
  type RepeatPattern,
  type RepeatRule,
} from "@/lib/task-repeat";

const LONDON = "Europe/London";

function pattern(rule: RepeatRule, startsOn: string, extra: Partial<RepeatPattern> = {}): RepeatPattern {
  return { startsOn, at: null, rule, ends: { never: true }, ...extra };
}

describe("repeat patterns", () => {
  it("walks every day and every few days from the start", () => {
    assert.deepEqual(occurrenceDays(pattern({ freq: "daily", interval: 1 }, "2026-11-14"), "2026-11-10", "2026-11-17"), ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"]);
    assert.deepEqual(occurrenceDays(pattern({ freq: "daily", interval: 3 }, "2026-11-14"), "2026-11-15", "2026-11-24"), ["2026-11-17", "2026-11-20", "2026-11-23"]);
    assert.deepEqual(occurrenceDays(pattern({ freq: "daily", interval: 1 }, "2026-12-30"), "2026-12-30", "2027-01-02"), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("keeps every weekday to Monday to Friday, bank holidays included", () => {
    const weekdays = pattern({ freq: "weekly", interval: 1, weekdays: ["mo", "tu", "we", "th", "fr"] }, "2026-12-24");
    assert.deepEqual(occurrenceDays(weekdays, "2026-12-24", "2027-01-01"), ["2026-12-24", "2026-12-25", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01"]);
  });

  it("repeats on chosen days of the week, every few weeks anchored on the first week", () => {
    const twice = pattern({ freq: "weekly", interval: 1, weekdays: ["th", "mo"] }, "2026-11-16");
    assert.deepEqual(occurrenceDays(twice, "2026-11-16", "2026-11-30"), ["2026-11-16", "2026-11-19", "2026-11-23", "2026-11-26", "2026-11-30"]);
    const fortnightly = pattern({ freq: "weekly", interval: 2, weekdays: ["fr"] }, "2026-11-20");
    assert.deepEqual(occurrenceDays(fortnightly, "2026-11-14", "2026-12-31"), ["2026-11-20", "2026-12-04", "2026-12-18"]);
    assert.equal(occurrenceOnOrAfter(fortnightly, "2026-11-21"), "2026-12-04");
    assert.equal(occurrenceOnOrAfter(fortnightly, "2026-11-27"), "2026-12-04");
    const fromMidWeek = pattern({ freq: "weekly", interval: 2, weekdays: ["mo", "th"] }, "2026-11-19");
    assert.deepEqual(occurrenceDays(fromMidWeek, "2026-11-19", "2026-12-10"), ["2026-11-19", "2026-11-30", "2026-12-03"]);
  });

  it("repeats on a day of the month, using the last day in shorter months", () => {
    const thirtyFirst = pattern({ freq: "monthly", interval: 1, monthDay: 31 }, "2027-01-31");
    assert.deepEqual(occurrenceDays(thirtyFirst, "2027-01-01", "2027-06-30"), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31", "2027-06-30"]);
    const thirtieth = pattern({ freq: "monthly", interval: 1, monthDay: 30 }, "2027-12-30");
    assert.deepEqual(occurrenceDays(thirtieth, "2027-12-01", "2028-03-31"), ["2027-12-30", "2028-01-30", "2028-02-29", "2028-03-30"]);
    const twentyNinth = pattern({ freq: "monthly", interval: 1, monthDay: 29 }, "2027-01-29");
    assert.deepEqual(occurrenceDays(twentyNinth, "2027-01-01", "2027-03-31"), ["2027-01-29", "2027-02-28", "2027-03-29"]);
    const quarterly = pattern({ freq: "monthly", interval: 3, monthDay: 1 }, "2026-12-01");
    assert.deepEqual(occurrenceDays(quarterly, "2026-11-14", "2027-12-31"), ["2026-12-01", "2027-03-01", "2027-06-01", "2027-09-01", "2027-12-01"]);
  });

  it("repeats on the nth or last weekday of the month", () => {
    const secondSaturday = pattern({ freq: "monthly", interval: 1, monthWeek: { n: 2, weekday: "sa" } }, "2026-11-14");
    assert.deepEqual(occurrenceDays(secondSaturday, "2026-11-14", "2027-02-28"), ["2026-11-14", "2026-12-12", "2027-01-09", "2027-02-13"]);
    const lastFriday = pattern({ freq: "monthly", interval: 1, monthWeek: { n: -1, weekday: "fr" } }, "2026-11-27");
    assert.deepEqual(occurrenceDays(lastFriday, "2026-11-01", "2027-03-31"), ["2026-11-27", "2026-12-25", "2027-01-29", "2027-02-26", "2027-03-26"]);
    const firstMonday = pattern({ freq: "monthly", interval: 1, monthWeek: { n: 1, weekday: "mo" } }, "2026-12-07");
    assert.deepEqual(occurrenceDays(firstMonday, "2026-12-01", "2027-03-31"), ["2026-12-07", "2027-01-04", "2027-02-01", "2027-03-01"]);
    const fourthFriday = pattern({ freq: "monthly", interval: 1, monthWeek: { n: 4, weekday: "fr" } }, "2026-11-27");
    assert.deepEqual(occurrenceDays(fourthFriday, "2026-11-01", "2027-01-31"), ["2026-11-27", "2026-12-25", "2027-01-22"]);
  });

  it("repeats every year, on 28 February outside leap years for 29 February", () => {
    const leap = pattern({ freq: "yearly", interval: 1 }, "2028-02-29");
    assert.deepEqual(occurrenceDays(leap, "2028-01-01", "2033-12-31"), ["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29", "2033-02-28"]);
    const birthday = pattern({ freq: "yearly", interval: 2 }, "2026-11-14");
    assert.deepEqual(occurrenceDays(birthday, "2026-01-01", "2031-12-31"), ["2026-11-14", "2028-11-14", "2030-11-14"]);
  });

  it("counts the first occurrence even when it is off the pattern", () => {
    const saturdayStart = pattern({ freq: "weekly", interval: 1, weekdays: ["mo", "tu", "we", "th", "fr"] }, "2026-11-14");
    assert.deepEqual(occurrenceDays(saturdayStart, "2026-11-14", "2026-11-17"), ["2026-11-14", "2026-11-16", "2026-11-17"]);
    assert.equal(isOccurrenceDay(saturdayStart, "2026-11-15"), false);
  });
});

describe("repeat ends", () => {
  it("stops after a number of times counted from the start", () => {
    const tenTimes = pattern({ freq: "weekly", interval: 2, weekdays: ["mo", "th"] }, "2026-11-16", { ends: { count: 5 } });
    assert.deepEqual(occurrenceDays(tenTimes, "2026-11-01", "2027-12-31"), ["2026-11-16", "2026-11-19", "2026-11-30", "2026-12-03", "2026-12-14"]);
    assert.equal(lastOccurrence(tenTimes), "2026-12-14");
    assert.equal(occurrenceAfter(tenTimes, "2026-12-14"), null);
    assert.equal(remainingCount(tenTimes, "2026-11-19"), 3);
    assert.equal(endWords(tenTimes, "2026-11-19"), "3 more");
    const once = pattern({ freq: "daily", interval: 1 }, "2026-11-14", { ends: { count: 1 } });
    assert.deepEqual(occurrenceDays(once, "2026-11-01", "2026-12-31"), ["2026-11-14"]);
  });

  it("stops after an end date, including that day", () => {
    const until = pattern({ freq: "weekly", interval: 1, weekdays: ["tu"] }, "2026-11-17", { ends: { until: "2026-12-15" } });
    assert.deepEqual(occurrenceDays(until, "2026-11-01", "2027-12-31"), ["2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15"]);
    assert.equal(remainingCount(until, "2026-11-17"), 4);
    assert.equal(endWords(until, null, "2026-11-14"), "until 15 Dec");
    assert.equal(endWords(until, null, "2025-11-14"), "until 15 Dec 2026");
  });

  it("checks rules and ends with messages people can act on", () => {
    assert.equal(checkRule({ freq: "weekly", interval: 1, weekdays: [] }), "Choose at least one day.");
    assert.equal(checkRule({ freq: "daily", interval: 0 }), "Repeat every 1 to 99.");
    assert.equal(checkRule({ freq: "daily", interval: 100 }), "Repeat every 1 to 99.");
    assert.equal(checkRule({ freq: "monthly", interval: 1, monthDay: 32 }), "Choose a day from 1 to 31.");
    assert.equal(checkRule({ freq: "monthly", interval: 1, monthWeek: { n: 5, weekday: "mo" } }), "Choose which week of the month.");
    assert.equal(checkRule({ freq: "hourly", interval: 1 }), "Choose how it repeats.");
    assert.equal(checkRule({ freq: "daily", interval: 1, weekdays: ["mo"] }), "Days only go with a weekly repeat.");
    assert.equal(checkRule({ freq: "monthly", interval: 1, monthDay: 3, monthWeek: { n: 1, weekday: "mo" } }), "Choose a day of the month or a weekday, not both.");
    assert.equal(occurrenceOnOrAfter(pattern({ freq: "yearly", interval: 1 }, "9998-06-01"), "9998-06-02"), null);
    assert.equal(checkRule({ freq: "monthly", interval: 1, monthWeek: { n: -1, weekday: "fr" } }), null);
    assert.equal(checkEnds({ until: "2026-11-01" }, "2026-11-14", "2026-11-14"), "The end date is before the first one.");
    assert.equal(checkEnds({ until: "2037-11-14" }, "2026-11-14", "2026-11-14"), "Choose an end date within 10 years.");
    assert.equal(checkEnds({ count: 0 }, "2026-11-14", "2026-11-14"), "End after 1 to 999 times.");
    assert.equal(checkEnds({ count: 1000 }, "2026-11-14", "2026-11-14"), "End after 1 to 999 times.");
    assert.equal(checkEnds({ never: true }, "2026-11-14", "2026-11-14"), null);
    assert.equal(checkEnds({ until: "2027-02-30" }, "2026-11-14", "2026-11-14"), "Choose an end date.");
  });
});

describe("repeat times across the clock changes", () => {
  it("keeps 14:00 London time on both sides of each change", () => {
    const daily = pattern({ freq: "daily", interval: 1 }, "2027-03-27", { at: "14:00" });
    const spring = occurrencesBetween(daily, [], "2027-03-27", "2027-03-29", { timeZone: LONDON });
    assert.deepEqual(spring.map((item) => item.dueAt), ["2027-03-27T14:00:00.000Z", "2027-03-28T13:00:00.000Z", "2027-03-29T13:00:00.000Z"]);
    const autumn = occurrencesBetween({ ...daily, startsOn: "2027-10-30" }, [], "2027-10-30", "2027-11-01", { timeZone: LONDON });
    assert.deepEqual(autumn.map((item) => item.dueAt), ["2027-10-30T13:00:00.000Z", "2027-10-31T14:00:00.000Z", "2027-11-01T14:00:00.000Z"]);
  });

  it("moves a time in the missing hour to the hour after, and takes the first of a repeated hour", () => {
    assert.equal(occurrenceTiming("01:30", "2027-03-28", LONDON).dueAt, "2027-03-28T01:30:00.000Z");
    assert.equal(occurrenceTiming("01:30", "2027-03-27", LONDON).dueAt, "2027-03-27T01:30:00.000Z");
    assert.equal(occurrenceTiming("01:30", "2027-10-31", LONDON).dueAt, "2027-10-31T00:30:00.000Z");
    assert.equal(occurrenceTiming("01:30", "2027-11-01", LONDON).dueAt, "2027-11-01T01:30:00.000Z");
  });

  it("stores London midnight for date-only occurrences", () => {
    assert.deepEqual(occurrenceTiming(null, "2027-03-28", LONDON), { dueAt: "2027-03-28T00:00:00.000Z", dueHasTime: false });
    assert.deepEqual(occurrenceTiming(null, "2027-07-01", LONDON), { dueAt: "2027-06-30T23:00:00.000Z", dueHasTime: false });
  });
});

describe("occurrence changes", () => {
  const walk = pattern({ freq: "daily", interval: 1 }, "2026-11-16", { at: "14:00" });

  it("skips a skipped date and moves a moved one", () => {
    const changes = [
      { occursOn: "2026-11-18", skip: true },
      { occursOn: "2026-11-19", dueAt: "2026-11-19T15:30:00.000Z", dueHasTime: true, durationMinutes: 30 },
    ];
    const found = occurrencesBetween(walk, changes, "2026-11-17", "2026-11-20", { timeZone: LONDON });
    assert.deepEqual(
      found.map((item) => [item.occursOn, item.dueAt, item.changed]),
      [
        ["2026-11-17", "2026-11-17T14:00:00.000Z", false],
        ["2026-11-19", "2026-11-19T15:30:00.000Z", true],
        ["2026-11-20", "2026-11-20T14:00:00.000Z", false],
      ],
    );
    assert.equal(found[1].durationMinutes, 30);
    assert.equal(nextOccurrence(walk, changes, "2026-11-17", LONDON)?.occursOn, "2026-11-19");
  });

  it("shows an occurrence moved into the range from outside it", () => {
    const changes = [{ occursOn: "2026-11-21", dueAt: "2026-11-19T09:00:00.000Z", dueHasTime: true }];
    const found = occurrencesBetween(walk, changes, "2026-11-19", "2026-11-19", { timeZone: LONDON });
    assert.deepEqual(found.map((item) => item.occursOn), ["2026-11-21", "2026-11-19"]);
  });

  it("returns nothing after the last one", () => {
    const ending = { ...walk, ends: { until: "2026-11-17" } } as RepeatPattern;
    assert.equal(nextOccurrence(ending, [], "2026-11-17", LONDON), null);
    assert.equal(nextOccurrence(ending, [{ occursOn: "2026-11-17", skip: true }], "2026-11-16", LONDON), null);
  });
});

describe("rolling a missed occurrence", () => {
  it("rolls at the start of the next day, or the next reminder when earlier", () => {
    const daily = pattern({ freq: "daily", interval: 1 }, "2026-11-16", { at: "09:00" });
    const next = nextOccurrence(daily, [], "2026-11-16", LONDON)!;
    const currentEnd = occurrenceEnd({ dueAt: "2026-11-16T09:00:00.000Z", dueHasTime: true, durationMinutes: 15 }, LONDON);
    assert.equal(rollThreshold(daily, next, null, currentEnd, LONDON), "2026-11-17T00:00:00.000Z");
    for (const remind of [1440, 2880, 10080]) assert.equal(rollThreshold(daily, next, remind, currentEnd, LONDON), "2026-11-16T09:15:00.000Z");
    assert.equal(occurrenceEnd({ dueAt: "2026-11-16T00:00:00.000Z", dueHasTime: false }, LONDON), Date.parse("2026-11-17T00:00:00.000Z"));
    const weekly = pattern({ freq: "weekly", interval: 1, weekdays: ["tu"] }, "2026-11-17", { at: "14:00" });
    const tuesday = nextOccurrence(weekly, [], "2026-11-17", LONDON)!;
    assert.equal(rollThreshold(weekly, tuesday, 60, Date.parse("2026-11-17T14:15:00Z"), LONDON), "2026-11-24T00:00:00.000Z");
    assert.equal(rollThreshold(weekly, tuesday, 1440, Date.parse("2026-11-17T14:15:00Z"), LONDON), "2026-11-23T14:00:00.000Z");
  });

  it("waits for a task moved past the next date", () => {
    const daily = pattern({ freq: "daily", interval: 1 }, "2026-11-16");
    const next = nextOccurrence(daily, [], "2026-11-16", LONDON)!;
    assert.equal(rollThreshold(daily, next, null, Date.parse("2026-11-19T00:00:00Z"), LONDON), "2026-11-19T00:00:00.000Z");
  });
});

describe("repeat words", () => {
  it("says the rule in the forms the mockups use", () => {
    const walk = pattern({ freq: "daily", interval: 1 }, "2026-11-14", { at: "14:00" });
    assert.equal(repeatPhrase(walk), "Repeats daily at 14:00");
    assert.equal(repeatChip(walk), "Every day at 14:00");
    assert.equal(repeatShort(walk), "Every day");
    const call = pattern({ freq: "weekly", interval: 1, weekdays: ["tu"] }, "2026-11-17", { at: "14:00" });
    assert.equal(repeatPhrase(call), "Repeats every Tuesday at 14:00");
    assert.equal(repeatChip(call), "Every Tuesday at 14:00");
    assert.equal(repeatShort(call), "Every Tuesday");
    const review = pattern({ freq: "weekly", interval: 2, weekdays: ["fr"] }, "2026-11-20");
    assert.equal(repeatPhrase(review), "Repeats every 2 weeks on Friday");
    assert.equal(repeatShort(review), "Every 2 weeks");
    const invoice = pattern({ freq: "monthly", interval: 1, monthDay: 1 }, "2026-12-01");
    assert.equal(repeatPhrase(invoice), "Repeats monthly on the 1st");
    const standup = pattern({ freq: "weekly", interval: 1, weekdays: ["mo", "tu", "we", "th", "fr"] }, "2026-11-16", { at: "09:30" });
    assert.equal(repeatPhrase(standup), "Repeats every weekday at 09:30");
    const custom = pattern({ freq: "weekly", interval: 2, weekdays: ["th", "mo"] }, "2026-11-16", { at: "14:00", ends: { count: 10 } });
    assert.equal(repeatSummary(custom), "Every 2 weeks on Monday and Thursday at 14:00, 10 times.");
    const report = pattern({ freq: "monthly", interval: 1, monthWeek: { n: 4, weekday: "fr" } }, "2026-11-27", { at: "11:00", ends: { until: "2027-03-31" } });
    assert.equal(repeatSummary(report), "Every month on the fourth Friday at 11:00, until 31 Mar 2027.");
    assert.equal(repeatPhrase(pattern({ freq: "yearly", interval: 1 }, "2026-11-14")), "Repeats yearly on 14 Nov");
    assert.equal(repeatChip(pattern({ freq: "monthly", interval: 1, monthWeek: { n: -1, weekday: "fr" } }, "2026-11-27")), "Every month on the last Friday");
  });

  it("offers menu choices worked out from the due date", () => {
    assert.deepEqual(
      repeatPresets("2026-11-14").map((preset) => preset.label),
      ["Every day", "Every weekday", "Every week on Saturday", "Every month on the 14th", "Every month on the second Saturday", "Every year on 14 Nov"],
    );
    assert.deepEqual(repeatPresets("2026-11-27").map((preset) => preset.label).slice(3, 6), ["Every month on the 27th", "Every month on the fourth Friday", "Every month on the last Friday"]);
    assert.deepEqual(repeatPresets("2026-11-27")[5].rule, { freq: "monthly", interval: 1, monthWeek: { n: -1, weekday: "fr" } });
    assert.deepEqual(repeatPresets("2026-11-27")[4].rule, { freq: "monthly", interval: 1, monthWeek: { n: 4, weekday: "fr" } });
    assert.equal(repeatPresets("2026-11-30").find((preset) => preset.id === "monthly-fourth"), undefined);
  });

  it("writes an RRULE for outside calendars", () => {
    assert.equal(toRrule(pattern({ freq: "weekly", interval: 2, weekdays: ["th", "mo"] }, "2026-11-16", { ends: { count: 10 } })), "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10");
    assert.equal(toRrule(pattern({ freq: "monthly", interval: 1, monthWeek: { n: -1, weekday: "fr" } }, "2026-11-27", { ends: { until: "2027-03-31" } })), "RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20270331");
    assert.equal(toRrule(pattern({ freq: "monthly", interval: 1, monthDay: 31 }, "2027-01-31")), "RRULE:FREQ=MONTHLY;BYMONTHDAY=31,-1;BYSETPOS=1");
    assert.equal(toRrule(pattern({ freq: "yearly", interval: 1 }, "2026-11-14")), "RRULE:FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=14");
    assert.equal(toRrule(pattern({ freq: "yearly", interval: 1 }, "2028-02-29")), "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1");
    assert.equal(toRrule(pattern({ freq: "daily", interval: 1 }, "2027-03-01", { at: "14:00", ends: { until: "2027-07-01" } }), LONDON), "RRULE:FREQ=DAILY;UNTIL=20270701T225959Z");
  });
});
