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

export function parseDateTime(value: string, timeZone = appTimeZone()): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = LOCAL_DATE_TIME.exec(trimmed);
  if (!match) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return zonedTimeToDate({ year, month, day, hour, minute, second }, timeZone);
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
