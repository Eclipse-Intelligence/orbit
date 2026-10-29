const ZONE = "Europe/London";

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const TIME = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WEEKDAY_SHORT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });
const WEEKDAY_LONG = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" });
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const DAY_MONTH_LONG = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long" });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });

export function londonDay(value: string | Date) {
  return DAY.format(typeof value === "string" ? new Date(value) : value);
}

export function clockTime(value: string | Date) {
  return TIME.format(typeof value === "string" ? new Date(value) : value);
}

function utcDate(day: string) {
  return new Date(`${day}T12:00:00Z`);
}

export function addDays(day: string, delta: number) {
  const date = utcDate(day);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000);
}

export function shortDay(day: string) {
  return `${WEEKDAY_SHORT.format(utcDate(day))} ${DAY_MONTH.format(utcDate(day))}`;
}

export function longDay(day: string) {
  return `${WEEKDAY_LONG.format(utcDate(day))} ${DAY_MONTH_LONG.format(utcDate(day))}`;
}

export function monthLabel(month: string) {
  return MONTH_YEAR.format(utcDate(`${month}-01`));
}

export function dayName(day: string, today: string) {
  const gap = daysBetween(day, today);
  if (gap === 0) return "Today";
  if (gap === 1) return "Yesterday";
  return WEEKDAY_LONG.format(utcDate(day));
}

export function dayDetail(day: string, today: string) {
  const gap = daysBetween(day, today);
  if (gap === 0 || gap === 1) return shortDay(day);
  return day.slice(0, 4) === today.slice(0, 4) ? DAY_MONTH.format(utcDate(day)) : DAY_MONTH_YEAR.format(utcDate(day));
}

export function whenLabel(iso: string, now: string) {
  const elapsed = new Date(now).getTime() - new Date(iso).getTime();
  if (elapsed < 120_000 && elapsed > -60_000) return "Now";
  const day = londonDay(iso);
  const today = londonDay(now);
  const gap = daysBetween(day, today);
  if (gap === 0) return clockTime(iso);
  if (gap === 1) return "Yesterday";
  if (gap > 1 && gap < 7) return WEEKDAY_SHORT.format(utcDate(day));
  return day.slice(0, 4) === today.slice(0, 4) ? DAY_MONTH.format(utcDate(day)) : DAY_MONTH_YEAR.format(utcDate(day));
}

export function editedLabel(iso: string, now: string) {
  const label = whenLabel(iso, now);
  if (label === "Now") return "Edited just now";
  if (label === "Yesterday") return "Edited yesterday";
  return `Edited ${label}`;
}

export function createdLabel(iso: string, now: string) {
  const day = londonDay(iso);
  const today = londonDay(now);
  return `Created ${day.slice(0, 4) === today.slice(0, 4) ? DAY_MONTH.format(utcDate(day)) : DAY_MONTH_YEAR.format(utcDate(day))}`;
}

export function agoLabel(iso: string, now: string) {
  const minutes = Math.max(0, Math.round((new Date(now).getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = daysBetween(londonDay(iso), londonDay(now));
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return DAY_MONTH.format(utcDate(londonDay(iso)));
}

export function versionDayLabel(iso: string, now: string) {
  const gap = daysBetween(londonDay(iso), londonDay(now));
  if (gap === 0) return "Today";
  if (gap === 1) return "Yesterday";
  const day = londonDay(iso);
  return DAY_MONTH.format(utcDate(day));
}

export function monthGrid(month: string) {
  const first = utcDate(`${month}-01`);
  const lead = (first.getUTCDay() + 6) % 7;
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  const days = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= days; day += 1) cells.push(`${month}-${String(day).padStart(2, "0")}`);
  return cells;
}

export function addMonths(month: string, delta: number) {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + delta;
  const date = new Date(Date.UTC(year, index, 1));
  return date.toISOString().slice(0, 7);
}
