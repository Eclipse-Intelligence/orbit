import { withActor } from "@/lib/crm/context";
import type { Actor } from "@/lib/crm/types";
import { appTimeZone, zonedParts, zonedTimeToDate } from "@/lib/time";

export type BusyBlock = { start: number; end: number };

export type DuePlan = { dueAt: string; note: string | null };

const DAY_START = { hour: 9, minute: 0 };
const DAY_END = { hour: 17, minute: 30 };
const MIN_FREE_MINUTES = 60;
const SLOT_MINUTES = 30;
const LOOK_AHEAD_DAYS = 21;
const LATEST_DAYS = 730;

export function dayKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parts(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

export function shiftDay(key: string, days: number) {
  const { year, month, day } = parts(key);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return dayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function weekday(key: string) {
  const { year, month, day } = parts(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function easterSunday(year: number) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayKey(year, month, day);
}

function firstMonday(year: number, month: number) {
  let key = dayKey(year, month, 1);
  while (weekday(key) !== 1) key = shiftDay(key, 1);
  return key;
}

function lastMonday(year: number, month: number) {
  let key = shiftDay(dayKey(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1), -1);
  while (weekday(key) !== 1) key = shiftDay(key, -1);
  return key;
}

function weekdayOnOrAfter(key: string) {
  let next = key;
  while (weekday(next) === 0 || weekday(next) === 6) next = shiftDay(next, 1);
  return next;
}

export function bankHolidays(year: number) {
  const days = new Set<string>();
  days.add(weekdayOnOrAfter(dayKey(year, 1, 1)));
  const easter = easterSunday(year);
  days.add(shiftDay(easter, -2));
  days.add(shiftDay(easter, 1));
  days.add(firstMonday(year, 5));
  days.add(lastMonday(year, 5));
  days.add(lastMonday(year, 8));
  const christmas = dayKey(year, 12, 25);
  const boxing = dayKey(year, 12, 26);
  const christmasDay = weekday(christmas);
  if (christmasDay === 6) {
    days.add(dayKey(year, 12, 27));
    days.add(dayKey(year, 12, 28));
  } else if (christmasDay === 0) {
    days.add(dayKey(year, 12, 26));
    days.add(dayKey(year, 12, 27));
  } else if (christmasDay === 5) {
    days.add(christmas);
    days.add(dayKey(year, 12, 28));
  } else {
    days.add(christmas);
    days.add(boxing);
  }
  return days;
}

export function christmasBreak(key: string) {
  const { month, day } = parts(key);
  return (month === 12 && day >= 24) || (month === 1 && day === 1);
}

export function nonWorkingReason(key: string) {
  const day = weekday(key);
  if (day === 6) return "a Saturday";
  if (day === 0) return "a Sunday";
  if (christmasBreak(key)) return "over Christmas";
  if (bankHolidays(parts(key).year).has(key)) return "a bank holiday";
  return null;
}

export function nextWorkingDay(key: string) {
  let next = key;
  for (let guard = 0; guard < 40 && nonWorkingReason(next); guard += 1) next = shiftDay(next, 1);
  return next;
}

function at(key: string, hour: number, minute: number, timeZone: string) {
  const { year, month, day } = parts(key);
  return zonedTimeToDate({ year, month, day, hour, minute, second: 0 }, timeZone).getTime();
}

function freeSlot(key: string, busy: BusyBlock[], timeZone: string, notBefore: number) {
  const open = Math.max(at(key, DAY_START.hour, DAY_START.minute, timeZone), notBefore);
  const close = at(key, DAY_END.hour, DAY_END.minute, timeZone);
  if (open >= close) return null;
  const blocks = busy.filter((block) => block.start < close && block.end > open).sort((left, right) => left.start - right.start);
  let cursor = open;
  let free = 0;
  let first: number | null = null;
  for (const block of [...blocks, { start: close, end: close }]) {
    const gap = Math.min(block.start, close) - cursor;
    if (gap > 0) {
      free += gap;
      if (first === null && gap >= SLOT_MINUTES * 60_000) first = cursor;
    }
    cursor = Math.max(cursor, block.end);
  }
  if (free < MIN_FREE_MINUTES * 60_000 || first === null) return null;
  const quarter = 15 * 60_000;
  return Math.ceil(first / quarter) * quarter;
}

function readable(key: string) {
  const { year, month, day } = parts(key);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function plannedDay(input: { days?: number | null; on?: string | null }, now: Date, timeZone = appTimeZone()) {
  const today = zonedParts(now, timeZone);
  const todayKey = dayKey(today.year, today.month, today.day);
  const on = input.on && /^\d{4}-\d{2}-\d{2}$/.test(input.on) ? input.on : null;
  if (on && on > todayKey && on <= shiftDay(todayKey, LATEST_DAYS)) return { key: on, today: false };
  if (input.days === null || input.days === undefined || !Number.isFinite(input.days)) return null;
  const days = Math.max(0, Math.min(Math.round(input.days), LATEST_DAYS));
  return { key: shiftDay(todayKey, days), today: days === 0 };
}

export function planTaskDue(
  input: { days?: number | null; on?: string | null; busy?: BusyBlock[] | null },
  now = new Date(),
  timeZone = appTimeZone(),
): DuePlan | null {
  const planned = plannedDay(input, now, timeZone);
  if (!planned) return null;
  const nowMs = now.getTime();
  if (planned.today && !nonWorkingReason(planned.key) && nowMs < at(planned.key, DAY_END.hour, DAY_END.minute, timeZone)) {
    return { dueAt: now.toISOString(), note: null };
  }
  const skipped = nonWorkingReason(planned.key);
  let key = nextWorkingDay(planned.today ? shiftDay(planned.key, skipped ? 0 : 1) : planned.key);
  const busy = input.busy ?? null;
  let booked = 0;
  if (busy) {
    for (let index = 0; index < LOOK_AHEAD_DAYS; index += 1) {
      const slot = freeSlot(key, busy, timeZone, nowMs);
      if (slot !== null) {
        return { dueAt: new Date(slot).toISOString(), note: moveNote(planned.key, key, skipped, booked) };
      }
      booked += 1;
      key = nextWorkingDay(shiftDay(key, 1));
    }
    key = nextWorkingDay(planned.today ? shiftDay(planned.key, 1) : planned.key);
    booked = 0;
  }
  return { dueAt: new Date(at(key, DAY_START.hour, DAY_START.minute, timeZone)).toISOString(), note: moveNote(planned.key, key, skipped, booked) };
}

function moveNote(from: string, to: string, skipped: string | null, booked: number) {
  if (from === to) return null;
  const reasons = [skipped ? `${readable(from)} is ${skipped}` : "", booked ? `your calendar is full ${booked === 1 ? "that day" : `for ${booked} working days`}` : ""].filter(Boolean);
  return `Due ${readable(to)}${reasons.length ? ` because ${reasons.join(" and ")}` : ""}.`;
}

export async function busyFor(actor: Actor, ownerId: string | null | undefined, from: Date, days = LOOK_AHEAD_DAYS + 14) {
  if (actor.type !== "user" || (ownerId && ownerId !== actor.userId)) return null;
  const to = new Date(from.getTime() + days * 86_400_000);
  try {
    return await withActor(actor, async (db) => {
      const result = await db.query<{ starts_at: Date; ends_at: Date }>(
        `select e.starts_at, e.ends_at
         from crm.calendar_events e
         where e.user_id = $1 and not e.is_cancelled and coalesce(lower(e.show_as), 'busy') <> 'free'
           and e.starts_at < $3 and e.ends_at > $2
         order by e.starts_at
         limit 5000`,
        [actor.userId, from.toISOString(), to.toISOString()],
      );
      return result.rows.map((row) => ({ start: new Date(row.starts_at).getTime(), end: new Date(row.ends_at).getTime() }));
    });
  } catch {
    return null;
  }
}

export async function scheduleTaskDue(
  actor: Actor,
  input: { days?: number | null; on?: string | null; ownerId?: string | null; busy?: BusyBlock[] | null },
  now = new Date(),
): Promise<DuePlan | null> {
  const planned = plannedDay(input, now);
  if (!planned) return null;
  const busy = input.busy !== undefined ? input.busy : await busyFor(actor, input.ownerId, new Date(Math.max(now.getTime(), Date.parse(`${planned.key}T00:00:00Z`) - 86_400_000)));
  return planTaskDue({ ...input, busy }, now);
}

export function withDueNote(description: string | null | undefined, plan: DuePlan | null) {
  if (!plan?.note) return description ?? null;
  return [description?.trim(), plan.note].filter(Boolean).join("\n\n");
}

export function dueDayFrom(value: string | null | undefined, timeZone = appTimeZone()) {
  const text = (value ?? "").trim();
  if (!text) return null;
  const plain = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (plain) {
    const key = `${plain[1]}-${plain[2]}-${plain[3]}`;
    const { year, month, day } = parts(key);
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? key : null;
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  const wall = zonedParts(new Date(parsed), timeZone);
  return dayKey(wall.year, wall.month, wall.day);
}
