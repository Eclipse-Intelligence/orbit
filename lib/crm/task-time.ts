import { addWorkingDays, dayKeyAt, nextWorkingDay, nonWorkingReason, shiftDay, wallClockAt, weekday } from "@/lib/crm/working-days";
import { appTimeZone, startOfDay, zonedParts } from "@/lib/time";

export const DEFAULT_TASK_DURATION = 15;
export const MIN_TASK_DURATION = 5;
export const MAX_TASK_DURATION = 480;
export const DURATION_CHOICES = [5, 10, 15, 30, 45, 60] as const;
export const SCHEDULE_STEP_MINUTES = 15;
export const MORNING = { hour: 9, minute: 0 };
export const DAY_CLOSE = { hour: 17, minute: 30 };

type Timing = { dueAt: string | null; dueHasTime?: boolean | null };

export function isTaskDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_TASK_DURATION && value <= MAX_TASK_DURATION;
}

export function durationLabel(minutes: number | null | undefined) {
  const total = typeof minutes === "number" && Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : DEFAULT_TASK_DURATION;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function dayStartIso(key: string, timeZone = appTimeZone()) {
  return new Date(wallClockAt(key, 0, 0, timeZone)).toISOString();
}

export function taskDueDay(dueAt: string | null | undefined, timeZone = appTimeZone()) {
  if (!dueAt) return null;
  const date = new Date(dueAt);
  return Number.isNaN(date.getTime()) ? null : dayKeyAt(date, timeZone);
}

export function taskDueEnd(task: Timing, timeZone = appTimeZone()) {
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  return task.dueHasTime ? due.getTime() : startOfDay(due, timeZone, 1).getTime();
}

export function isTaskOverdue(task: Timing & { completedAt?: string | null }, now: number, timeZone = appTimeZone()) {
  if (task.completedAt) return false;
  const end = taskDueEnd(task, timeZone);
  return end !== null && end <= now;
}

export function timeOfDay(dueAt: string, timeZone = appTimeZone()) {
  const wall = zonedParts(new Date(dueAt), timeZone);
  return { hour: wall.hour, minute: wall.minute };
}

export function clockLabel(dueAt: string, timeZone = appTimeZone()) {
  const { hour, minute } = timeOfDay(dueAt, timeZone);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function onDayKeepingKind(task: Timing, key: string, timeZone = appTimeZone()) {
  if (task.dueHasTime && task.dueAt) {
    const { hour, minute } = timeOfDay(task.dueAt, timeZone);
    return { dueAt: new Date(wallClockAt(key, hour, minute, timeZone)).toISOString() };
  }
  return { dueDate: key };
}

export function atKeepingKind(task: Timing, at: string, timeZone = appTimeZone()) {
  if (task.dueHasTime) return { dueAt: at };
  return { dueDate: dayKeyAt(new Date(at), timeZone) };
}

export type ScheduleChoice = { id: string; label: string; detail: string; at: string };

function dayName(key: string, long = false) {
  return new Intl.DateTimeFormat("en-GB", { weekday: long ? "long" : "short", timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`));
}

export function durationWords(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "", rest ? `${rest} minute${rest === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.join(" ") || "0 minutes";
}

export function nextFreeStart(now: number, durationMinutes: number, busy: { start: number; end: number }[], timeZone = appTimeZone()) {
  const today = dayKeyAt(new Date(now), timeZone);
  if (nonWorkingReason(today)) return null;
  const open = wallClockAt(today, MORNING.hour, MORNING.minute, timeZone);
  const close = wallClockAt(today, DAY_CLOSE.hour, DAY_CLOSE.minute, timeZone);
  const step = SCHEDULE_STEP_MINUTES * 60_000;
  const length = durationMinutes * 60_000;
  let cursor = Math.ceil(Math.max(now, open) / step) * step;
  for (const block of [...busy].sort((left, right) => left.start - right.start)) {
    if (block.end <= cursor) continue;
    if (block.start >= cursor + length) break;
    cursor = Math.ceil(block.end / step) * step;
  }
  return cursor + length <= close ? cursor : null;
}

function morning(key: string, label: string, id: string, timeZone: string): ScheduleChoice {
  const at = new Date(wallClockAt(key, MORNING.hour, MORNING.minute, timeZone)).toISOString();
  return { id, label, detail: `${dayName(key)} ${clockLabel(at, timeZone)}`, at };
}

export function scheduleChoices(
  input: { durationMinutes: number; now: number; busy?: { start: number; end: number }[] },
  timeZone = appTimeZone(),
): ScheduleChoice[] {
  const today = dayKeyAt(new Date(input.now), timeZone);
  const choices: ScheduleChoice[] = [];
  const free = nextFreeStart(input.now, input.durationMinutes, input.busy ?? [], timeZone);
  if (free !== null) {
    const at = new Date(free).toISOString();
    choices.push({ id: "next-free", label: `Next free ${durationWords(input.durationMinutes)}`, detail: clockLabel(at, timeZone), at });
  }
  const next = addWorkingDays(today, 1);
  choices.push(morning(next, next === shiftDay(today, 1) ? "Tomorrow morning" : `${dayName(next, true)} morning`, "tomorrow", timeZone));
  const monday = nextWorkingDay(shiftDay(today, (8 - weekday(today)) % 7 || 7));
  if (monday !== next) choices.push(morning(monday, `${dayName(monday, true)} morning`, "monday", timeZone));
  return choices;
}

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function reminderTimeFor(day: string, leadMinutes: number, now: number, timeZone = appTimeZone()) {
  const today = dayKeyAt(new Date(now), timeZone);
  if (day > today) return clock(MORNING.hour * 60 + MORNING.minute);
  if (day < today) return null;
  const wall = zonedParts(new Date(now), timeZone);
  const minutes = wall.hour * 60 + wall.minute + Math.max(0, leadMinutes);
  const next = Math.ceil((minutes + 1) / SCHEDULE_STEP_MINUTES) * SCHEDULE_STEP_MINUTES;
  return next >= 24 * 60 ? null : clock(next);
}

export function isPastTime(day: string, time: string, now: number, timeZone = appTimeZone()) {
  const [hour, minute] = time.split(":").map(Number);
  return wallClockAt(day, hour, minute, timeZone) <= now;
}
