import { dateKey, shiftDateKey, weekday } from "@/lib/calendar-view";
import { clockMinutes, WEEKDAYS, type WeeklyHours } from "@/lib/booking/rules";
import { startOfDay, zonedParts, zonedTimeToDate } from "@/lib/time";

const MINUTE = 60_000;
const DAY = 86_400_000;
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type SlotRules = {
  weeklyHours: WeeklyHours;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  timeZone: string;
};

export type BusyInterval = { start: number; end: number };

export type SlotQuery = {
  from: number;
  to: number;
  now: number;
  busy: BusyInterval[];
};

export function slotStep(durationMinutes: number) {
  return durationMinutes <= 30 ? durationMinutes : 30;
}

export function bookingBounds(rules: SlotRules, now: number) {
  return {
    earliest: now + rules.minNoticeMinutes * MINUTE,
    latest: startOfDay(new Date(now), rules.timeZone, rules.horizonDays + 1).getTime(),
  };
}

function wallInstant(key: string, minutes: number, timeZone: string) {
  const day = minutes >= 24 * 60 ? shiftDateKey(key, 1) : key;
  const rest = minutes % (24 * 60);
  const [year, month, date] = day.split("-").map(Number);
  const wall = { year, month, day: date, hour: Math.floor(rest / 60), minute: rest % 60, second: 0 };
  const instant = zonedTimeToDate(wall, timeZone);
  const back = zonedParts(instant, timeZone);
  const exists =
    back.year === wall.year &&
    back.month === wall.month &&
    back.day === wall.day &&
    back.hour === wall.hour &&
    back.minute === wall.minute;
  return { instant: instant.getTime(), exists };
}

function overlapsBusy(start: number, end: number, busy: BusyInterval[], buffer: number) {
  for (const interval of busy) {
    if (interval.start - buffer < end && interval.end + buffer > start) return true;
  }
  return false;
}

export function generateSlots(rules: SlotRules, query: SlotQuery): number[] {
  if (!(query.to > query.from)) return [];
  const duration = rules.durationMinutes * MINUTE;
  const buffer = rules.bufferMinutes * MINUTE;
  const step = slotStep(rules.durationMinutes);
  const { earliest, latest } = bookingBounds(rules, query.now);
  const from = Math.max(query.from, earliest);
  const to = Math.min(query.to, latest);
  if (!(to > from)) return [];
  const busy = query.busy.filter(
    (interval) => interval.end + buffer > from - DAY && interval.start - buffer < to + DAY,
  );
  const found = new Set<number>();
  const lastKey = dateKey(to - 1, rules.timeZone);
  for (let key = dateKey(from, rules.timeZone); key <= lastKey; key = shiftDateKey(key, 1)) {
    const ranges = rules.weeklyHours[WEEKDAYS[weekday(key)]] ?? [];
    for (const range of ranges) {
      const first = clockMinutes(range.start);
      const last = clockMinutes(range.end);
      const rangeEnd = wallInstant(key, last, rules.timeZone).instant;
      for (let minutes = first; minutes + rules.durationMinutes <= last; minutes += step) {
        const { instant, exists } = wallInstant(key, minutes, rules.timeZone);
        if (!exists) continue;
        const end = instant + duration;
        if (end > rangeEnd) continue;
        if (instant < from || instant >= to) continue;
        if (overlapsBusy(instant, end, busy, buffer)) continue;
        found.add(instant);
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function isOpenSlot(rules: SlotRules, start: number, now: number, busy: BusyInterval[]) {
  if (!Number.isFinite(start)) return false;
  return generateSlots(rules, { from: start, to: start + 1, now, busy }).includes(start);
}

export function groupSlots(slots: number[], timeZone: string) {
  const days: Record<string, string[]> = {};
  for (const slot of slots) {
    const key = dateKey(slot, timeZone);
    (days[key] ??= []).push(new Date(slot).toISOString());
  }
  return days;
}

export function parseMonth(value: string | null | undefined) {
  const match = value ? MONTH_KEY.exec(value.trim()) : null;
  return match ? `${match[1]}-${match[2]}` : null;
}

export function monthOf(instant: number, timeZone: string) {
  return dateKey(instant, timeZone).slice(0, 7);
}

export function shiftMonth(month: string, count: number) {
  const [year, value] = month.split("-").map(Number);
  const index = year * 12 + (value - 1) + count;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function monthWindow(month: string, timeZone: string) {
  const [year, value] = month.split("-").map(Number);
  const next = shiftMonth(month, 1).split("-").map(Number);
  return {
    from: zonedTimeToDate({ year, month: value, day: 1, hour: 0, minute: 0, second: 0 }, timeZone).getTime(),
    to: zonedTimeToDate({ year: next[0], month: next[1], day: 1, hour: 0, minute: 0, second: 0 }, timeZone).getTime(),
  };
}

export function bookableMonths(rules: SlotRules, now: number, timeZone: string) {
  const { earliest, latest } = bookingBounds(rules, now);
  return { first: monthOf(Math.min(now, earliest), timeZone), last: monthOf(latest - 1, timeZone) };
}
