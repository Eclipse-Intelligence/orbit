import { resolveZone } from "@/lib/ical/parse";
import { canonicalEmail } from "@/lib/crm/normalize";
import { sanitizeMicrosoftError } from "@/lib/microsoft/oauth";
import { parseDateTime, zonedParts } from "@/lib/time";

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
const CALENDAR_PAGE_LIMIT = 5;
const SHOW_AS = new Set(["free", "tentative", "busy", "oof", "workingelsewhere", "unknown"]);

const CALENDAR_PALETTE = [
  "#4f9be8",
  "#5fb760",
  "#f0913a",
  "#a77de8",
  "#3fb7b0",
  "#e46aa6",
  "#e3c440",
  "#e5584f",
];

const NAMED_COLORS: Record<string, string> = {
  lightblue: "#4f9be8",
  lightgreen: "#5fb760",
  lightorange: "#f0913a",
  lightgray: "#9aa1ab",
  lightyellow: "#e3c440",
  lightteal: "#3fb7b0",
  lightpink: "#e46aa6",
  lightbrown: "#b0835a",
  lightred: "#e5584f",
};

const CALENDAR_FIELDS = ["id", "name", "color", "hexColor", "isDefaultCalendar", "canEdit", "owner"].join(",");

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
  "showAs",
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
  showAs?: string | null;
};

type GraphCalendar = {
  id?: string | null;
  name?: string | null;
  color?: string | null;
  hexColor?: string | null;
  isDefaultCalendar?: boolean | null;
  canEdit?: boolean | null;
  owner?: { name?: string | null; address?: string | null } | null;
};

export type CalendarInfo = {
  providerCalendarId: string;
  name: string;
  color: string;
  colorExplicit: boolean;
  isDefault: boolean;
  canEdit: boolean;
  ownerEmail: string | null;
};

export type CalendarListFetch = { calendars: CalendarInfo[]; complete: boolean };

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
  showAs: string | null;
};

export type CalendarFetch = { events: CalendarEvent[]; complete: boolean; pages: number };

export class CalendarScopeError extends Error {
  constructor() {
    super("Microsoft has not allowed calendar access for this connection.");
    this.name = "CalendarScopeError";
  }
}

function explicitCalendarColor(calendar: Pick<GraphCalendar, "hexColor" | "color">) {
  const hex = calendar.hexColor?.trim().toLowerCase() ?? "";
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  return NAMED_COLORS[calendar.color?.trim().toLowerCase() ?? ""] ?? null;
}

export function paletteColor(index: number) {
  return CALENDAR_PALETTE[((index % CALENDAR_PALETTE.length) + CALENDAR_PALETTE.length) % CALENDAR_PALETTE.length];
}

export function calendarColor(calendar: Pick<GraphCalendar, "hexColor" | "color">, fallbackIndex = 0) {
  return explicitCalendarColor(calendar) ?? paletteColor(fallbackIndex);
}

export function toCalendarInfo(calendar: GraphCalendar, fallbackIndex = 0): CalendarInfo | null {
  const providerCalendarId = calendar.id?.trim();
  if (!providerCalendarId || providerCalendarId.length > 400) return null;
  return {
    providerCalendarId,
    name: clip(calendar.name, 200) ?? "Calendar",
    color: calendarColor(calendar, fallbackIndex),
    colorExplicit: explicitCalendarColor(calendar) !== null,
    isDefault: Boolean(calendar.isDefaultCalendar),
    canEdit: Boolean(calendar.canEdit),
    ownerEmail: canonicalEmail(calendar.owner?.address ?? ""),
  };
}

function calendarsUrl() {
  const url = new URL("https://graph.microsoft.com/v1.0/me/calendars");
  url.searchParams.set("$top", "100");
  url.searchParams.set("$select", CALENDAR_FIELDS);
  return url.toString();
}

export async function fetchCalendars(
  accessToken: string,
  options: { fetchImpl?: typeof fetch; deadline?: number; colorOffset?: number } = {},
): Promise<CalendarListFetch> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const calendars: CalendarInfo[] = [];
  const seen = new Set<string>();
  let next: string | null = calendarsUrl();
  let pages = 0;
  let complete = true;
  while (next) {
    if (pages >= CALENDAR_PAGE_LIMIT || (options.deadline && options.deadline - Date.now() < PAGE_RESERVE_MS)) {
      complete = false;
      break;
    }
    pages += 1;
    const response = await fetchImpl(next, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw await calendarError(response, "Microsoft could not list the calendars.");
    const body = (await response.json()) as { value?: GraphCalendar[]; "@odata.nextLink"?: string };
    for (const item of body.value ?? []) {
      const calendar = toCalendarInfo(item, (options.colorOffset ?? 0) + calendars.length);
      if (!calendar || seen.has(calendar.providerCalendarId)) continue;
      seen.add(calendar.providerCalendarId);
      calendars.push(calendar);
    }
    next = graphLink(body["@odata.nextLink"]);
    if (body["@odata.nextLink"] && !next) complete = false;
  }
  return { calendars, complete };
}

export function calendarViewUrl(start: Date, end: Date, calendarId?: string | null) {
  const path = calendarId
    ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`
    : "https://graph.microsoft.com/v1.0/me/calendarView";
  const url = new URL(path);
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
  const timeZone = !zone || UTC_NAMES.has(zone.toLowerCase()) ? "UTC" : (resolveZone(zone) ?? "UTC");
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
    showAs: showAs(event.showAs),
  };
}

function showAs(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !SHOW_AS.has(normalized)) return null;
  return normalized === "workingelsewhere" ? "workingElsewhere" : normalized;
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

async function calendarError(response: Response, fallback = "Microsoft could not list the calendar.") {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  const code = body.error?.code ?? "";
  if (response.status === 403 && (!code || SCOPE_ERRORS.has(code))) return new CalendarScopeError();
  if (response.status === 401 || code === "InvalidAuthenticationToken") {
    return new Error("Microsoft rejected the mailbox connection. Connect it again.");
  }
  return new Error(sanitizeMicrosoftError(body.error?.message || fallback));
}

export async function fetchCalendarView(
  accessToken: string,
  window: { start: Date; end: Date },
  options: {
    fetchImpl?: typeof fetch;
    deadline?: number;
    pageLimit?: number;
    calendarId?: string | null;
  } = {},
): Promise<CalendarFetch> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  let next: string | null = calendarViewUrl(window.start, window.end, options.calendarId);
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

const WINDOWS_ZONES: Record<string, string> = {
  "europe/london": "GMT Standard Time",
  "europe/dublin": "GMT Standard Time",
  "europe/lisbon": "GMT Standard Time",
  "europe/paris": "Romance Standard Time",
  "europe/madrid": "Romance Standard Time",
  "europe/brussels": "Romance Standard Time",
  "europe/berlin": "W. Europe Standard Time",
  "europe/amsterdam": "W. Europe Standard Time",
  "europe/rome": "W. Europe Standard Time",
  "america/new_york": "Eastern Standard Time",
  "america/chicago": "Central Standard Time",
  "america/denver": "Mountain Standard Time",
  "america/los_angeles": "Pacific Standard Time",
  "utc": "UTC",
  "etc/utc": "UTC",
};
const RETRY_STATUSES = new Set([502, 503, 504]);
const WRITE_TIMEOUT_MS = 20_000;
export const CALENDAR_WRITE_RECONNECT = "Reconnect Microsoft to send invites.";

export class CalendarWriteScopeError extends Error {
  constructor() {
    super(CALENDAR_WRITE_RECONNECT);
    this.name = "CalendarWriteScopeError";
  }
}

export class CalendarWriteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.name = "CalendarWriteError";
    this.status = status;
    this.code = code;
  }
}

function windowsTimeZone(timeZone: string) {
  return WINDOWS_ZONES[timeZone.trim().toLowerCase()] ?? null;
}

export type InviteGuest = { email: string; name: string | null };

type GraphEventDraft = {
  subject: string;
  body?: { contentType: "HTML"; content: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  attendees: { emailAddress: { address: string; name?: string }; type: "required" }[];
  isOnlineMeeting: false;
  responseRequested: true;
  allowNewTimeProposals: true;
  transactionId: string;
};

function pad(value: number, size = 2) {
  return String(value).padStart(size, "0");
}

function wallClock(instant: Date, timeZone: string) {
  const value = zonedParts(instant, timeZone);
  return `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`;
}

function utcDateTime(instant: Date) {
  return { dateTime: instant.toISOString().slice(0, 19), timeZone: "UTC" };
}

function graphDateTime(instant: Date, timeZone: string) {
  const windows = windowsTimeZone(timeZone);
  if (!windows || windows === "UTC") return utcDateTime(instant);
  const dateTime = wallClock(instant, timeZone);
  const hour = 3_600_000;
  const ambiguous = [instant.getTime() - hour, instant.getTime() + hour].some(
    (at) => wallClock(new Date(at), timeZone) === dateTime,
  );
  if (ambiguous || parseDateTime(dateTime, timeZone)?.getTime() !== instant.getTime()) return null;
  return { dateTime, timeZone: windows };
}

export function graphDateTimes(start: Date, end: Date, timeZone: string) {
  const zonedStart = graphDateTime(start, timeZone);
  const zonedEnd = graphDateTime(end, timeZone);
  if (zonedStart && zonedEnd) return { start: zonedStart, end: zonedEnd };
  return { start: utcDateTime(start), end: utcDateTime(end) };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function inviteBodyHtml(notes: string | null, link: string | null) {
  const parts: string[] = [];
  if (notes) parts.push(`<p>${escapeHtml(notes).replace(/\r\n|\r|\n/g, "<br>")}</p>`);
  if (link) {
    const safe = escapeHtml(link);
    parts.push(`<p>Join: <a href="${safe}">${safe}</a></p>`);
  }
  return parts.length > 0 ? `<div>${parts.join("")}</div>` : null;
}

export function inviteDraft(input: {
  subject: string;
  start: Date;
  end: Date;
  timeZone: string;
  guests: InviteGuest[];
  notes: string | null;
  link: string | null;
  transactionId: string;
}): GraphEventDraft {
  const content = inviteBodyHtml(input.notes, input.link);
  return {
    subject: input.subject,
    ...(content ? { body: { contentType: "HTML" as const, content } } : {}),
    ...graphDateTimes(input.start, input.end, input.timeZone),
    ...(input.link ? { location: { displayName: input.link } } : {}),
    attendees: input.guests.map((guest) => ({
      emailAddress: { address: guest.email, ...(guest.name ? { name: guest.name } : {}) },
      type: "required" as const,
    })),
    isOnlineMeeting: false,
    responseRequested: true,
    allowNewTimeProposals: true,
    transactionId: input.transactionId,
  };
}

function eventsUrl(calendarId?: string | null) {
  return calendarId
    ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`
    : "https://graph.microsoft.com/v1.0/me/events";
}

function retryAfter(response: Response) {
  const raw = response.headers.get("retry-after");
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

async function writeError(response: Response, action: "create" | "cancel" | "move") {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
  const code = body.error?.code ?? "";
  const message = body.error?.message ?? "";
  if (response.status === 401 || code === "InvalidAuthenticationToken") {
    return new CalendarWriteError("Microsoft rejected the mailbox connection. Connect it again.", 401, code);
  }
  if (response.status === 403 && (!code || SCOPE_ERRORS.has(code))) return new CalendarWriteScopeError();
  if (response.status === 403) {
    return new CalendarWriteError(
      "Microsoft didn't let Orbit change this calendar. Check that the mailbox can create meetings in Outlook.",
      403,
      code,
    );
  }
  if (response.status === 429 || code === "TooManyRequests" || code === "ApplicationThrottled") {
    const wait = retryAfter(response);
    return new CalendarWriteError(
      `Microsoft is limiting requests right now. Try again in ${wait ? `${wait} seconds` : "a minute"}.`,
      429,
      code,
    );
  }
  if (action === "cancel" && response.status === 400 && /organi[sz]er/i.test(message)) {
    return new CalendarWriteError(
      "Only the organiser can cancel this meeting. Decline it in Outlook instead.",
      400,
      code,
    );
  }
  if (action === "move" && response.status === 400 && /organi[sz]er/i.test(message)) {
    return new CalendarWriteError("Only the organiser can move this meeting.", 400, code);
  }
  if (response.status === 404 || code === "ErrorItemNotFound") {
    return new CalendarWriteError("Outlook no longer has this meeting.", 404, code);
  }
  const fallback =
    action === "create"
      ? "Microsoft could not create the meeting."
      : action === "move"
        ? "Microsoft could not move the meeting."
        : "Microsoft could not cancel the meeting.";
  return new CalendarWriteError(sanitizeMicrosoftError(message || fallback), response.status, code);
}

async function graphWrite(
  url: string,
  accessToken: string,
  payload: unknown,
  fetchImpl: typeof fetch,
  retry: boolean,
  method: "POST" | "PATCH" = "POST",
) {
  const init = () => ({
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      prefer: 'outlook.timezone="UTC"',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  if (!retry) return fetchImpl(url, init());
  let response: Response;
  try {
    response = await fetchImpl(url, init());
  } catch {
    response = await fetchImpl(url, init());
  }
  if (RETRY_STATUSES.has(response.status)) response = await fetchImpl(url, init());
  return response;
}

export async function createGraphEvent(
  accessToken: string,
  draft: GraphEventDraft,
  options: { calendarId?: string | null; fetchImpl?: typeof fetch } = {},
) {
  const response = await graphWrite(eventsUrl(options.calendarId), accessToken, draft, options.fetchImpl ?? fetch, true);
  if (!response.ok) throw await writeError(response, "create");
  return (await response.json().catch(() => ({}))) as GraphEvent;
}

export async function cancelGraphEvent(
  accessToken: string,
  eventId: string,
  comment: string | null,
  fetchImpl: typeof fetch = fetch,
) {
  const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}/cancel`;
  const response = await graphWrite(url, accessToken, comment ? { comment } : {}, fetchImpl, false);
  if (!response.ok) throw await writeError(response, "cancel");
}

function eventUrl(eventId: string) {
  return `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`;
}

async function readEventBody(accessToken: string, eventId: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${eventUrl(eventId)}?$select=body`, {
    headers: { authorization: `Bearer ${accessToken}`, prefer: 'outlook.body-content-type="html"' },
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  if (!response.ok) throw await writeError(response, "move");
  const event = (await response.json().catch(() => ({}))) as { body?: { contentType?: string; content?: string } };
  const content = event.body?.content ?? "";
  if (!content.trim()) return "";
  return event.body?.contentType?.toLowerCase() === "text" ? `<p>${escapeHtml(content).replace(/\r\n|\r|\n/g, "<br>")}</p>` : content;
}

export async function moveGraphEvent(
  accessToken: string,
  eventId: string,
  input: { start: Date; end: Date; timeZone: string; message: string | null },
  fetchImpl: typeof fetch = fetch,
) {
  const patch: Record<string, unknown> = { ...graphDateTimes(input.start, input.end, input.timeZone) };
  if (input.message) {
    const note = `<p>${escapeHtml(input.message).replace(/\r\n|\r|\n/g, "<br>")}</p>`;
    const current = await readEventBody(accessToken, eventId, fetchImpl);
    const content = /<body[^>]*>/i.test(current) ? current.replace(/<body[^>]*>/i, (tag) => `${tag}${note}`) : `${note}${current}`;
    patch.body = { contentType: "HTML", content };
  }
  const response = await graphWrite(eventUrl(eventId), accessToken, patch, fetchImpl, true, "PATCH");
  if (!response.ok) throw await writeError(response, "move");
  return (await response.json().catch(() => ({}))) as GraphEvent;
}
