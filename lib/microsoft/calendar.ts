import { canonicalEmail } from "@/lib/crm/normalize";
import { sanitizeMicrosoftError } from "@/lib/microsoft/oauth";
import { isTimeZone, parseDateTime } from "@/lib/time";

const PAGE_SIZE = 100;
const PAGE_LIMIT = 10;
const PAGE_RESERVE_MS = 4_000;
const SCOPE_ERRORS = new Set([
  "ErrorAccessDenied",
  "AccessDenied",
  "ErrorInsufficientPermissionsInAccessToken",
  "Authorization_RequestDenied",
]);
const UTC_NAMES = new Set(["utc", "etc/utc", "gmt", "coordinated universal time", "z"]);

const EVENT_FIELDS = [
  "id",
  "iCalUId",
  "subject",
  "start",
  "end",
  "isAllDay",
  "isCancelled",
  "location",
  "webLink",
  "onlineMeeting",
  "onlineMeetingUrl",
  "organizer",
  "attendees",
].join(",");

type GraphDateTime = { dateTime?: string | null; timeZone?: string | null };
type GraphAddress = { emailAddress?: { name?: string | null; address?: string | null } | null };

export type GraphEvent = {
  id?: string;
  iCalUId?: string | null;
  subject?: string | null;
  start?: GraphDateTime | null;
  end?: GraphDateTime | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  location?: { displayName?: string | null } | null;
  webLink?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  onlineMeetingUrl?: string | null;
  organizer?: GraphAddress | null;
  attendees?: (GraphAddress & { type?: string | null; status?: { response?: string | null } | null })[] | null;
};

export type CalendarPerson = { name: string | null; email: string };
export type CalendarAttendee = CalendarPerson & { response: string | null };

export type CalendarEvent = {
  providerEventId: string;
  icalUid: string | null;
  subject: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  isCancelled: boolean;
  location: string | null;
  webLink: string | null;
  onlineMeetingUrl: string | null;
  organizer: CalendarPerson | null;
  attendees: CalendarAttendee[];
};

export type CalendarFetch = { events: CalendarEvent[]; complete: boolean; pages: number };

export class CalendarScopeError extends Error {
  constructor() {
    super("Microsoft has not allowed calendar access for this connection.");
    this.name = "CalendarScopeError";
  }
}

export function calendarViewUrl(start: Date, end: Date) {
  const url = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
  url.searchParams.set("startDateTime", start.toISOString());
  url.searchParams.set("endDateTime", end.toISOString());
  url.searchParams.set("$top", String(PAGE_SIZE));
  url.searchParams.set("$select", EVENT_FIELDS);
  return url.toString();
}

export function graphInstant(value: GraphDateTime | null | undefined) {
  const raw = value?.dateTime?.trim();
  if (!raw) return null;
  const zone = value?.timeZone?.trim() ?? "";
  const timeZone = !zone || UTC_NAMES.has(zone.toLowerCase()) ? "UTC" : isTimeZone(zone) ? zone : "UTC";
  const date = parseDateTime(raw, timeZone);
  return date ? date.toISOString() : null;
}

function clip(value: string | null | undefined, max: number) {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed ? trimmed.slice(0, max) : null;
}

function person(value: GraphAddress | null | undefined): CalendarPerson | null {
  const email = canonicalEmail(value?.emailAddress?.address ?? "");
  if (!email) return null;
  const name = clip(value?.emailAddress?.name, 200);
  return { name: name && name.toLowerCase() !== email ? name : null, email };
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

export function toCalendarEvent(event: GraphEvent): CalendarEvent | null {
  const providerEventId = event.id?.trim();
  if (!providerEventId || providerEventId.length > 400) return null;
  const startsAt = graphInstant(event.start);
  const endsAt = graphInstant(event.end) ?? startsAt;
  if (!startsAt || !endsAt) return null;
  const seen = new Set<string>();
  const attendees: CalendarAttendee[] = [];
  for (const attendee of event.attendees ?? []) {
    if (attendee?.type === "resource") continue;
    const found = person(attendee);
    if (!found || seen.has(found.email)) continue;
    seen.add(found.email);
    attendees.push({ ...found, response: clip(attendee.status?.response, 40) });
    if (attendees.length >= 500) break;
  }
  return {
    providerEventId,
    icalUid: clip(event.iCalUId, 400),
    subject: clip(event.subject, 500),
    startsAt,
    endsAt: endsAt < startsAt ? startsAt : endsAt,
    isAllDay: Boolean(event.isAllDay),
    isCancelled: Boolean(event.isCancelled),
    location: clip(event.location?.displayName, 500),
    webLink: safeUrl(event.webLink),
    onlineMeetingUrl: safeUrl(event.onlineMeeting?.joinUrl) ?? safeUrl(event.onlineMeetingUrl),
    organizer: person(event.organizer),
    attendees,
  };
}

function graphLink(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "graph.microsoft.com" ? value : null;
  } catch {
    return null;
  }
}

async function calendarError(response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  const code = body.error?.code ?? "";
  if (response.status === 403 && (!code || SCOPE_ERRORS.has(code))) return new CalendarScopeError();
  if (response.status === 401 || code === "InvalidAuthenticationToken") {
    return new Error("Microsoft rejected the mailbox connection. Connect it again.");
  }
  return new Error(sanitizeMicrosoftError(body.error?.message || "Microsoft could not list the calendar."));
}

export async function fetchCalendarView(
  accessToken: string,
  window: { start: Date; end: Date },
  options: { fetchImpl?: typeof fetch; deadline?: number; pageLimit?: number } = {},
): Promise<CalendarFetch> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  let next: string | null = calendarViewUrl(window.start, window.end);
  let pages = 0;
  let complete = true;
  while (next) {
    if (pages >= pageLimit || (options.deadline && options.deadline - Date.now() < PAGE_RESERVE_MS)) {
      complete = false;
      break;
    }
    pages += 1;
    const response = await fetchImpl(next, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        prefer: 'outlook.timezone="UTC"',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw await calendarError(response);
    const body = (await response.json()) as { value?: GraphEvent[]; "@odata.nextLink"?: string };
    for (const item of body.value ?? []) {
      const event = toCalendarEvent(item);
      if (!event || seen.has(event.providerEventId)) continue;
      seen.add(event.providerEventId);
      events.push(event);
    }
    next = graphLink(body["@odata.nextLink"]);
    if (body["@odata.nextLink"] && !next) complete = false;
  }
  return { events, complete, pages };
}
