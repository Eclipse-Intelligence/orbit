import { dayKeyAt, shiftDay, wallClockAt, weekday } from "@/lib/crm/working-days";
import { appTimeZone, startOfDay, zonedParts } from "@/lib/time";
import { DEFAULT_WORKING_HOURS, firstWorkableDay, nextWorkableDay, wallAt, workingDay, workingWindow, type WorkingHours } from "@/lib/working-hours";

export const DEFAULT_TASK_DURATION = 15;
export const MIN_TASK_DURATION = 5;
export const MAX_TASK_DURATION = 480;
export const DURATION_CHOICES = [5, 10, 15, 30, 45, 60] as const;
export const SCHEDULE_STEP_MINUTES = 15;
export const MORNING = { hour: 9, minute: 0 };

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

export function nextFreeStart(now: number, durationMinutes: number, busy: { start: number; end: number }[], timeZone = appTimeZone(), hours: WorkingHours = DEFAULT_WORKING_HOURS) {
  const today = dayKeyAt(new Date(now), timeZone);
  const window = workingWindow(today, hours, timeZone);
  if (!window) return null;
  const step = SCHEDULE_STEP_MINUTES * 60_000;
  const length = durationMinutes * 60_000;
  let cursor = Math.ceil(Math.max(now, window.open) / step) * step;
  for (const block of [...busy].sort((left, right) => left.start - right.start)) {
    if (block.end <= cursor) continue;
    if (block.start >= cursor + length) break;
    cursor = Math.ceil(block.end / step) * step;
  }
  return cursor + length <= window.close ? cursor : null;
}

function morning(key: string, label: string, id: string, timeZone: string, hours: WorkingHours): ScheduleChoice {
  const at = new Date(wallAt(key, workingDay(hours, key).start, timeZone)).toISOString();
  return { id, label, detail: `${dayName(key)} ${clockLabel(at, timeZone)}`, at };
}

export function scheduleChoices(
  input: { durationMinutes: number; now: number; busy?: { start: number; end: number }[]; hours?: WorkingHours },
  timeZone = appTimeZone(),
): ScheduleChoice[] {
  const hours = input.hours ?? DEFAULT_WORKING_HOURS;
  const today = dayKeyAt(new Date(input.now), timeZone);
  const choices: ScheduleChoice[] = [];
  const free = nextFreeStart(input.now, input.durationMinutes, input.busy ?? [], timeZone, hours);
  if (free !== null) {
    const at = new Date(free).toISOString();
    choices.push({ id: "next-free", label: `Next free ${durationWords(input.durationMinutes)}`, detail: clockLabel(at, timeZone), at });
  }
  const next = nextWorkableDay(today, hours);
  if (!next) return choices;
  choices.push(morning(next, next === shiftDay(today, 1) ? "Tomorrow morning" : `${dayName(next, true)} morning`, "tomorrow", timeZone, hours));
  const monday = firstWorkableDay(shiftDay(today, (8 - weekday(today)) % 7 || 7), hours);
  if (monday && monday !== next) choices.push(morning(monday, `${dayName(monday, true)} morning`, "monday", timeZone, hours));
  return choices;
}

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function sameWall(at: number, hour: number, minute: number, key: string, timeZone: string) {
  const wall = zonedParts(new Date(at), timeZone);
  return wall.hour === hour && wall.minute === minute && dayKeyAt(new Date(at), timeZone) === key;
}

export function wallInstant(key: string, hour: number, minute: number, timeZone = appTimeZone()) {
  const at = wallClockAt(key, hour, minute, timeZone);
  const earlier = at - 3_600_000;
  return sameWall(earlier, hour, minute, key, timeZone) ? earlier : at;
}

const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

export function localInstant(value: string, timeZone = appTimeZone()) {
  const match = LOCAL.exec(value);
  if (!match) return value;
  return new Date(wallInstant(match[1], Number(match[2]), Number(match[3]), timeZone)).toISOString();
}

function reminderFits(day: string, minutes: number, leadMinutes: number, now: number, timeZone: string) {
  return wallInstant(day, Math.floor(minutes / 60), minutes % 60, timeZone) - Math.max(0, leadMinutes) * 60_000 > now;
}

export function reminderTimeFor(day: string, leadMinutes: number, now: number, timeZone = appTimeZone()) {
  const today = dayKeyAt(new Date(now), timeZone);
  if (day < today) return null;
  const morning = MORNING.hour * 60 + MORNING.minute;
  if (day > today && reminderFits(day, morning, leadMinutes, now, timeZone)) return clock(morning);
  for (let minutes = 0; minutes < 24 * 60; minutes += SCHEDULE_STEP_MINUTES) {
    if (reminderFits(day, minutes, leadMinutes, now, timeZone)) return clock(minutes);
  }
  return null;
}

export function reminderBlock(day: string, leadMinutes: number, now: number, timeZone = appTimeZone()) {
  if (reminderTimeFor(day, leadMinutes, now, timeZone)) return null;
  return day < dayKeyAt(new Date(now), timeZone) ? ("past" as const) : ("lead" as const);
}

export function isPastTime(day: string, time: string, now: number, timeZone = appTimeZone(), leadMinutes = 0) {
  const [hour, minute] = time.split(":").map(Number);
  return !reminderFits(day, hour * 60 + minute, leadMinutes, now, timeZone);
}

export function pickTimeFor(day: string, now: number, timeZone = appTimeZone()) {
  return day === dayKeyAt(new Date(now), timeZone) ? (reminderTimeFor(day, 0, now, timeZone) ?? clock(MORNING.hour * 60 + MORNING.minute)) : clock(MORNING.hour * 60 + MORNING.minute);
}

export function reminderBlockText(block: "past" | "lead", leadMinutes: number) {
  if (block === "past") return "That day has passed. Move the task to today or later first, then set the reminder.";
  return leadMinutes > 0 ? "Too late for this reminder on that day. Choose a shorter one or remove it." : "No time is left that day. Move the task to a later day first.";
}
