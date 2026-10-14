import type { Activity } from "@/lib/crm/types";
import { appTimeZone, zonedParts } from "@/lib/time";

export const TIMELINE_KINDS = ["call", "email", "meeting", "note"] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export type TimelineFilter = "all" | TimelineKind;

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const CALL_BODY = /^(Outgoing|Incoming) call · (.+)$/;

type TimelineActivity = Pick<Activity, "type" | "title" | "body" | "metadata">;

export function timelineKind(
  activity: Pick<Activity, "type">,
): TimelineKind | null {
  return (TIMELINE_KINDS as readonly string[]).includes(activity.type)
    ? (activity.type as TimelineKind)
    : null;
}

export function countKinds(activities: Pick<Activity, "type">[]) {
  const counts: Record<TimelineFilter, number> = {
    all: activities.length,
    call: 0,
    email: 0,
    meeting: 0,
    note: 0,
  };
  for (const activity of activities) {
    const kind = timelineKind(activity);
    if (kind) counts[kind] += 1;
  }
  return counts;
}

function calendarDay(iso: string, timeZone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedParts(date, timeZone);
  return {
    ...parts,
    serial: Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS,
  };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function dayKey(iso: string, timeZone = appTimeZone()) {
  const day = calendarDay(iso, timeZone);
  return day ? `${day.year}-${pad(day.month)}-${pad(day.day)}` : "unknown";
}

export function dayLabel(
  iso: string,
  now = Date.now(),
  timeZone = appTimeZone(),
) {
  const day = calendarDay(iso, timeZone);
  if (!day) return "No date";
  const today = calendarDay(new Date(now).toISOString(), timeZone)!;
  if (day.serial === today.serial) return "Today";
  if (day.serial === today.serial - 1) return "Yesterday";
  const weekday = WEEKDAYS[new Date(day.serial * DAY_MS).getUTCDay()];
  const label = `${weekday} ${day.day} ${MONTHS[day.month - 1]}`;
  return day.year === today.year ? label : `${label} ${day.year}`;
}

export function activityWhen(
  iso: string,
  now = Date.now(),
  timeZone = appTimeZone(),
) {
  const day = calendarDay(iso, timeZone);
  if (!day) return "No date";
  return `${dayLabel(iso, now, timeZone)}, ${pad(day.hour)}:${pad(day.minute)}`;
}

export function groupByDay<T extends Pick<Activity, "occurredAt">>(
  items: T[],
  now = Date.now(),
  timeZone = appTimeZone(),
) {
  const sorted = items
    .map((item, index) => ({
      item,
      index,
      time: new Date(item.occurredAt).getTime() || 0,
    }))
    .sort((a, b) => b.time - a.time || a.index - b.index);
  const groups: { key: string; label: string; items: T[] }[] = [];
  for (const { item } of sorted) {
    const key = dayKey(item.occurredAt, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      groups.push({
        key,
        label: dayLabel(item.occurredAt, now, timeZone),
        items: [item],
      });
    }
  }
  return groups;
}

export function formatCallDuration(seconds: number | null | undefined) {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (rest || parts.length === 0) parts.push(`${rest} s`);
  return parts.join(" ");
}

const FALLBACK_TITLES: Record<string, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  note: "Note",
  research: "Research",
  linkedin: "LinkedIn",
  agent_update: "Agent update",
  other: "Activity",
};

export function activityTitle(activity: TimelineActivity) {
  const title = activity.title?.trim();
  if (title) return title;
  if (activity.type === "note" || activity.type === "call") {
    const line = activity.body?.split("\n").find((text) => text.trim() !== "");
    if (line && !CALL_BODY.test(line.trim())) return line.trim();
  }
  return FALLBACK_TITLES[activity.type] ?? "Activity";
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function activityDirection(
  activity: Pick<Activity, "type" | "body" | "metadata">,
) {
  const direction = activity.metadata.direction;
  if (activity.type === "call") {
    if (direction === "outbound") return "Outgoing";
    if (direction === "inbound") return "Incoming";
    return CALL_BODY.exec(activity.body?.trim() ?? "")?.[1] ?? null;
  }
  if (activity.type === "email") {
    if (direction === "outbound") return "Sent";
    if (direction === "inbound" || activity.metadata.source === "microsoft")
      return "Received";
  }
  return null;
}

export function callDuration(activity: TimelineActivity) {
  if (activity.type !== "call") return null;
  const seconds = activity.metadata.durationSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return formatCallDuration(seconds);
  }
  return CALL_BODY.exec(activity.body?.trim() ?? "")?.[2] ?? null;
}

export function activitySource(activity: TimelineActivity) {
  const source = activity.metadata.source;
  if (source === "microsoft_teams") return "Teams";
  if (source === "granola") return "Granola";
  return null;
}

export function granolaUrl(activity: TimelineActivity) {
  const url = text(activity.metadata.externalUrl);
  if (activity.metadata.source !== "granola" || !url) return null;
  return /^https:\/\//.test(url) ? url : null;
}

export function activityDetails(activity: TimelineActivity) {
  let attendees: string | null = null;
  const lines: string[] = [];
  for (const line of (activity.body ?? "").split("\n")) {
    if (activity.type === "meeting" && line.startsWith("Attendees: ")) {
      attendees = text(line.slice("Attendees: ".length));
      continue;
    }
    if (activity.type === "meeting" && line.startsWith("Open in Granola: "))
      continue;
    lines.push(line);
  }
  let body = lines.join("\n").trim() || null;
  if (activity.type === "meeting" && body === "Meeting recorded in Granola")
    body = null;
  if (activity.type === "call" && body && CALL_BODY.test(body)) body = null;
  if (body && !activity.title?.trim() && body === activityTitle(activity)) {
    body = null;
  }
  const participants = activity.metadata.participants;
  if (
    !attendees &&
    activity.type === "meeting" &&
    Array.isArray(participants)
  ) {
    attendees = participants.map(text).filter(Boolean).join(", ") || null;
  }
  return { attendees, body };
}

export function activityByline(
  activity: Pick<
    Activity,
    "type" | "actorName" | "actorUserId" | "contactName" | "metadata"
  >,
  viewerId?: string | null,
) {
  const actor =
    text(activity.actorName) ??
    (viewerId && activity.actorUserId === viewerId ? "You" : null);
  if (
    activity.type === "email" &&
    activityDirection({ ...activity, body: null }) === "Received"
  ) {
    const from = text(activity.contactName) ?? text(activity.metadata.from);
    return from ? `from ${from}` : null;
  }
  if (!actor) return null;
  if (activity.type === "meeting" && activity.metadata.source === "granola") {
    return `recorded by ${actor}`;
  }
  return `by ${actor}`;
}
