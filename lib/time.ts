const DEFAULT_TIME_ZONE = "Europe/London";

const DAY_MS = 86_400_000;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function partsFormatter(timeZone: string) {
  if (!formatters.has(timeZone)) {
    try {
      formatters.set(
        timeZone,
        new Intl.DateTimeFormat("en-US", {
          timeZone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    } catch {
      formatters.set(timeZone, null);
    }
  }
  return formatters.get(timeZone) ?? null;
}

export function isTimeZone(value: string | null | undefined): value is string {
  return Boolean(value && partsFormatter(value));
}

export function appTimeZone() {
  const configured = process.env.NEXT_PUBLIC_TIMEZONE?.trim();
  return isTimeZone(configured) ? configured : DEFAULT_TIME_ZONE;
}

export function zoneLabel(timeZone = appTimeZone()) {
  return timeZone === "Europe/London" ? "London" : timeZone;
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function zonedParts(date: Date, timeZone = appTimeZone()): WallClock {
  const formatter = partsFormatter(timeZone) ?? partsFormatter(DEFAULT_TIME_ZONE)!;
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function offsetAt(timestamp: number, timeZone: string) {
  const seconds = Math.floor(timestamp / 1000) * 1000;
  const parts = zonedParts(new Date(seconds), timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - seconds;
}

export function zonedTimeToDate(wall: WallClock, timeZone = appTimeZone()) {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const first = offsetAt(guess, timeZone);
  const candidate = guess - first;
  const second = offsetAt(candidate, timeZone);
  if (first === second) return new Date(candidate);
  const retry = guess - second;
  if (offsetAt(retry, timeZone) === second) return new Date(retry);
  return new Date(guess - Math.min(first, second));
}

const ZONED_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)$/i;
const DAY_FIRST = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{2,4})(?:(?:\s*,\s*|\s+|T)(?:at\s+)?(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?$/i;
const YEAR_FIRST = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const WEEKDAY_PREFIX = "(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\\.?,?\\s+)?";
const NAMED_TIME = "(?:(?:\\s*,\\s*|\\s+)(?:at\\s+)?(\\d{1,2})(?:[:.](\\d{2})(?::(\\d{2}))?)?\\s*(am|pm)?)?";
const DAY_MONTH_NAME = new RegExp(`^${WEEKDAY_PREFIX}(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+([a-z]+)\\.?,?\\s+(\\d{2,4})${NAMED_TIME}$`, "i");
const MONTH_NAME_DAY = new RegExp(`^${WEEKDAY_PREFIX}([a-z]+)\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{2,4})${NAMED_TIME}$`, "i");
const ZONE_SUFFIX = /\s+(?:(?:GMT|UTC)?([+-])(\d{2}):?(\d{2})|([a-z]{1,4}))(?:\s*\([^)]*\))?$/i;
const ZONE_OFFSETS: Record<string, number> = {
  Z: 0,
  UT: 0,
  UTC: 0,
  GMT: 0,
  BST: 60,
  CET: 60,
  CEST: 120,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const FORMAT_HINT = "Enter a valid date and time, such as 2026-11-07 14:30, 07/11/2026 or 7 Nov 2026.";

export type DateTimeReading = { ok: true; date: Date; dateOnly: boolean } | { ok: false; error: string };

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number; dateOnly: boolean };

function monthNumber(word: string) {
  const key = word.toLowerCase();
  if (key.length < 3) return 0;
  return MONTH_NAMES.findIndex((name) => name.startsWith(key)) + 1;
}

function wallFrom(year: string, month: number, day: string, hour?: string, minute?: string, second?: string): Wall | string {
  if (year.length !== 4) return "Write the year in full, such as 2026.";
  return {
    year: Number(year),
    month,
    day: Number(day),
    hour: Number(hour ?? 0),
    minute: Number(minute ?? 0),
    second: Number(second ?? 0),
    dateOnly: hour === undefined,
  };
}

function namedWall(year: string, month: number, day: string, hour?: string, minute?: string, second?: string, meridiem?: string): Wall | string | null {
  if (hour === undefined) return wallFrom(year, month, day);
  if (minute === undefined && meridiem === undefined) return null;
  let clock = Number(hour);
  if (meridiem) {
    if (clock < 1 || clock > 12) return null;
    clock = (clock % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  return wallFrom(year, month, day, String(clock), minute ?? "0", second);
}

function readWall(text: string): Wall | string | null {
  const local = LOCAL_DATE_TIME.exec(text);
  if (local) return wallFrom(local[1], Number(local[2]), local[3], local[4], local[5], local[6]);
  const dayFirst = DAY_FIRST.exec(text);
  if (dayFirst) return wallFrom(dayFirst[4], Number(dayFirst[3]), dayFirst[1], dayFirst[5], dayFirst[6], dayFirst[7]);
  const yearFirst = YEAR_FIRST.exec(text);
  if (yearFirst) return wallFrom(yearFirst[1], Number(yearFirst[2]), yearFirst[3], yearFirst[4], yearFirst[5], yearFirst[6]);
  const named = DAY_MONTH_NAME.exec(text);
  if (named && monthNumber(named[2])) return namedWall(named[3], monthNumber(named[2]), named[1], named[4], named[5], named[6], named[7]);
  const monthFirst = MONTH_NAME_DAY.exec(text);
  if (monthFirst && monthNumber(monthFirst[1])) {
    return namedWall(monthFirst[3], monthNumber(monthFirst[1]), monthFirst[2], monthFirst[4], monthFirst[5], monthFirst[6], monthFirst[7]);
  }
  return null;
}

function realWall(wall: Wall) {
  const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
  return (
    wall.month >= 1 &&
    wall.month <= 12 &&
    check.getUTCFullYear() === wall.year &&
    check.getUTCMonth() === wall.month - 1 &&
    check.getUTCDate() === wall.day &&
    check.getUTCHours() === wall.hour &&
    check.getUTCMinutes() === wall.minute &&
    check.getUTCSeconds() === wall.second
  );
}

function sameWall(date: Date, wall: Wall, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  return parts.year === wall.year && parts.month === wall.month && parts.day === wall.day && parts.hour === wall.hour && parts.minute === wall.minute;
}

function wallLabel(wall: Wall) {
  return `${pad(wall.hour)}:${pad(wall.minute)} on ${SHORT_DAY.format(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)))}`;
}

function zonedInstant(text: string) {
  const zoned = ZONED_DATE_TIME.exec(text);
  if (zoned) {
    const zone = zoned[3].toUpperCase();
    const offset = zone === "Z" || zone === "UTC" || zone === "GMT" ? "Z" : zone.length === 3 ? `${zone}:00` : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const date = new Date(`${zoned[1]}T${zoned[2]}${offset}`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const suffix = ZONE_SUFFIX.exec(text);
  if (!suffix) return null;
  const offset = suffix[4]
    ? ZONE_OFFSETS[suffix[4].toUpperCase()]
    : (suffix[1] === "-" ? -1 : 1) * (Number(suffix[2]) * 60 + Number(suffix[3]));
  if (offset === undefined) return null;
  const wall = readWall(text.slice(0, suffix.index));
  if (!wall || typeof wall === "string" || wall.dateOnly || !realWall(wall)) return null;
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - offset * 60_000);
}

function readInstant(value: string, timeZone: string, strict: boolean): DateTimeReading {
  const text = value.trim();
  if (!text) return { ok: false, error: FORMAT_HINT };
  const zoned = zonedInstant(text);
  if (zoned) return { ok: true, date: zoned, dateOnly: false };
  const wall = readWall(text);
  if (wall === null) return { ok: false, error: FORMAT_HINT };
  if (typeof wall === "string") return { ok: false, error: wall };
  if (!realWall(wall)) return { ok: false, error: `${text} isn't a real ${wall.dateOnly ? "date" : "date and time"}.` };
  const date = zonedTimeToDate(wall, timeZone);
  if (strict && !wall.dateOnly) {
    if (!sameWall(date, wall, timeZone)) {
      return { ok: false, error: `${wallLabel(wall)} doesn't exist in ${zoneLabel(timeZone)} because the clocks go forward. Pick another time.` };
    }
    const hour = 3_600_000;
    if ([date.getTime() - hour, date.getTime() + hour].some((at) => sameWall(new Date(at), wall, timeZone))) {
      return {
        ok: false,
        error: `${wallLabel(wall)} happens twice in ${zoneLabel(timeZone)} because the clocks go back. Add the offset, such as +01:00 or Z.`,
      };
    }
  }
  return { ok: true, date, dateOnly: wall.dateOnly };
}

export function readDateTime(value: string, timeZone = appTimeZone()): DateTimeReading {
  return readInstant(value, timeZone, true);
}

export function parseDateTime(value: string, timeZone = appTimeZone()): Date | null {
  const reading = readInstant(value, timeZone, false);
  return reading.ok ? reading.date : null;
}

export function dayKeyIn(date: Date, timeZone = appTimeZone()) {
  const parts = zonedParts(date, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function readDay(value: string, timeZone = appTimeZone()): string | null {
  const reading = readInstant(value, timeZone, false);
  return reading.ok ? dayKeyIn(reading.date, timeZone) : null;
}

export function toIsoInstant(value: string, timeZone = appTimeZone()) {
  return parseDateTime(value, timeZone)?.toISOString() ?? null;
}

function pad(value: number, size = 2) {
  return String(value).padStart(size, "0");
}

export function dateTimeInputValue(iso: string | null | undefined, timeZone = appTimeZone()) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = zonedParts(date, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function startOfDay(date = new Date(), timeZone = appTimeZone(), addDays = 0) {
  const parts = zonedParts(date, timeZone);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + addDays * DAY_MS);
  return zonedTimeToDate(
    {
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

export function dayWindow(now = new Date(), timeZone = appTimeZone()) {
  return { start: startOfDay(now, timeZone), end: startOfDay(now, timeZone, 1) };
}
