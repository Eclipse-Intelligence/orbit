import { dayKey, dayKeyAt, dayParts, shiftDay, weekday } from "@/lib/crm/working-days";
import { dayStartIso, wallInstant } from "@/lib/crm/task-time";
import { appTimeZone } from "@/lib/time";
import type { TaskRepeat } from "@/lib/crm/types";

export const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const REPEAT_FREQS = ["daily", "weekly", "monthly", "yearly"] as const;
export type RepeatFreq = (typeof REPEAT_FREQS)[number];
export type MonthWeek = { n: 1 | 2 | 3 | 4 | -1; weekday: Weekday };

export type RepeatRule = {
  freq: RepeatFreq;
  interval: number;
  weekdays?: Weekday[];
  monthDay?: number;
  monthWeek?: MonthWeek;
};

export type RepeatEnds = { never: true } | { count: number; spent?: number } | { until: string };

export type RepeatPattern = {
  startsOn: string;
  at: string | null;
  rule: RepeatRule;
  ends: RepeatEnds;
};

export type OccurrenceChange = {
  occursOn: string;
  skip?: boolean;
  dueAt?: string | null;
  dueHasTime?: boolean | null;
  durationMinutes?: number | null;
  title?: string | null;
  description?: string | null;
};

export type Occurrence = {
  occursOn: string;
  day: string;
  dueAt: string;
  dueHasTime: boolean;
  durationMinutes: number | null;
  title: string | null;
  description: string | null;
  changed: boolean;
};

export const MAX_INTERVAL = 99;
export const MAX_COUNT = 999;
export const MAX_UNTIL_YEARS = 10;
export const MAX_EXPANSION = 400;
export const WORKWEEK: Weekday[] = ["mo", "tu", "we", "th", "fr"];
const LAST_YEAR = 9999;

export function occurrenceEnd(occurrence: { dueAt: string | null; dueHasTime: boolean; durationMinutes?: number | null }, timeZone = appTimeZone()) {
  if (!occurrence.dueAt) return null;
  const start = Date.parse(occurrence.dueAt);
  if (occurrence.dueHasTime) return start + Math.max(0, occurrence.durationMinutes ?? 0) * 60_000;
  return Date.parse(dayStartIso(shiftDay(dayKeyAt(new Date(start), timeZone), 1), timeZone));
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORDINAL_WORDS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  const { year, month, day } = dayParts(value);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function isClock(value: unknown): value is string {
  return typeof value === "string" && CLOCK.test(value);
}

export function weekdayIndex(day: string) {
  return (weekday(day) + 6) % 7;
}

export function weekdayOf(day: string): Weekday {
  return WEEKDAYS[weekdayIndex(day)];
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthIndex(day: string) {
  const { year, month } = dayParts(day);
  return year * 12 + (month - 1);
}

function mondayOf(day: string) {
  return shiftDay(day, -weekdayIndex(day));
}

function daysBetween(from: string, to: string) {
  const a = dayParts(from);
  const b = dayParts(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

function sortedWeekdays(days: Weekday[] | undefined) {
  return WEEKDAYS.filter((day) => days?.includes(day));
}

export function nthWeekdayOfMonth(year: number, month: number, week: MonthWeek) {
  const target = WEEKDAYS.indexOf(week.weekday);
  const last = daysInMonth(year, month);
  if (week.n === -1) {
    const lastKey = dayKey(year, month, last);
    const back = (weekdayIndex(lastKey) - target + 7) % 7;
    return dayKey(year, month, last - back);
  }
  const firstKey = dayKey(year, month, 1);
  const ahead = (target - weekdayIndex(firstKey) + 7) % 7;
  return dayKey(year, month, 1 + ahead + (week.n - 1) * 7);
}

export function monthWeekOf(day: string): MonthWeek {
  const { day: date } = dayParts(day);
  const n = Math.ceil(date / 7);
  return { n: n > 4 ? -1 : (n as 1 | 2 | 3 | 4), weekday: weekdayOf(day) };
}

export function isLastWeekOfMonth(day: string) {
  const { year, month, day: date } = dayParts(day);
  return date + 7 > daysInMonth(year, month);
}

function monthDate(year: number, month: number, rule: RepeatRule, anchor: string) {
  if (rule.monthWeek) return nthWeekdayOfMonth(year, month, rule.monthWeek);
  const wanted = rule.monthDay ?? dayParts(anchor).day;
  return dayKey(year, month, Math.min(wanted, daysInMonth(year, month)));
}

function yearDate(year: number, anchor: string) {
  const { month, day } = dayParts(anchor);
  return dayKey(year, month, Math.min(day, daysInMonth(year, month)));
}

function patternOnOrAfter(pattern: RepeatPattern, from: string): string | null {
  const { rule, startsOn } = pattern;
  const day = from < startsOn ? startsOn : from;
  if (Number(day.slice(0, 4)) >= LAST_YEAR) return null;
  const interval = Math.max(1, Math.trunc(rule.interval) || 1);
  if (rule.freq === "daily") {
    const offset = daysBetween(startsOn, day);
    return shiftDay(startsOn, Math.ceil(offset / interval) * interval);
  }
  if (rule.freq === "weekly") {
    const days = sortedWeekdays(rule.weekdays);
    if (days.length === 0) return null;
    const anchor = mondayOf(startsOn);
    let monday = mondayOf(day);
    for (let guard = 0; guard < 3; guard += 1) {
      const weeks = Math.round(daysBetween(anchor, monday) / 7);
      const behind = ((weeks % interval) + interval) % interval;
      if (behind !== 0) {
        monday = shiftDay(monday, (interval - behind) * 7);
        continue;
      }
      for (const name of days) {
        const candidate = shiftDay(monday, WEEKDAYS.indexOf(name));
        if (candidate >= day) return candidate;
      }
      monday = shiftDay(monday, interval * 7);
    }
    return null;
  }
  if (rule.freq === "monthly") {
    const start = monthIndex(startsOn);
    let index = monthIndex(day);
    const behind = (index - start) % interval;
    if (behind !== 0) index += interval - behind;
    for (let guard = 0; guard < 3; guard += 1) {
      const candidate = monthDate(Math.floor(index / 12), (index % 12) + 1, rule, startsOn);
      if (candidate >= day) return candidate;
      index += interval;
    }
    return null;
  }
  const startYear = dayParts(startsOn).year;
  let year = dayParts(day).year;
  const behind = (year - startYear) % interval;
  if (behind !== 0) year += interval - behind;
  for (let guard = 0; guard < 3; guard += 1) {
    const candidate = yearDate(year, startsOn);
    if (candidate >= day) return candidate;
    year += interval;
  }
  return null;
}

export function firstPatternDay(rule: RepeatRule, anchor: string, from = anchor) {
  return inRange(patternOnOrAfter({ startsOn: anchor, at: null, rule, ends: { never: true } }, from));
}

export function isPatternDay(pattern: RepeatPattern, day: string) {
  return patternOnOrAfter(pattern, day) === day;
}

function inRange(day: string | null) {
  return day && day.length === 10 && Number(day.slice(0, 4)) < LAST_YEAR ? day : null;
}

function rawOnOrAfter(pattern: RepeatPattern, from: string) {
  if (from <= pattern.startsOn) return pattern.startsOn;
  return inRange(patternOnOrAfter(pattern, from));
}

const lastDays = new Map<string, string | null>();

export function lastOccurrence(pattern: RepeatPattern): string | null {
  const ends = pattern.ends;
  if ("never" in ends) return null;
  if ("until" in ends) return ends.until;
  const count = Math.max(1, ends.count - (ends.spent ?? 0));
  const key = JSON.stringify([pattern.startsOn, pattern.rule, count]);
  if (lastDays.has(key)) return lastDays.get(key) ?? null;
  let day: string | null = pattern.startsOn;
  for (let index = 1; index < count && day; index += 1) day = rawOnOrAfter(pattern, shiftDay(day, 1));
  if (lastDays.size > 500) lastDays.clear();
  lastDays.set(key, day);
  return day;
}

export function occurrenceOnOrAfter(pattern: RepeatPattern, from: string): string | null {
  const day = rawOnOrAfter(pattern, from);
  if (!day) return null;
  const last = lastOccurrence(pattern);
  if ("count" in pattern.ends && last === null) return null;
  if (last !== null && day > last) return null;
  return day;
}

export function occurrenceAfter(pattern: RepeatPattern, day: string): string | null {
  return occurrenceOnOrAfter(pattern, shiftDay(day, 1));
}

export function isOccurrenceDay(pattern: RepeatPattern, day: string) {
  return occurrenceOnOrAfter(pattern, day) === day;
}

export function occurrenceDays(pattern: RepeatPattern, from: string, to: string, limit = MAX_EXPANSION) {
  const days: string[] = [];
  let day = occurrenceOnOrAfter(pattern, from);
  while (day && day <= to && days.length < limit) {
    days.push(day);
    day = occurrenceAfter(pattern, day);
  }
  return days;
}

export function occurrenceTiming(at: string | null, day: string, timeZone = appTimeZone()) {
  if (!at || !isClock(at)) return { dueAt: dayStartIso(day, timeZone), dueHasTime: false };
  const [hour, minute] = at.split(":").map(Number);
  return { dueAt: new Date(wallInstant(day, hour, minute, timeZone)).toISOString(), dueHasTime: true };
}

function changeMap(changes: OccurrenceChange[] | undefined) {
  const map = new Map<string, OccurrenceChange>();
  for (const change of changes ?? []) map.set(change.occursOn, change);
  return map;
}

export function occurrenceFor(pattern: RepeatPattern, day: string, change: OccurrenceChange | undefined, timeZone = appTimeZone()): Occurrence {
  const base = occurrenceTiming(pattern.at, day, timeZone);
  const moved = Boolean(change?.dueAt);
  const dueAt = moved ? change!.dueAt! : base.dueAt;
  return {
    occursOn: day,
    day: moved ? dayKeyAt(new Date(dueAt), timeZone) : day,
    dueAt,
    dueHasTime: moved ? Boolean(change!.dueHasTime) : base.dueHasTime,
    durationMinutes: change?.durationMinutes ?? null,
    title: change?.title ?? null,
    description: change?.description ?? null,
    changed: Boolean(change && !change.skip),
  };
}

export function nextOccurrence(pattern: RepeatPattern, changes: OccurrenceChange[] | undefined, afterDay: string, timeZone = appTimeZone()): Occurrence | null {
  const map = changeMap(changes);
  let day = occurrenceAfter(pattern, afterDay);
  for (let guard = 0; day && guard <= MAX_EXPANSION; guard += 1) {
    const change = map.get(day);
    if (!change?.skip) return occurrenceFor(pattern, day, change, timeZone);
    day = occurrenceAfter(pattern, day);
  }
  return null;
}

export function occurrencesBetween(
  pattern: RepeatPattern,
  changes: OccurrenceChange[] | undefined,
  from: string,
  to: string,
  options: { after?: string; timeZone?: string; limit?: number } = {},
): Occurrence[] {
  const timeZone = options.timeZone ?? appTimeZone();
  const map = changeMap(changes);
  const start = options.after && options.after >= from ? shiftDay(options.after, 1) : from;
  const days = new Set(occurrenceDays(pattern, start, to, options.limit ?? MAX_EXPANSION));
  for (const change of map.values()) {
    if (!change.skip && change.dueAt && change.occursOn >= (options.after ? shiftDay(options.after, 1) : change.occursOn) && isOccurrenceDay(pattern, change.occursOn)) days.add(change.occursOn);
  }
  const found: Occurrence[] = [];
  for (const day of days) {
    const change = map.get(day);
    if (change?.skip) continue;
    const occurrence = occurrenceFor(pattern, day, change, timeZone);
    if (occurrence.day >= from && occurrence.day <= to) found.push(occurrence);
  }
  return found.sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
}

export function rollThreshold(
  pattern: RepeatPattern,
  next: Pick<Occurrence, "day" | "dueAt" | "dueHasTime">,
  remindMinutes: number | null,
  currentEnd: number | null,
  timeZone = appTimeZone(),
) {
  const dayStart = Date.parse(dayStartIso(next.day, timeZone));
  const reminder = next.dueHasTime && typeof remindMinutes === "number" ? Date.parse(next.dueAt) - remindMinutes * 60_000 : dayStart;
  const earliest = Math.min(dayStart, reminder);
  return new Date(Math.max(earliest, currentEnd ?? earliest)).toISOString();
}

export function ordinal(value: number) {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const unit = value % 10;
  return `${value}${unit === 1 ? "st" : unit === 2 ? "nd" : unit === 3 ? "rd" : "th"}`;
}

function dayName(day: Weekday) {
  return DAY_NAMES[WEEKDAYS.indexOf(day)];
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function shortDay(day: string) {
  const { day: date, month } = dayParts(day);
  return `${SHORT_DAYS[weekdayIndex(day)]} ${date} ${MONTHS[month - 1]}`;
}

export function dayMonth(day: string) {
  const { day: date, month } = dayParts(day);
  return `${date} ${MONTHS[month - 1]}`;
}

export function longDay(day: string) {
  const { day: date, month, year } = dayParts(day);
  return `${date} ${MONTHS[month - 1]} ${year}`;
}

function isWorkweek(days: Weekday[]) {
  return days.length === 5 && WORKWEEK.every((day) => days.includes(day));
}

function monthPart(rule: RepeatRule, startsOn: string) {
  if (rule.monthWeek) return `the ${ORDINAL_WORDS[rule.monthWeek.n]} ${dayName(rule.monthWeek.weekday)}`;
  return `the ${ordinal(rule.monthDay ?? dayParts(startsOn).day)}`;
}

function plural(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function ruleWords(pattern: Pick<RepeatPattern, "rule" | "startsOn">) {
  const { rule, startsOn } = pattern;
  const interval = Math.max(1, rule.interval);
  if (rule.freq === "daily") return interval === 1 ? "Every day" : `Every ${plural(interval, "day")}`;
  if (rule.freq === "weekly") {
    const days = sortedWeekdays(rule.weekdays);
    const names = joinNames(days.map(dayName));
    if (interval === 1) return isWorkweek(days) ? "Every weekday" : `Every ${names}`;
    return `Every ${plural(interval, "week")} on ${names}`;
  }
  if (rule.freq === "monthly") return `${interval === 1 ? "Every month" : `Every ${plural(interval, "month")}`} on ${monthPart(rule, startsOn)}`;
  return `${interval === 1 ? "Every year" : `Every ${plural(interval, "year")}`} on ${dayMonth(startsOn)}`;
}

export function repeatChip(pattern: RepeatPattern) {
  return `${ruleWords(pattern)}${pattern.at ? ` at ${pattern.at}` : ""}`;
}

export function repeatShort(pattern: Pick<RepeatPattern, "rule" | "startsOn">) {
  const { rule } = pattern;
  const interval = Math.max(1, rule.interval);
  if (rule.freq === "daily") return interval === 1 ? "Every day" : `Every ${plural(interval, "day")}`;
  if (rule.freq === "weekly") {
    if (interval > 1) return `Every ${plural(interval, "week")}`;
    const days = sortedWeekdays(rule.weekdays);
    if (isWorkweek(days)) return "Every weekday";
    return days.length === 1 ? `Every ${dayName(days[0])}` : "Every week";
  }
  if (rule.freq === "monthly") return interval === 1 ? "Every month" : `Every ${plural(interval, "month")}`;
  return interval === 1 ? "Every year" : `Every ${plural(interval, "year")}`;
}

export function repeatPhrase(pattern: RepeatPattern) {
  const { rule, startsOn } = pattern;
  const time = pattern.at ? ` at ${pattern.at}` : "";
  if (rule.interval === 1 && rule.freq === "daily") return `Repeats daily${time}`;
  if (rule.interval === 1 && rule.freq === "monthly") return `Repeats monthly on ${monthPart(rule, startsOn)}${time}`;
  if (rule.interval === 1 && rule.freq === "yearly") return `Repeats yearly on ${dayMonth(startsOn)}${time}`;
  const words = ruleWords(pattern);
  return `Repeats ${words.charAt(0).toLowerCase()}${words.slice(1)}${time}`;
}

export function remainingCount(pattern: RepeatPattern, afterDay: string) {
  if ("never" in pattern.ends) return null;
  const last = lastOccurrence(pattern);
  if (!last || last <= afterDay) return 0;
  return occurrenceDays(pattern, shiftDay(afterDay, 1), last, MAX_COUNT + 1).length;
}

export function endWords(pattern: RepeatPattern, afterDay: string | null = null) {
  const ends = pattern.ends;
  if ("never" in ends) return "";
  if ("until" in ends) return `until ${dayMonth(ends.until)}`;
  if (afterDay) return `${remainingCount(pattern, afterDay)} more`;
  return `${ends.count} time${ends.count === 1 ? "" : "s"}`;
}

export function repeatSummary(pattern: RepeatPattern) {
  const ends = pattern.ends;
  const base = repeatChip(pattern);
  if ("never" in ends) return `${base}.`;
  if ("until" in ends) return `${base}, until ${longDay(ends.until)}.`;
  return `${base}, ${ends.count} time${ends.count === 1 ? "" : "s"}.`;
}

export type RepeatPreset = { id: string; label: string; rule: RepeatRule };

export function repeatPresets(day: string): RepeatPreset[] {
  const name = dayName(weekdayOf(day));
  const { day: date } = dayParts(day);
  const week = monthWeekOf(day);
  const presets: RepeatPreset[] = [
    { id: "daily", label: "Every day", rule: { freq: "daily", interval: 1 } },
    { id: "weekdays", label: "Every weekday", rule: { freq: "weekly", interval: 1, weekdays: [...WORKWEEK] } },
    { id: "weekly", label: `Every week on ${name}`, rule: { freq: "weekly", interval: 1, weekdays: [weekdayOf(day)] } },
    { id: "monthly-day", label: `Every month on the ${ordinal(date)}`, rule: { freq: "monthly", interval: 1, monthDay: date } },
  ];
  const monthWeek: MonthWeek = isLastWeekOfMonth(day) ? { n: -1, weekday: week.weekday } : week;
  presets.push({ id: "monthly-week", label: `Every month on the ${ORDINAL_WORDS[monthWeek.n]} ${name}`, rule: { freq: "monthly", interval: 1, monthWeek } });
  presets.push({ id: "yearly", label: `Every year on ${dayMonth(day)}`, rule: { freq: "yearly", interval: 1 } });
  return presets;
}

export function sameRule(left: RepeatRule, right: RepeatRule) {
  return JSON.stringify(normalRule(left)) === JSON.stringify(normalRule(right));
}

export function normalRule(rule: RepeatRule): RepeatRule {
  const next: RepeatRule = { freq: rule.freq, interval: Math.max(1, Math.trunc(rule.interval) || 1) };
  if (rule.freq === "weekly") next.weekdays = sortedWeekdays(rule.weekdays);
  if (rule.freq === "monthly") {
    if (rule.monthWeek) next.monthWeek = { n: rule.monthWeek.n, weekday: rule.monthWeek.weekday };
    else if (rule.monthDay) next.monthDay = rule.monthDay;
  }
  return next;
}

export function checkRule(rule: unknown): string | null {
  if (!rule || typeof rule !== "object") return "Choose how it repeats.";
  const value = rule as Partial<RepeatRule>;
  if (!REPEAT_FREQS.includes(value.freq as RepeatFreq)) return "Choose how it repeats.";
  if (!Number.isInteger(value.interval) || (value.interval as number) < 1 || (value.interval as number) > MAX_INTERVAL) {
    return `Repeat every 1 to ${MAX_INTERVAL}.`;
  }
  if (value.freq !== "weekly" && value.weekdays !== undefined) return "Days only go with a weekly repeat.";
  if (value.freq !== "monthly" && (value.monthDay !== undefined || value.monthWeek !== undefined)) return "A day of the month only goes with a monthly repeat.";
  if (value.monthDay !== undefined && value.monthWeek !== undefined) return "Choose a day of the month or a weekday, not both.";
  if (value.freq === "weekly") {
    if (!Array.isArray(value.weekdays) || value.weekdays.length === 0) return "Choose at least one day.";
    if (!value.weekdays.every((day) => WEEKDAYS.includes(day))) return "Choose at least one day.";
  }
  if (value.freq === "monthly") {
    if (value.monthWeek !== undefined) {
      const week = value.monthWeek;
      if (!week || ![1, 2, 3, 4, -1].includes(week.n) || !WEEKDAYS.includes(week.weekday)) return "Choose which week of the month.";
    } else if (value.monthDay !== undefined && (!Number.isInteger(value.monthDay) || value.monthDay < 1 || value.monthDay > 31)) {
      return "Choose a day from 1 to 31.";
    }
  }
  return null;
}

export function checkEnds(ends: unknown, startsOn: string, today: string): string | null {
  if (!ends || typeof ends !== "object") return "Choose when it ends.";
  const value = ends as Record<string, unknown>;
  if (value.never === true) return null;
  if ("count" in value) {
    return Number.isInteger(value.count) && (value.count as number) >= 1 && (value.count as number) <= MAX_COUNT ? null : `End after 1 to ${MAX_COUNT} times.`;
  }
  if ("until" in value) {
    if (!isDayKey(value.until)) return "Choose an end date.";
    if ((value.until as string) < startsOn) return "The end date is before the first one.";
    const limit = dayKey(dayParts(today).year + MAX_UNTIL_YEARS, dayParts(today).month, Math.min(dayParts(today).day, 28));
    if ((value.until as string) > limit) return `Choose an end date within ${MAX_UNTIL_YEARS} years.`;
    return null;
  }
  return "Choose when it ends.";
}

function untilInstant(day: string, timeZone: string) {
  const end = new Date(Date.parse(dayStartIso(shiftDay(day, 1), timeZone)) - 1000).toISOString();
  return `${end.slice(0, 19).replace(/[-:]/g, "")}Z`;
}

export function toRrule(pattern: RepeatPattern, timeZone = appTimeZone()) {
  const { rule } = pattern;
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === "weekly") parts.push(`BYDAY=${sortedWeekdays(rule.weekdays).map((day) => day.toUpperCase()).join(",")}`);
  if (rule.freq === "monthly") {
    if (rule.monthWeek) parts.push(`BYDAY=${rule.monthWeek.n}${rule.monthWeek.weekday.toUpperCase()}`);
    else {
      const day = rule.monthDay ?? dayParts(pattern.startsOn).day;
      parts.push(day > 28 ? `BYMONTHDAY=${day},-1;BYSETPOS=1` : `BYMONTHDAY=${day}`);
    }
  }
  if (rule.freq === "yearly") {
    const { month, day } = dayParts(pattern.startsOn);
    parts.push(`BYMONTH=${month}`, month === 2 && day === 29 ? "BYMONTHDAY=-1" : `BYMONTHDAY=${day}`);
  }
  const ends = pattern.ends;
  if ("count" in ends) parts.push(`COUNT=${ends.count}`);
  if ("until" in ends) parts.push(`UNTIL=${pattern.at ? untilInstant(ends.until, timeZone) : ends.until.replace(/-/g, "")}`);
  return `RRULE:${parts.join(";")}`;
}

export type SeriesView = {
  seriesId: string;
  ownerId?: string | null;
  creatorId?: string | null;
  startsOn: string;
  at: string | null;
  rule: RepeatRule;
  ends: RepeatEnds;
  current: boolean;
  stopped: boolean;
  occursOn: string | null;
  dueDay?: string | null;
  changes: OccurrenceChange[];
};

export function describeRepeat(view: SeriesView, timeZone = appTimeZone()): TaskRepeat {
  const pattern: RepeatPattern = { startsOn: view.startsOn, at: view.at, rule: view.rule, ends: view.ends };
  const after = view.occursOn ?? view.startsOn;
  let next = view.current && !view.stopped ? nextOccurrence(pattern, view.changes, after, timeZone) : null;
  for (let guard = 0; next && view.dueDay && next.day <= view.dueDay && guard < MAX_EXPANSION; guard += 1) next = nextOccurrence(pattern, view.changes, next.occursOn, timeZone);
  const skipped = view.changes.filter((change) => change.skip && change.occursOn > after).length;
  return {
    seriesId: view.seriesId,
    ownerId: view.ownerId ?? null,
    creatorId: view.creatorId ?? null,
    startsOn: view.startsOn,
    at: view.at,
    rule: view.rule,
    ends: view.ends,
    current: view.current,
    ended: view.stopped || (view.current && !next),
    next: next ? { occursOn: next.occursOn, dueAt: next.dueAt, dueHasTime: next.dueHasTime } : null,
    text: repeatChip(pattern),
    phrase: repeatPhrase(pattern),
    short: repeatShort(pattern),
    end: view.stopped ? "" : "count" in view.ends && view.current ? `${Math.max(0, (remainingCount(pattern, after) ?? 0) - skipped)} more` : endWords(pattern, view.current ? after : null),
    rrule: toRrule(pattern),
    changedDates: view.changes.filter((change) => change.occursOn > after && !change.skip && change.dueAt).length,
  };
}

export const REPEAT_EVERY = ["day", "weekday", "week", "month", "year"] as const;
export type RepeatEvery = (typeof REPEAT_EVERY)[number];

export type RepeatInput = {
  every: RepeatEvery;
  interval?: number;
  days?: string[];
  monthDay?: number;
  monthWeek?: { n: number; weekday: string };
  ends?: { after: number } | { on: string } | null;
};


export function repeatInputOf(rule: RepeatRule, ends: RepeatEnds): RepeatInput {
  const input: RepeatInput =
    rule.freq === "daily"
      ? { every: "day" }
      : rule.freq === "weekly"
        ? rule.interval === 1 && rule.weekdays?.length === 5 && WORKWEEK.every((day) => rule.weekdays?.includes(day))
          ? { every: "weekday" }
          : { every: "week", days: rule.weekdays ?? [] }
        : rule.freq === "monthly"
          ? rule.monthWeek
            ? { every: "month", monthWeek: rule.monthWeek }
            : { every: "month", monthDay: rule.monthDay }
          : { every: "year" };
  if (rule.interval > 1) input.interval = rule.interval;
  if ("count" in ends) input.ends = { after: ends.count };
  if ("until" in ends) input.ends = { on: ends.until };
  return input;
}

