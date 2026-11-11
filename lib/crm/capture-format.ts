import { appTimeZone } from "@/lib/time";

export const REPLY_AMBER_WORKING_DAYS = 3;

export type CaptureSectionCounts = { approvals: number; followUps: number; replies: number; tasks: number; toFile: number };

export type CaptureSection = keyof CaptureSectionCounts;

const PARTS: { id: keyof CaptureSectionCounts; one: string; many: string }[] = [
  { id: "approvals", one: "approval", many: "approvals" },
  { id: "followUps", one: "follow-up", many: "follow-ups" },
  { id: "replies", one: "reply", many: "replies" },
  { id: "tasks", one: "task", many: "tasks" },
  { id: "toFile", one: "to file", many: "to file" },
];

export function captureSummary(counts: CaptureSectionCounts) {
  return PARTS.filter((part) => counts[part.id] > 0)
    .map((part) => `${counts[part.id]} ${counts[part.id] === 1 ? part.one : part.many}`)
    .join(", ");
}

function dayStamp(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(at);
}

function daysApart(from: Date, to: Date, timeZone: string) {
  return Math.round((Date.parse(dayStamp(to, timeZone)) - Date.parse(dayStamp(from, timeZone))) / 86_400_000);
}

function clock(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(at);
}

export function dayLabel(iso: string, now: number, timeZone = appTimeZone()) {
  const at = new Date(iso);
  const days = daysApart(at, new Date(now), timeZone);
  if (days <= 0) return clock(at, timeZone);
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone }).format(at);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(at);
}

export function agoLabel(iso: string, now: number, timeZone = appTimeZone()) {
  const at = new Date(iso);
  const minutes = Math.max(0, Math.floor((now - at.getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (daysApart(at, new Date(now), timeZone) === 0) return `${Math.floor(minutes / 60)}h ago`;
  return dayLabel(iso, now, timeZone);
}

export function sinceLabel(iso: string, now: number, timeZone = appTimeZone()) {
  const days = daysApart(new Date(iso), new Date(now), timeZone);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function dueLabel(iso: string, now: number, timeZone = appTimeZone()) {
  const at = new Date(iso);
  const days = daysApart(at, new Date(now), timeZone);
  if (days === 1) return "Yesterday";
  if (days > 1) return `${days} days overdue`;
  const time = clock(at, timeZone);
  return time === "00:00" ? "Today" : `Today ${time}`;
}

export function pruneHidden(hidden: Set<string>, present: Iterable<string>, acting: Iterable<string> = []) {
  const keep = new Set([...present, ...acting]);
  const next = new Set([...hidden].filter((id) => keep.has(id)));
  return next.size === hidden.size ? hidden : next;
}

export function pageRequests(offset: number, count: number, size = 200) {
  const requests: { offset: number; limit: number }[] = [];
  for (let done = 0; done < count; done += size) requests.push({ offset: offset + done, limit: Math.min(size, count - done) });
  return requests;
}
