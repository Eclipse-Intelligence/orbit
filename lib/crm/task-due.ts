import { withActor } from "@/lib/crm/context";
import type { Actor } from "@/lib/crm/types";
import { appTimeZone, readDay, zonedParts } from "@/lib/time";
import {
  addWorkingDays,
  bankHolidays,
  christmasBreak,
  dayKey,
  dayKeyAt,
  dayParts,
  nextWorkingDay,
  nonWorkingReason,
  shiftDay,
  wallClockAt,
  wallClockMs,
  weekday,
} from "@/lib/crm/working-days";

export { addWorkingDays, bankHolidays, christmasBreak, dayKey, dayKeyAt, nextWorkingDay, nonWorkingReason, shiftDay, wallClockAt, weekday };

export type BusyBlock = { start: number; end: number };

export type DuePlan = { dueDate: string; note: string | null };

const DAY_START = { hour: 9, minute: 0 };
const DAY_END = { hour: 17, minute: 30 };
const MIN_FREE_MINUTES = 60;
const SLOT_MINUTES = 30;
const LOOK_AHEAD_DAYS = 21;
const LATEST_DAYS = 730;

function freeSlot(key: string, busy: BusyBlock[], timeZone: string, notBefore: number) {
  const open = Math.max(wallClockMs(key, DAY_START.hour, DAY_START.minute, timeZone), notBefore);
  const close = wallClockMs(key, DAY_END.hour, DAY_END.minute, timeZone);
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
  const { year, month, day } = dayParts(key);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function plannedDay(input: { days?: number | null; on?: string | null }, now: Date, timeZone = appTimeZone()) {
  const today = zonedParts(now, timeZone);
  const todayKey = dayKey(today.year, today.month, today.day);
  const on = input.on && /^\d{4}-\d{2}-\d{2}$/.test(input.on) ? input.on : null;
  if (on && on >= todayKey && on <= shiftDay(todayKey, LATEST_DAYS)) return { key: on, today: on === todayKey };
  if (input.days === null || input.days === undefined || !Number.isFinite(input.days)) return null;
  const days = Math.max(0, Math.min(Math.round(input.days), LATEST_DAYS));
  return { key: shiftDay(todayKey, days), today: days === 0 };
}

export function planTaskDue(
  input: { days?: number | null; on?: string | null; busy?: BusyBlock[] | null },
  now = new Date(),
  timeZone = appTimeZone(),
): DuePlan | null {
  const chosen = chooseDue(input, now, timeZone);
  return chosen ? { dueDate: dayKeyAt(new Date(chosen.at), timeZone), note: chosen.note } : null;
}

function chooseDue(input: { days?: number | null; on?: string | null; busy?: BusyBlock[] | null }, now: Date, timeZone: string) {
  const planned = plannedDay(input, now, timeZone);
  if (!planned) return null;
  const nowMs = now.getTime();
  if (planned.today && !nonWorkingReason(planned.key) && nowMs < wallClockMs(planned.key, DAY_END.hour, DAY_END.minute, timeZone)) {
    return { at: now.getTime(), note: null };
  }
  const skipped = nonWorkingReason(planned.key);
  let key = nextWorkingDay(planned.today ? shiftDay(planned.key, skipped ? 0 : 1) : planned.key);
  const busy = input.busy ?? null;
  let booked = 0;
  if (busy) {
    for (let index = 0; index < LOOK_AHEAD_DAYS; index += 1) {
      const slot = freeSlot(key, busy, timeZone, nowMs);
      if (slot !== null) {
        return { at: slot, note: moveNote(planned.key, key, skipped, booked) };
      }
      booked += 1;
      key = nextWorkingDay(shiftDay(key, 1));
    }
    key = nextWorkingDay(planned.today ? shiftDay(planned.key, 1) : planned.key);
    booked = 0;
  }
  return { at: wallClockMs(key, DAY_START.hour, DAY_START.minute, timeZone), note: moveNote(planned.key, key, skipped, booked) };
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
  const whole = readDay(text, timeZone);
  if (whole) return whole;
  const inside = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/.exec(text);
  return inside ? readDay(inside[0], timeZone) : null;
}
