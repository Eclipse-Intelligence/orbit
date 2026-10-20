import { parseTimeValue, type IcsTime, type Wall } from "@/lib/ical/parse";
import { zonedTimeToDate } from "@/lib/time";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const UNSUPPORTED = new Set(["BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND"]);
const MAX_PERIODS = 200_000;

type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
type ByDay = { weekday: number; ordinal: number };

type Rule = {
  freq: Frequency;
  interval: number;
  count: number | null;
  until: IcsTime | null;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  weekStart: number;
};

function integers(value: string | undefined, min: number, max: number, allowNegative: boolean) {
  if (!value) return [];
  const numbers: number[] = [];
  for (const part of value.split(",")) {
    if (!/^[+-]?\d+$/.test(part.trim())) return null;
    const number = Number(part);
    const size = Math.abs(number);
    if (size < min || size > max || (!allowNegative && number < 0)) return null;
    numbers.push(number);
  }
  return numbers;
}

export function parseRule(value: string, start: IcsTime): Rule | null {
  const parts = new Map<string, string>();
  for (const piece of value.split(";")) {
    const [key, raw] = piece.split("=");
    if (key && raw !== undefined) parts.set(key.trim().toUpperCase(), raw.trim().toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  for (const key of parts.keys()) if (UNSUPPORTED.has(key)) return null;
  const interval = Number(parts.get("INTERVAL") ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return null;
  const countText = parts.get("COUNT");
  const count = countText === undefined ? null : Number(countText);
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  let until: IcsTime | null = null;
  const untilText = parts.get("UNTIL");
  if (untilText) {
    until = parseTimeValue(untilText, { fallbackZone: start.zone });
    if (!until) return null;
  }
  const byDay: ByDay[] = [];
  for (const part of parts.get("BYDAY")?.split(",") ?? []) {
    const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(part.trim());
    if (!match) return null;
    const ordinal = match[1] ? Number(match[1]) : 0;
    if (Math.abs(ordinal) > 53) return null;
    byDay.push({ weekday: WEEKDAYS.indexOf(match[2]), ordinal });
  }
  const byMonthDay = integers(parts.get("BYMONTHDAY"), 1, 31, true);
  const byMonth = integers(parts.get("BYMONTH"), 1, 12, false);
  const bySetPos = integers(parts.get("BYSETPOS"), 1, 366, true);
  if (!byMonthDay || !byMonth || !bySetPos) return null;
  const weekStart = WEEKDAYS.indexOf(parts.get("WKST") ?? "MO");
  return {
    freq,
    interval,
    count,
    until,
    byDay,
    byMonthDay,
    byMonth,
    bySetPos,
    weekStart: weekStart < 0 ? 0 : weekStart,
  };
}

function dayNumber(year: number, month: number, day: number) {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function fromDayNumber(value: number) {
  const date = new Date(value * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekday(value: number) {
  return (new Date(value * DAY_MS).getUTCDay() + 6) % 7;
}

function monthLength(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pick<T>(sorted: T[], positions: number[]) {
  if (positions.length === 0) return sorted;
  const chosen = new Set<T>();
  for (const position of positions) {
    const item = position > 0 ? sorted[position - 1] : sorted[sorted.length + position];
    if (item !== undefined) chosen.add(item);
  }
  return sorted.filter((item) => chosen.has(item));
}

function nth(days: number[], ordinal: number) {
  if (ordinal === 0) return days;
  const item = ordinal > 0 ? days[ordinal - 1] : days[days.length + ordinal];
  return item === undefined ? [] : [item];
}

function daysInMonth(year: number, month: number, rule: Rule, defaultDay: number) {
  const length = monthLength(year, month);
  const firstDay = dayNumber(year, month, 1);
  let result: Set<number> | null = null;
  if (rule.byMonthDay.length > 0) {
    result = new Set(
      rule.byMonthDay
        .map((value) => (value > 0 ? value : length + value + 1))
        .filter((value) => value >= 1 && value <= length)
        .map((value) => firstDay + value - 1),
    );
  }
  if (rule.byDay.length > 0) {
    const matched = new Set<number>();
    for (const entry of rule.byDay) {
      const days: number[] = [];
      for (let offset = 0; offset < length; offset += 1) {
        if (weekday(firstDay + offset) === entry.weekday) days.push(firstDay + offset);
      }
      for (const day of nth(days, entry.ordinal)) matched.add(day);
    }
    result = result ? new Set([...result].filter((day) => matched.has(day))) : matched;
  }
  if (!result) return defaultDay <= length ? [firstDay + defaultDay - 1] : [];
  return [...result].sort((left, right) => left - right);
}

function daysInYear(year: number, rule: Rule, start: { month: number; day: number }) {
  if (rule.byMonth.length > 0) {
    return [...rule.byMonth]
      .sort((left, right) => left - right)
      .flatMap((month) => daysInMonth(year, month, rule, start.day));
  }
  if (rule.byMonthDay.length > 0) {
    return Array.from({ length: 12 }, (_, index) => daysInMonth(year, index + 1, rule, start.day)).flat();
  }
  if (rule.byDay.length > 0) {
    const firstDay = dayNumber(year, 1, 1);
    const length = dayNumber(year + 1, 1, 1) - firstDay;
    const matched = new Set<number>();
    for (const entry of rule.byDay) {
      const days: number[] = [];
      for (let offset = 0; offset < length; offset += 1) {
        if (weekday(firstDay + offset) === entry.weekday) days.push(firstDay + offset);
      }
      for (const day of nth(days, entry.ordinal)) matched.add(day);
    }
    return [...matched].sort((left, right) => left - right);
  }
  return start.day <= monthLength(year, start.month) ? [dayNumber(year, start.month, start.day)] : [];
}

function dailyMatch(day: number, rule: Rule) {
  const { year, month, day: date } = fromDayNumber(day);
  if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) return false;
  if (rule.byMonthDay.length > 0) {
    const length = monthLength(year, month);
    if (!rule.byMonthDay.some((value) => (value > 0 ? value : length + value + 1) === date)) return false;
  }
  if (rule.byDay.length > 0 && !rule.byDay.some((entry) => entry.weekday === weekday(day))) return false;
  return true;
}

function* ruleDays(rule: Rule, start: Wall, lastDay: number): Generator<number> {
  const startDay = dayNumber(start.year, start.month, start.day);
  for (let period = 0; period < MAX_PERIODS; period += 1) {
    let days: number[];
    let periodStart: number;
    if (rule.freq === "DAILY") {
      periodStart = startDay + period * rule.interval;
      days = dailyMatch(periodStart, rule) ? [periodStart] : [];
    } else if (rule.freq === "WEEKLY") {
      const weekBegin = startDay - ((weekday(startDay) - rule.weekStart + 7) % 7);
      periodStart = weekBegin + period * 7 * rule.interval;
      const weekdays = rule.byDay.length > 0 ? rule.byDay.map((entry) => entry.weekday) : [weekday(startDay)];
      days = [...new Set(weekdays.map((value) => periodStart + ((value - rule.weekStart + 7) % 7)))]
        .filter((day) => rule.byMonth.length === 0 || rule.byMonth.includes(fromDayNumber(day).month))
        .sort((left, right) => left - right);
      days = pick(days, rule.bySetPos);
    } else if (rule.freq === "MONTHLY") {
      const index = start.year * 12 + (start.month - 1) + period * rule.interval;
      const year = Math.floor(index / 12);
      const month = (index % 12) + 1;
      periodStart = dayNumber(year, month, 1);
      days =
        rule.byMonth.length > 0 && !rule.byMonth.includes(month)
          ? []
          : pick(daysInMonth(year, month, rule, start.day), rule.bySetPos);
    } else {
      const year = start.year + period * rule.interval;
      periodStart = dayNumber(year, 1, 1);
      days = pick(daysInYear(year, rule, start), rule.bySetPos);
    }
    if (periodStart > lastDay) return;
    for (const day of days) {
      if (day < startDay) continue;
      if (day > lastDay) return;
      yield day;
    }
  }
}

export function instantOf(time: IcsTime) {
  if (time.allDay) return Date.UTC(time.wall.year, time.wall.month - 1, time.wall.day);
  return zonedTimeToDate(time.wall, time.zone).getTime();
}

function untilInstant(until: IcsTime, start: IcsTime) {
  if (!until.allDay || start.allDay) return instantOf(until);
  const next = fromDayNumber(dayNumber(until.wall.year, until.wall.month, until.wall.day) + 1);
  return zonedTimeToDate({ ...next, hour: 0, minute: 0, second: 0 }, start.zone).getTime() - 1;
}

export function expandStarts(
  rule: Rule,
  start: IcsTime,
  window: { start: number; end: number },
  durationMs: number,
  limit: number,
): { starts: IcsTime[]; truncated: boolean } {
  const starts: IcsTime[] = [];
  const startDay = dayNumber(start.wall.year, start.wall.month, start.wall.day);
  const lastDay = Math.floor(window.end / DAY_MS) + 2;
  const skipBefore = Math.floor((window.start - Math.max(durationMs, 0)) / DAY_MS) - 2;
  const until = rule.until ? untilInstant(rule.until, start) : null;
  const first = instantOf(start);
  if (first < window.end && first + durationMs > window.start) starts.push(start);
  let produced = 1;
  for (const day of ruleDays(rule, start.wall, lastDay)) {
    if (day === startDay) continue;
    if (rule.count !== null && produced >= rule.count) break;
    produced += 1;
    if (day < skipBefore) continue;
    const time: IcsTime = { allDay: start.allDay, zone: start.zone, wall: { ...start.wall, ...fromDayNumber(day) } };
    const at = instantOf(time);
    if (until !== null && at > until) break;
    if (at >= window.end) break;
    if (at + durationMs <= window.start) continue;
    starts.push(time);
    if (starts.length >= limit) return { starts, truncated: true };
  }
  return { starts, truncated: false };
}
