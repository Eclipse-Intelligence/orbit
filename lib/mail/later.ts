import { appTimeZone, zonedParts, zonedTimeToDate } from "@/lib/time";

export type LaterOption = { id: string; label: string; detail: string; at: string };

const DAY_MS = 86_400_000;

function wallAt(nowMs: number, timeZone: string, addDays: number, hour: number) {
  const parts = zonedParts(new Date(nowMs), timeZone);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + addDays * DAY_MS);
  return zonedTimeToDate(
    { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute: 0, second: 0 },
    timeZone,
  );
}

export function laterDetail(at: Date | string, nowMs: number, timeZone = appTimeZone()) {
  const date = new Date(at);
  const sameWeek = date.getTime() - nowMs < 6 * DAY_MS;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    ...(sameWeek ? {} : { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

export function laterOptions(nowMs: number, timeZone = appTimeZone()): LaterOption[] {
  const parts = zonedParts(new Date(nowMs), timeZone);
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const options: { id: string; label: string; at: Date }[] = [];
  const later = new Date(Math.ceil((nowMs + 3 * 3_600_000) / 3_600_000) * 3_600_000);
  const laterParts = zonedParts(later, timeZone);
  if (laterParts.day === parts.day && laterParts.hour <= 21) options.push({ id: "later", label: "Later today", at: later });
  if (parts.hour < 17) options.push({ id: "evening", label: "This evening", at: wallAt(nowMs, timeZone, 0, 18) });
  options.push({ id: "tomorrow", label: "Tomorrow", at: wallAt(nowMs, timeZone, 1, 8) });
  if (weekday >= 1 && weekday <= 5) options.push({ id: "weekend", label: "This weekend", at: wallAt(nowMs, timeZone, 6 - weekday, 9) });
  options.push({ id: "next-week", label: "Next week", at: wallAt(nowMs, timeZone, (8 - weekday) % 7 || 7, 8) });
  return options.map((option) => ({ id: option.id, label: option.label, detail: laterDetail(option.at, nowMs, timeZone), at: option.at.toISOString() }));
}
