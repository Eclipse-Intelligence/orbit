import { createHash } from "node:crypto";
import { canonicalEmail } from "@/lib/crm/normalize";
import {
  all,
  first,
  IcsParseError,
  param,
  parseDuration,
  parseIcs,
  parseTimeList,
  parseTimeProperty,
  resolveZone,
  textOf,
  type IcsComponent,
  type IcsTime,
} from "@/lib/ical/parse";
import { expandStarts, instantOf, parseRule } from "@/lib/ical/recurrence";
import type { CalendarAttendee, CalendarEvent, CalendarPerson } from "@/lib/microsoft/calendar";
import { appTimeZone } from "@/lib/time";

const DAY_MS = 86_400_000;
const EVENT_LIMIT = 5000;
const INSTANCE_LIMIT = 1000;
const MEETING_HOSTS =
  /^(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|(?:[\w-]+\.)*zoom\.us|(?:[\w-]+\.)*webex\.com|whereby\.com|meet\.jit\.si|(?:[\w-]+\.)*chime\.aws|meet\.goto\.com|(?:[\w-]+\.)*gotomeeting\.com)$/i;
const URL_PATTERN = /https:\/\/[^\s<>"'\\)\]]+/gi;
const RESPONSES: Record<string, string> = {
  ACCEPTED: "accepted",
  TENTATIVE: "tentativelyAccepted",
  DECLINED: "declined",
  "NEEDS-ACTION": "notResponded",
};

export type FeedCalendar = {
  name: string | null;
  color: string | null;
  events: CalendarEvent[];
  complete: boolean;
};

type Master = {
  component: IcsComponent;
  uid: string;
  start: IcsTime;
};

function clip(value: string | null | undefined, max: number) {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed ? trimmed.slice(0, max) : null;
}

function safeUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function meetingLink(...texts: (string | null | undefined)[]) {
  for (const text of texts) {
    for (const match of text?.matchAll(URL_PATTERN) ?? []) {
      const candidate = safeUrl(match[0].replace(/[.,;:!?]+$/, ""));
      if (candidate && MEETING_HOSTS.test(new URL(candidate).hostname)) return candidate;
    }
  }
  return null;
}

export function feedColor(value: string | null | undefined) {
  const match = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value?.trim() ?? "");
  return match ? `#${match[1].toLowerCase()}` : null;
}

function mailbox(component: IcsComponent, name: string) {
  return all(component, name).map((property) => {
    const fromParam = canonicalEmail(param(property, "EMAIL") ?? "");
    const fromValue = canonicalEmail(property.value.replace(/^mailto:/i, ""));
    const email = fromParam ?? fromValue;
    const label = clip(param(property, "CN"), 200);
    return { property, email, name: label && email && label.toLowerCase() !== email ? label : null };
  });
}

function organizerOf(component: IcsComponent): CalendarPerson | null {
  const found = mailbox(component, "ORGANIZER")[0];
  return found?.email ? { name: found.name, email: found.email } : null;
}

function attendeesOf(component: IcsComponent): CalendarAttendee[] {
  const seen = new Set<string>();
  const attendees: CalendarAttendee[] = [];
  for (const entry of mailbox(component, "ATTENDEE")) {
    const kind = param(entry.property, "CUTYPE")?.toUpperCase();
    if (kind === "RESOURCE" || kind === "ROOM") continue;
    if (!entry.email || seen.has(entry.email)) continue;
    seen.add(entry.email);
    const status = param(entry.property, "PARTSTAT")?.toUpperCase() ?? "";
    attendees.push({ name: entry.name, email: entry.email, response: RESPONSES[status] ?? null });
    if (attendees.length >= 500) break;
  }
  return attendees;
}

function timeKey(time: IcsTime) {
  if (time.allDay) {
    const { year, month, day } = time.wall;
    return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  }
  return new Date(instantOf(time))
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function boundedId(uid: string, suffix: string | null) {
  const full = suffix ? `${uid}/${suffix}` : uid;
  if (full.length <= 400) return full;
  const hashed = createHash("sha256").update(uid).digest("hex").slice(0, 40);
  return suffix ? `${hashed}/${suffix}` : hashed;
}

function durationOf(component: IcsComponent, start: IcsTime, zone: string) {
  const end = parseTimeProperty(first(component, "DTEND"), zone);
  if (end) {
    if (start.allDay) return Math.max(0, instantOf({ ...end, allDay: true }) - instantOf(start)) || DAY_MS;
    return Math.max(0, instantOf(end) - instantOf(start));
  }
  const duration = parseDuration(first(component, "DURATION")?.value);
  if (duration) return Math.max(0, start.allDay ? duration.days * DAY_MS || DAY_MS : duration.ms);
  return start.allDay ? DAY_MS : 0;
}

function toEvent(
  component: IcsComponent,
  ids: { providerEventId: string; icalUid: string },
  startsAt: number,
  durationMs: number,
  allDay: boolean,
): CalendarEvent {
  const status = textOf(component, "STATUS")?.trim().toUpperCase();
  const transparent = textOf(component, "TRANSP")?.trim().toUpperCase() === "TRANSPARENT";
  const location = textOf(component, "LOCATION");
  const description = textOf(component, "DESCRIPTION");
  return {
    providerEventId: ids.providerEventId,
    icalUid: ids.icalUid.slice(0, 400),
    subject: clip(textOf(component, "SUMMARY"), 500),
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + durationMs).toISOString(),
    isAllDay: allDay,
    isCancelled: status === "CANCELLED",
    location: clip(location, 500),
    webLink: safeUrl(textOf(component, "URL")),
    onlineMeetingUrl:
      safeUrl(textOf(component, "X-GOOGLE-CONFERENCE")) ??
      safeUrl(textOf(component, "X-MICROSOFT-SKYPETEAMSMEETINGURL")) ??
      meetingLink(location, description),
    organizer: organizerOf(component),
    attendees: attendeesOf(component),
    showAs: transparent ? "free" : status === "TENTATIVE" ? "tentative" : "busy",
  };
}

export function readFeed(text: string, window: { start: Date; end: Date }): FeedCalendar {
  const calendar = parseIcs(text).find((component) => component.name === "VCALENDAR");
  if (!calendar) throw new IcsParseError("That link didn't return a calendar (iCal) file.");
  const zone = resolveZone(textOf(calendar, "X-WR-TIMEZONE")) ?? appTimeZone();
  const range = { start: window.start.getTime(), end: window.end.getTime() };
  const events = new Map<string, CalendarEvent>();
  const overrides = new Map<string, Set<number>>();
  const masters: Master[] = [];
  let complete = true;

  const add = (event: CalendarEvent) => {
    if (events.has(event.providerEventId)) return;
    if (events.size >= EVENT_LIMIT) {
      complete = false;
      return;
    }
    events.set(event.providerEventId, event);
  };

  for (const component of calendar.components) {
    if (component.name !== "VEVENT") continue;
    const start = parseTimeProperty(first(component, "DTSTART"), zone);
    if (!start) continue;
    const uid =
      clip(textOf(component, "UID"), 1000) ??
      createHash("sha256")
        .update(`${timeKey(start)}|${textOf(component, "SUMMARY") ?? ""}`)
        .digest("hex")
        .slice(0, 40);
    const recurrence = parseTimeProperty(first(component, "RECURRENCE-ID"), start.zone);
    if (recurrence) {
      const key = timeKey(recurrence);
      const instants = overrides.get(uid) ?? new Set<number>();
      instants.add(instantOf(recurrence));
      overrides.set(uid, instants);
      const startsAt = instantOf(start);
      const durationMs = durationOf(component, start, zone);
      if (startsAt < range.end && startsAt + durationMs > range.start) {
        const id = boundedId(uid, key);
        add(toEvent(component, { providerEventId: id, icalUid: id }, startsAt, durationMs, start.allDay));
      }
      continue;
    }
    masters.push({ component, uid, start });
  }

  for (const master of masters) {
    const { component, uid, start } = master;
    const durationMs = durationOf(component, start, zone);
    const ruleText = first(component, "RRULE")?.value;
    const rule = ruleText ? parseRule(ruleText, start) : null;
    const rdates = parseTimeList(all(component, "RDATE"), start.zone);
    if (!rule && rdates.length === 0) {
      const startsAt = instantOf(start);
      if (startsAt < range.end && startsAt + durationMs > range.start) {
        const id = boundedId(uid, null);
        add(toEvent(component, { providerEventId: id, icalUid: uid }, startsAt, durationMs, start.allDay));
      }
      continue;
    }
    const excluded = new Set(parseTimeList(all(component, "EXDATE"), start.zone).map(instantOf));
    const replaced = overrides.get(uid) ?? new Set<number>();
    const expanded = rule
      ? expandStarts(rule, start, range, durationMs, INSTANCE_LIMIT)
      : { starts: [start], truncated: false };
    if (expanded.truncated) complete = false;
    const starts = [...expanded.starts, ...rdates.map((time) => ({ ...time, allDay: start.allDay }))];
    const seen = new Set<number>();
    for (const time of starts) {
      const startsAt = instantOf(time);
      if (seen.has(startsAt) || excluded.has(startsAt) || replaced.has(startsAt)) continue;
      seen.add(startsAt);
      if (startsAt >= range.end || startsAt + durationMs <= range.start) continue;
      const id = boundedId(uid, timeKey(time));
      add(toEvent(component, { providerEventId: id, icalUid: id }, startsAt, durationMs, start.allDay));
    }
  }

  return {
    name: clip(textOf(calendar, "X-WR-CALNAME") ?? textOf(calendar, "NAME"), 200),
    color: feedColor(textOf(calendar, "X-APPLE-CALENDAR-COLOR") ?? textOf(calendar, "COLOR")),
    events: [...events.values()].sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
    complete,
  };
}
