import { appTimeZone, zonedParts } from "@/lib/time";
import type { DailyEntry } from "@/lib/docs/types";

const ENTRY_LINE = /^(\d{2}:\d{2})(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function isDailyDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

export function localDate(now = new Date(), timeZone = appTimeZone()) {
  const parts = zonedParts(now, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function localTime(now = new Date(), timeZone = appTimeZone()) {
  const parts = zonedParts(now, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function formatDailyEntry(time: string, text: string) {
  return `${time} ${text.replace(/\r\n?/g, "\n").trim()}`;
}

export function appendDailyEntry(content: string, time: string, text: string) {
  const body = content.replace(/\s+$/, "");
  const entry = formatDailyEntry(time, text);
  return body ? `${body}\n\n${entry}` : entry;
}

export function parseDailyEntries(content: string): DailyEntry[] {
  const entries: DailyEntry[] = [];
  for (const line of content.split("\n")) {
    const match = ENTRY_LINE.exec(line);
    if (match) entries.push({ time: match[1], text: match[2] ?? "" });
    else if (entries.length > 0) entries[entries.length - 1].text += `\n${line}`;
  }
  return entries.map((entry) => ({ time: entry.time, text: entry.text.replace(/\s+$/, "") }));
}
