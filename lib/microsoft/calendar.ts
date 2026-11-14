import { ShownError } from "@/lib/crm/errors";
import { resolveZone } from "@/lib/ical/parse";
import { canonicalEmail } from "@/lib/crm/normalize";
import { clipNotes, eventBodyText, joinLink, safeUrl, type JoinLink } from "@/lib/meeting-links";
import { MICROSOFT_REJECTED, MicrosoftError, microsoftProblem } from "@/lib/microsoft/oauth";
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
const RESPONSE_STATUSES = new Map(
  ["none", "organizer", "tentativelyAccepted", "accepted", "declined", "notResponded"].map((value) => [value.toLowerCase(), value]),
);

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
  "responseStatus",
].join(",");

export const VIEW_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';
const PLAIN_PREFER = 'outlook.timezone="UTC"';

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
  body?: { contentType?: string | null; content?: string | null } | null;
  organizer?: GraphAddress | null;
  attendees?: (GraphAddress & { type?: string | null; status?: { response?: string | null } | null })[] | null;
  showAs?: string | null;
  responseStatus?: { response?: string | null } | null;
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
  privateJoinUrl: string | null;
  notes: string | null;
  organizer: CalendarPerson | null;
  attendees: CalendarAttendee[];
  showAs: string | null;
  responseStatus: string | null;
};

export type CalendarFetch = { events: CalendarEvent[]; complete: boolean; pages: number };

export class CalendarScopeError extends ShownError {
  constructor() {
    super("Reconnect Microsoft to allow calendar access.");
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
    if (!response.ok) throw await calendarError(response, "Couldn't read your calendars. Try again.");
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

export function calendarViewUrl(start: Date, end: Date, calendarId?: string | null, options: { body?: boolean } = {}) {
  const path = calendarId
    ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`
    : "https://graph.microsoft.com/v1.0/me/calendarView";
  const url = new URL(path);
  url.searchParams.set("startDateTime", start.toISOString());
  url.searchParams.set("endDateTime", end.toISOString());
  url.searchParams.set("$top", String(PAGE_SIZE));
  url.searchParams.set("$select", options.body === false ? EVENT_FIELDS : `${EVENT_FIELDS},body`);
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

export function meetingFields(join: JoinLink | null) {
  return {
    onlineMeetingUrl: join && join.source !== "notes" ? join.url : null,
    privateJoinUrl: join?.source === "notes" ? join.url : null,
  };
}

export function toCalendarEvent(event: GraphEvent, options: { ownLink?: string | null } = {}): CalendarEvent | null {
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
  const location = clip(event.location?.displayName, 500);
  const body = eventBodyText(event.body?.content, event.body?.contentType?.toLowerCase() === "html" ? "html" : "text");
  return {
    providerEventId,
    icalUid: clip(event.iCalUId, 400),
    subject: clip(event.subject, 500),
    startsAt,
    endsAt: endsAt < startsAt ? startsAt : endsAt,
    isAllDay: Boolean(event.isAllDay),
    isCancelled: Boolean(event.isCancelled),
    location,
    webLink: safeUrl(event.webLink),
    ...meetingFields(
      joinLink({ provided: [event.onlineMeeting?.joinUrl, event.onlineMeetingUrl], location, notes: body, own: options.ownLink }),
    ),
    notes: clipNotes(body),
    organizer: person(event.organizer),
    attendees,
    showAs: showAs(event.showAs),
    responseStatus: responseStatus(event.responseStatus?.response),
  };
}

export function responseStatus(value: string | null | undefined) {
  return RESPONSE_STATUSES.get(value?.trim().toLowerCase() ?? "") ?? null;
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

async function calendarError(response: Response, fallback = "Couldn't read the calendar. Try again.") {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  const code = body.error?.code ?? "";
  if (response.status === 403 && (!code || SCOPE_ERRORS.has(code))) return new CalendarScopeError();
  if (response.status === 401 || code === "InvalidAuthenticationToken") {
    return new MicrosoftError(MICROSOFT_REJECTED);
  }
  return new MicrosoftError(microsoftProblem(body.error?.message, fallback, code, response.status));
}

export async function fetchCalendarView(
  accessToken: string,
  window: { start: Date; end: Date },
  options: {
    fetchImpl?: typeof fetch;
    deadline?: number;
    pageLimit?: number;
    calendarId?: string | null;
    ownLink?: string | null;
    body?: boolean;
  } = {},
): Promise<CalendarFetch> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  let next: string | null = calendarViewUrl(window.start, window.end, options.calendarId, { body: options.body });
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
        prefer: options.body === false ? PLAIN_PREFER : VIEW_PREFER,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw await calendarError(response);
    const body = (await response.json()) as { value?: GraphEvent[]; "@odata.nextLink"?: string };
    for (const item of body.value ?? []) {
      const event = toCalendarEvent(item, { ownLink: options.ownLink });
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
export const RESPOND_ORGANISER = "You're the organiser.";

export class CalendarWriteScopeError extends ShownError {
  constructor() {
    super(CALENDAR_WRITE_RECONNECT);
    this.name = "CalendarWriteScopeError";
  }
}

export class CalendarWriteError extends ShownError {
  readonly status: number;
  readonly code: string;
  readonly reason: string | null;
  constructor(message: string, status: number, code = "", reason: string | null = null) {
    super(message);
    this.name = "CalendarWriteError";
    this.status = status;
    this.code = code;
    this.reason = reason;
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

type PersonalEventInput = {
  subject: string;
  start: Date;
  end: Date;
  timeZone: string;
  notes: string | null;
  link: string | null;
  transactionId: string;
};

export function holdDraft(input: PersonalEventInput & { sentFrom: string }) {
  return personalDraft({
    ...input,
    notes: [`Invite sent from ${input.sentFrom} by Orbit.`, input.notes].filter(Boolean).join("\n\n"),
  });
}

export function personalDraft(input: PersonalEventInput) {
  const content = inviteBodyHtml(input.notes || null, input.link);
  return {
    subject: input.subject,
    ...(content ? { body: { contentType: "HTML" as const, content } } : {}),
    ...graphDateTimes(input.start, input.end, input.timeZone),
    ...(input.link ? { location: { displayName: input.link } } : {}),
    attendees: [],
    showAs: "busy",
    isReminderOn: true,
    responseRequested: false,
    transactionId: input.transactionId,
  };
}

export const TASK_BLOCK_NOTE = "From Orbit.";

export const TASK_BLOCK_PROPERTY = "String {6f1e3c52-8a4d-4b7e-9c21-5d0a7b3e8f14} Name OrbitTaskBlockKey";

export function taskBlockBodyHtml(link: string | null) {
  if (!link) return `<p>${TASK_BLOCK_NOTE}</p>`;
  return `<p>${TASK_BLOCK_NOTE} <a href="${escapeHtml(link)}">Open the task</a></p>`;
}

export function taskBlockDraft(input: {
  title: string;
  start: Date;
  end: Date;
  timeZone: string;
  link: string | null;
  transactionId: string;
  key: string;
}) {
  return {
    subject: input.title,
    body: { contentType: "HTML" as const, content: taskBlockBodyHtml(input.link) },
    ...graphDateTimes(input.start, input.end, input.timeZone),
    attendees: [],
    showAs: "busy",
    sensitivity: "private",
    isReminderOn: false,
    responseRequested: false,
    transactionId: input.transactionId,
    singleValueExtendedProperties: [{ id: TASK_BLOCK_PROPERTY, value: input.key }],
  };
}

export function taskBlockPatch(input: { title: string; start?: Date; end?: Date; timeZone: string; link: string | null }) {
  return {
    subject: input.title,
    body: { contentType: "HTML" as const, content: taskBlockBodyHtml(input.link) },
    ...(input.start && input.end ? graphDateTimes(input.start, input.end, input.timeZone) : {}),
    showAs: "busy",
    sensitivity: "private",
    isReminderOn: false,
  };
}

export function taskBlockSearchUrl(key: string) {
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${TASK_BLOCK_PROPERTY.replace(/'/g, "''")}' and ep/value eq '${key.replace(/'/g, "''")}')`;
  return `https://graph.microsoft.com/v1.0/me/events?$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent("id,subject,start,end")}&$top=10`;
}

export async function findTaskBlockEvents(accessToken: string, key: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(taskBlockSearchUrl(key), {
    headers: { authorization: `Bearer ${accessToken}`, prefer: PLAIN_PREFER },
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  if (!response.ok) throw await writeError(response, "find");
  const body = (await response.json().catch(() => ({}))) as { value?: GraphEvent[] };
  return (body.value ?? []).filter((event) => Boolean(event.id?.trim()));
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

type WriteAction = "create" | "cancel" | "move" | "respond" | "find";

const WRITE_FALLBACK: Record<WriteAction, string> = {
  create: "Couldn't create the meeting. Try again.",
  cancel: "Couldn't cancel the meeting. Try again.",
  move: "Couldn't move the meeting. Try again.",
  respond: "Couldn't send your response. Try again.",
  find: "Couldn't look up the Outlook block. Try again.",
};

async function writeError(response: Response, action: WriteAction) {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
  const code = body.error?.code ?? "";
  const message = body.error?.message ?? "";
  if (response.status === 401 || code === "InvalidAuthenticationToken") {
    return new CalendarWriteError(MICROSOFT_REJECTED, 401, code);
  }
  if (response.status === 403 && (!code || SCOPE_ERRORS.has(code))) return new CalendarWriteScopeError();
  if (response.status === 403) {
    return new CalendarWriteError(
      "Microsoft blocked the change. Check this mailbox can create meetings.",
      403,
      code,
    );
  }
  if (response.status === 429 || code === "TooManyRequests" || code === "ApplicationThrottled") {
    const wait = retryAfter(response);
    return new CalendarWriteError(
      `Microsoft is busy. Try again in ${wait ? `${wait} seconds` : "a minute"}.`,
      429,
      code,
    );
  }
  if (action === "cancel" && response.status === 400 && /organi[sz]er/i.test(message)) {
    return new CalendarWriteError(
      "Only the organiser can cancel. Decline it instead.",
      400,
      code,
    );
  }
  if (action === "move" && response.status === 400 && /organi[sz]er/i.test(message)) {
    return new CalendarWriteError("Only the organiser can move this meeting.", 400, code);
  }
  if (action === "respond" && response.status === 400 && /propos/i.test(`${code} ${message}`)) {
    return new CalendarWriteError(
      "The organiser isn't accepting new times. Respond without one.",
      400,
      code,
    );
  }
  if (action === "respond" && response.status === 400 && /organi[sz]/i.test(message)) {
    return new CalendarWriteError(RESPOND_ORGANISER, 400, code);
  }
  if (response.status === 404 || code === "ErrorItemNotFound") {
    return new CalendarWriteError("Meeting not found.", 404, code);
  }
  if (action === "create" && response.status === 400 && message.trim()) {
    const reason = message.replace(/\s+/g, " ").trim().slice(0, 200).replace(/[.\s]+$/, "");
    console.error("Microsoft refused the meeting", code, reason);
    return new CalendarWriteError("Couldn't create the meeting.", 400, code, `Microsoft refused the meeting: ${reason}. Change it rather than trying again.`);
  }
  return new CalendarWriteError(microsoftProblem(message, WRITE_FALLBACK[action], code, response.status), response.status, code);
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
  draft: GraphEventDraft | ReturnType<typeof personalDraft> | ReturnType<typeof taskBlockDraft>,
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

export async function deleteGraphEvent(accessToken: string, eventId: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(eventUrl(eventId), {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404) throw await writeError(response, "cancel");
  return response.status !== 404;
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

export async function patchGraphEvent(
  accessToken: string,
  eventId: string,
  patch: ReturnType<typeof taskBlockPatch>,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await graphWrite(eventUrl(eventId), accessToken, patch, fetchImpl, true, "PATCH");
  if (!response.ok) throw await writeError(response, "move");
  return (await response.json().catch(() => ({}))) as GraphEvent;
}

export async function graphEventGone(accessToken: string, eventId: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(`${eventUrl(eventId)}?$select=id`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  if (response.status === 404) return true;
  if (response.ok) return false;
  throw await writeError(response, "move");
}

export type InviteResponse = "accept" | "tentativelyAccept" | "decline";

export const RESPONSE_STATUS_FOR: Record<InviteResponse, string> = {
  accept: "accepted",
  tentativelyAccept: "tentativelyAccepted",
  decline: "declined",
};

export function respondGraphPayload(input: {
  response: InviteResponse;
  comment: string | null;
  sendResponse: boolean;
  proposedNewTime?: { start: Date; end: Date; timeZone: string } | null;
}) {
  const payload: Record<string, unknown> = { sendResponse: input.sendResponse };
  if (input.comment) payload.comment = input.comment;
  if (input.proposedNewTime && input.response !== "accept") {
    payload.proposedNewTime = graphDateTimes(input.proposedNewTime.start, input.proposedNewTime.end, input.proposedNewTime.timeZone);
  }
  return payload;
}

export async function respondToGraphEvent(
  accessToken: string,
  eventId: string,
  input: Parameters<typeof respondGraphPayload>[0],
  fetchImpl: typeof fetch = fetch,
) {
  const url = `${eventUrl(eventId)}/${input.response}`;
  const response = await graphWrite(url, accessToken, respondGraphPayload(input), fetchImpl, false);
  if (!response.ok) throw await writeError(response, "respond");
}
