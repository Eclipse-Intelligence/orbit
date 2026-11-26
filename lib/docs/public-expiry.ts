import { dayKeyIn, zonedTimeToDate } from "@/lib/time";

export const PUBLIC_ZONE = "Europe/London";

export const EXPIRY_PRESETS = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "3m", label: "3 months" },
  { key: "12m", label: "12 months" },
] as const;

export type ExpiryPreset = (typeof EXPIRY_PRESETS)[number]["key"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function dayParts(day: string) {
  const match = DAY.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return { year, month, date };
}

function dayString(time: number) {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export const LAST_EXPIRY_YEAR = 2100;
export const INVALID_EXPIRY_MESSAGE = `Give the date as YYYY-MM-DD, no later than ${LAST_EXPIRY_YEAR}.`;

export function isExpiryDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = dayParts(value);
  return parts !== null && parts.year >= 2000 && parts.year <= LAST_EXPIRY_YEAR;
}

export function publicLive(isPublic: boolean, expiresAt: string | null, now = Date.now()) {
  return isPublic && (expiresAt === null || Date.parse(expiresAt) > now);
}

export function londonToday(now = new Date()) {
  return dayKeyIn(now, PUBLIC_ZONE);
}

export function addDays(day: string, days: number) {
  const parts = dayParts(day)!;
  return dayString(Date.UTC(parts.year, parts.month - 1, parts.date + days));
}

export function addMonths(day: string, months: number) {
  const parts = dayParts(day)!;
  const target = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return dayString(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(parts.date, last)));
}

export function presetDay(preset: ExpiryPreset, now = new Date()) {
  const today = londonToday(now);
  if (preset === "7d") return addDays(today, 7);
  if (preset === "30d") return addDays(today, 30);
  return addMonths(today, preset === "3m" ? 3 : 12);
}

export function endOfDayInstant(day: string) {
  if (!isExpiryDay(day)) throw new RangeError(INVALID_EXPIRY_MESSAGE);
  const next = dayParts(addDays(day, 1))!;
  return zonedTimeToDate({ year: next.year, month: next.month, day: next.date, hour: 0, minute: 0, second: 0 }, PUBLIC_ZONE);
}

export function expiryDayOf(instant: string | Date) {
  const time = typeof instant === "string" ? new Date(instant).getTime() : instant.getTime();
  return dayKeyIn(new Date(time - 1), PUBLIC_ZONE);
}

export function expiryDayLabel(day: string) {
  const parts = dayParts(day)!;
  return `${parts.date} ${MONTHS[parts.month - 1]} ${parts.year}`;
}

export function expiryLabel(instant: string | Date) {
  return expiryDayLabel(expiryDayOf(instant));
}

export function daysLeft(instant: string | Date, now = new Date()) {
  const last = dayParts(expiryDayOf(instant))!;
  const today = dayParts(londonToday(now))!;
  return Math.round((Date.UTC(last.year, last.month - 1, last.date) - Date.UTC(today.year, today.month - 1, today.date)) / DAY_MS);
}

export function availabilityLabel(instant: string | Date, now = new Date()) {
  const left = daysLeft(instant, now);
  if (left <= 0) return "Available until midnight tonight";
  const until = expiryLabel(instant);
  return left === 1 ? `Available for 1 more day, until ${until}` : `Available for ${left} more days, until ${until}`;
}

export function presetOf(instant: string | Date | null, now = new Date()): ExpiryPreset | null {
  if (!instant) return null;
  const day = expiryDayOf(instant);
  return EXPIRY_PRESETS.find((preset) => presetDay(preset.key, now) === day)?.key ?? null;
}

export function isPastDay(day: string, now = new Date()) {
  return day < londonToday(now);
}

export const PAST_EXPIRY_MESSAGE = "That date has passed. Pick today or a later date.";

export function expiryProblem(day: string, now = new Date()) {
  if (dayParts(day) === null) return INVALID_EXPIRY_MESSAGE;
  if (isPastDay(day, now)) return PAST_EXPIRY_MESSAGE;
  return isExpiryDay(day) ? null : INVALID_EXPIRY_MESSAGE;
}
