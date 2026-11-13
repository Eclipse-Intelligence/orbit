import { bankHolidays, christmasBreak, dayParts, shiftDay, wallClockAt, weekday } from "@/lib/crm/working-days";
import { appTimeZone } from "@/lib/time";

export type WorkingDay = { works: boolean; start: number; end: number };

export type WorkingHours = WorkingDay[];

export const WORKING_HOURS_STEP = 15;
export const DAY_LENGTH_MINUTES = 24 * 60;
export const DEFAULT_START_MINUTES = 9 * 60;
export const DEFAULT_END_MINUTES = 17 * 60 + 30;

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const SETTINGS_WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

export const DEFAULT_WORKING_HOURS: WorkingHours = WEEKDAY_NAMES.map((_, day) => ({
  works: day >= 1 && day <= 5,
  start: DEFAULT_START_MINUTES,
  end: DEFAULT_END_MINUTES,
}));

export const WORKING_HOURS_INVALID = "Each working day needs a start before its finish, on the quarter hour.";

function minuteValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= DAY_LENGTH_MINUTES && value % WORKING_HOURS_STEP === 0;
}

export function readWorkingHours(raw: unknown): WorkingHours | null {
  if (!Array.isArray(raw) || raw.length !== 7) return null;
  const days: WorkingHours = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { works, start, end } = entry as Record<string, unknown>;
    if (typeof works !== "boolean" || !minuteValue(start) || !minuteValue(end)) return null;
    if ((start as number) >= (end as number)) return null;
    days.push({ works, start: start as number, end: end as number });
  }
  return days;
}

export function sameWorkingHours(left: WorkingHours, right: WorkingHours) {
  return left.every((day, index) => day.works === right[index]?.works && day.start === right[index]?.start && day.end === right[index]?.end);
}

export function clockText(minutes: number) {
  const total = Math.max(0, Math.min(DAY_LENGTH_MINUTES, Math.round(minutes)));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function workingDay(hours: WorkingHours, key: string): WorkingDay {
  return hours[weekday(key)] ?? DEFAULT_WORKING_HOURS[weekday(key)];
}

function shortDay(key: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${key}T12:00:00Z`))
    .replace(",", "");
}

export function offDayReason(key: string, hours: WorkingHours) {
  if (christmasBreak(key)) return "over Christmas";
  if (bankHolidays(dayParts(key).year).has(key)) return "a bank holiday";
  if (!workingDay(hours, key).works) return "outside your working days";
  return null;
}

export function offDayText(key: string, hours: WorkingHours) {
  const reason = offDayReason(key, hours);
  if (!reason) return null;
  return reason === "outside your working days" ? `${shortDay(key)} is outside your working days` : `${shortDay(key)} is ${reason}`;
}

export function wallAt(key: string, minutes: number, timeZone = appTimeZone()) {
  if (minutes >= DAY_LENGTH_MINUTES) return wallClockAt(shiftDay(key, 1), 0, 0, timeZone);
  return wallClockAt(key, Math.floor(minutes / 60), minutes % 60, timeZone);
}

export function workingWindow(key: string, hours: WorkingHours, timeZone = appTimeZone()) {
  if (offDayReason(key, hours)) return null;
  const day = workingDay(hours, key);
  return { open: wallAt(key, day.start, timeZone), close: wallAt(key, day.end, timeZone) };
}

export function nextWorkableDay(key: string, hours: WorkingHours, limit = 60) {
  let next = shiftDay(key, 1);
  for (let guard = 0; guard < limit && offDayReason(next, hours); guard += 1) next = shiftDay(next, 1);
  return offDayReason(next, hours) ? null : next;
}

export function firstWorkableDay(key: string, hours: WorkingHours, limit = 60) {
  return offDayReason(key, hours) ? nextWorkableDay(key, hours, limit) : key;
}

export function hoursText(day: WorkingDay) {
  return `${clockText(day.start)} to ${clockText(day.end)}`;
}
