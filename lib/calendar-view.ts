import { appTimeZone, zonedParts, zonedTimeToDate } from "@/lib/time";

export type CalendarMode = "day" | "week";

export const DAY_MINUTES = 24 * 60;

const DAY_MS = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, size = 2) {
  return String(value).padStart(size, "0");
}

function keyParts(key: string) {
  const match = DATE_KEY.exec(key);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function utcKey(date: Date) {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function parseDateKey(value: string | null | undefined) {
  if (!value) return null;
  const parts = keyParts(value.trim());
  return parts ? `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` : null;
}

export function parseMode(value: string | null | undefined): CalendarMode | null {
  return value === "day" || value === "week" ? value : null;
}

export function dateKey(instant: Date | string | number, timeZone = appTimeZone()) {
  const parts = zonedParts(new Date(instant), timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function shiftDateKey(key: string, days: number) {
  const parts = keyParts(key);
  if (!parts) throw new Error(`Invalid date ${key}`);
  return utcKey(new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS));
}

export function weekday(key: string) {
  const parts = keyParts(key);
  if (!parts) throw new Error(`Invalid date ${key}`);
  return (new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() + 6) % 7;
}

export function weekStartKey(key: string) {
  return shiftDateKey(key, -weekday(key));
}

export function dayStart(key: string, timeZone = appTimeZone()) {
  const parts = keyParts(key);
  if (!parts) throw new Error(`Invalid date ${key}`);
  return zonedTimeToDate({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
}

export function rangeDays(key: string, mode: CalendarMode) {
  const first = mode === "week" ? weekStartKey(key) : key;
  const count = mode === "week" ? 7 : 1;
  return Array.from({ length: count }, (_, index) => shiftDateKey(first, index));
}

export function calendarRange(key: string, mode: CalendarMode, timeZone = appTimeZone()) {
  const days = rangeDays(key, mode);
  return {
    days,
    start: dayStart(days[0], timeZone),
    end: dayStart(shiftDateKey(days[days.length - 1], 1), timeZone),
  };
}

export function stepDays(mode: CalendarMode) {
  return mode === "week" ? 7 : 1;
}

export function wallMinutes(instant: Date | string | number, timeZone = appTimeZone()) {
  const parts = zonedParts(new Date(instant), timeZone);
  return parts.hour * 60 + parts.minute;
}

export function allDayKey(instant: Date | string | number, timeZone = appTimeZone()) {
  const date = new Date(instant);
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0) return utcKey(date);
  return dateKey(date, timeZone);
}

export function allDayKeys(startsAt: string, endsAt: string, timeZone = appTimeZone()) {
  const first = allDayKey(startsAt, timeZone);
  const last = allDayKey(endsAt, timeZone);
  const keys: string[] = [];
  let key = first;
  while (key < last && keys.length < 400) {
    keys.push(key);
    key = shiftDateKey(key, 1);
  }
  return keys.length > 0 ? keys : [first];
}

export function daySpan(
  startsAt: string,
  endsAt: string,
  key: string,
  timeZone = appTimeZone(),
): { top: number; bottom: number } | null {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const open = dayStart(key, timeZone).getTime();
  const close = dayStart(shiftDateKey(key, 1), timeZone).getTime();
  if (start >= close || end <= open || (end === start && start < open)) return null;
  const top = start <= open ? 0 : wallMinutes(start, timeZone);
  const bottom = end >= close ? DAY_MINUTES : wallMinutes(end, timeZone);
  return { top, bottom: Math.max(bottom, top) };
}

export type LayoutInput = { id: string; top: number; bottom: number };
export type LayoutSlot = { column: number; columns: number };

export function packColumns(items: LayoutInput[], minimumHeight = 15) {
  const sorted = [...items].sort(
    (left, right) => left.top - right.top || right.bottom - left.bottom || left.id.localeCompare(right.id),
  );
  const slots = new Map<string, LayoutSlot>();
  let cluster: { id: string; column: number }[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;

  const close = () => {
    for (const entry of cluster) slots.set(entry.id, { column: entry.column, columns: columnEnds.length });
    cluster = [];
    columnEnds = [];
  };

  for (const item of sorted) {
    const bottom = Math.max(item.bottom, item.top + minimumHeight);
    if (item.top >= clusterEnd) close();
    let column = columnEnds.findIndex((end) => end <= item.top);
    if (column < 0) {
      column = columnEnds.length;
      columnEnds.push(bottom);
    } else {
      columnEnds[column] = bottom;
    }
    cluster.push({ id: item.id, column });
    clusterEnd = cluster.length === 1 ? bottom : Math.max(clusterEnd, bottom);
  }
  close();
  return slots;
}

type MergeableEvent = {
  calendarId: string;
  subject: string | null;
  startsAt: string;
  endsAt: string;
  icalUid: string | null;
  alsoIn: string[];
  canCancel: boolean;
  granolaHref: string | null;
};

export function mergeDuplicateEvents<T extends MergeableEvent>(items: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of items) {
    const key = item.icalUid
      ? `uid:${item.icalUid}|${item.startsAt}`
      : `subject:${(item.subject ?? "").trim().toLowerCase()}|${item.startsAt}|${item.endsAt}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item, alsoIn: [] });
      continue;
    }
    const keep = item.canCancel && !existing.canCancel ? { ...item, alsoIn: [] as string[] } : existing;
    const other = keep === existing ? item : existing;
    keep.alsoIn = [...new Set([...keep.alsoIn, other.calendarId, ...other.alsoIn])].filter(
      (id) => id !== keep.calendarId,
    );
    keep.granolaHref = keep.granolaHref ?? other.granolaHref;
    merged.set(key, keep);
  }
  return [...merged.values()];
}
