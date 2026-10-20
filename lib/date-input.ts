type CalendarDay = { value: string; day: number; inMonth: boolean };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const hours = Math.floor(index / 4);
  const minutes = (index % 4) * 15;
  return `${pad(hours)}:${pad(minutes)}`;
});

export const DEFAULT_TIME = "09:00";

export const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function dateValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDateValue(value: string | null | undefined) {
  const match = value ? DATE_PATTERN.exec(value) : null;
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dateValue(date) === value ? date : null;
}

export function splitDateTime(value: string | null | undefined) {
  const match = value ? DATE_TIME_PATTERN.exec(value) : null;
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!parseDateValue(date)) return null;
  const time = `${match[4]}:${match[5]}`;
  if (Number(match[4]) > 23 || Number(match[5]) > 59) return null;
  return { date, time };
}

export function joinDateTime(date: string, time: string) {
  return `${date}T${time}`;
}

export function monthGrid(year: number, month: number): CalendarDay[][] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const weeks: CalendarDay[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const days: CalendarDay[] = [];
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + week * 7 + index);
      days.push({ value: dateValue(date), day: date.getDate(), inMonth: date.getMonth() === month });
    }
    if (week >= 4 && !days.some((day) => day.inMonth)) break;
    weeks.push(days);
  }
  return weeks;
}

export function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(year, month, 1));
}

export function formatDateLabel(value: string, now = new Date()) {
  const date = parseDateValue(value);
  if (!date) return value;
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  const label = `${part("weekday")} ${part("day")} ${part("month")}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${part("year")}`;
}

export function formatDateTimeLabel(value: string, now = new Date()) {
  const parts = splitDateTime(value);
  if (!parts) return value;
  return `${formatDateLabel(parts.date, now)}, ${parts.time}`;
}

export function nextQuarterHour(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const next = Math.ceil((minutes + 1) / 15) * 15;
  if (next >= 24 * 60) return null;
  return `${pad(Math.floor(next / 60))}:${pad(next % 60)}`;
}

export function quickDates(now = new Date()) {
  const today = dateValue(now);
  const tomorrow = dateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const nextWeek = dateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + toMonday));
  return [
    { label: "Today", value: today },
    { label: "Tomorrow", value: tomorrow },
    { label: "Next Monday", value: nextWeek },
  ];
}
