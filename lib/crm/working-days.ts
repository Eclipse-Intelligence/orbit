import { appTimeZone, zonedParts, zonedTimeToDate } from "@/lib/time";

export function dayKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dayParts(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

export function shiftDay(key: string, days: number) {
  const { year, month, day } = dayParts(key);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return dayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function weekday(key: string) {
  const { year, month, day } = dayParts(key);
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
  const { month, day } = dayParts(key);
  return (month === 12 && day >= 24) || (month === 1 && day === 1);
}

export function nonWorkingReason(key: string) {
  const day = weekday(key);
  if (day === 6) return "a Saturday";
  if (day === 0) return "a Sunday";
  if (christmasBreak(key)) return "over Christmas";
  if (bankHolidays(dayParts(key).year).has(key)) return "a bank holiday";
  return null;
}

export function nextWorkingDay(key: string) {
  let next = key;
  for (let guard = 0; guard < 40 && nonWorkingReason(next); guard += 1) next = shiftDay(next, 1);
  return next;
}

export function addWorkingDays(key: string, days: number) {
  let next = key;
  for (let left = days, guard = 0; left > 0 && guard < 400; guard += 1) {
    next = shiftDay(next, 1);
    if (!nonWorkingReason(next)) left -= 1;
  }
  return next;
}

export function dayKeyAt(date: Date, timeZone = appTimeZone()) {
  const wall = zonedParts(date, timeZone);
  return dayKey(wall.year, wall.month, wall.day);
}

export function wallClockAt(key: string, hour: number, minute: number, timeZone = appTimeZone()) {
  return wallClockMs(key, hour, minute, timeZone);
}

export function wallClockMs(key: string, hour: number, minute: number, timeZone: string) {
  const { year, month, day } = dayParts(key);
  return zonedTimeToDate({ year, month, day, hour, minute, second: 0 }, timeZone).getTime();
}
