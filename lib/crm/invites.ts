import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { createActivityInDb } from "@/lib/crm/activities";
import {
  DEFAULT_CALENDAR_PLACEHOLDER,
  linkEvents,
  myAddresses,
  readGrantedScopes,
  readPeople,
  readPerson,
  storeGrantedScopes,
} from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { createContactFromAttendeeInDb } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { currentToken, readStored, storeToken, type StoredConnection } from "@/lib/crm/inbox";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Provenance, UserActor } from "@/lib/crm/types";
import {
  checkMeetingLink,
  guestEmail,
  INVITE_COMMENT_MAX,
  INVITE_GUESTS_MAX,
  INVITE_NOTES_MAX,
  INVITE_TITLE_MAX,
} from "@/lib/invite-rules";
import {
  CALENDAR_WRITE_RECONNECT,
  CalendarWriteError,
  CalendarWriteScopeError,
  cancelGraphEvent,
  createGraphEvent,
  inviteDraft,
  moveGraphEvent,
  toCalendarEvent,
  type CalendarEvent,
  type InviteGuest,
} from "@/lib/microsoft/calendar";
import {
  grantsCalendarWrite,
  microsoftConfigured,
  refreshMicrosoftToken,
  sanitizeMicrosoftError,
  type MicrosoftToken,
} from "@/lib/microsoft/oauth";
import { appTimeZone, dateTimeInputValue, parseDateTime } from "@/lib/time";

export const INVITE_NOT_CONNECTED = "Connect Microsoft in Capture to send invites.";
export const INVITE_RECONNECT = CALENDAR_WRITE_RECONNECT;
const LOCAL_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MIN_DURATION = 5;
const MAX_DURATION = 8 * 60;
const MAX_AHEAD_MS = 2 * 366 * 86_400_000;
const RAW_GUESTS_MAX = 500;
const SAVE_WARNING = "The invite was sent, but Orbit couldn't save it yet. It shows up after the next calendar sync.";

export type InviteSetup = {
  connected: boolean;
  canWriteCalendar: boolean;
  meetingLink: string | null;
  ownEmails: string[];
};

export type InviteInput = {
  title?: unknown;
  startLocal?: unknown;
  durationMinutes?: unknown;
  attendees?: unknown;
  notes?: unknown;
  includeMeetingLink?: unknown;
  contactIds?: unknown;
  transactionId?: unknown;
};

type InviteResult = {
  eventId: string | null;
  providerEventId: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  guests: InviteGuest[];
  loggedOn: number;
  warning: string | null;
};

type CancelResult = { warning: string | null; loggedOn: number };

type InviteOptions = { fetchImpl?: typeof fetch; now?: number };

type ContactMatch = { id: string; email: string; name: string; companyId: string | null };

function invalid(message: string, field: string) {
  return new CrmError("invalid_input", message, 400, { field });
}

function zoneLabel(timeZone: string) {
  return timeZone === "Europe/London" ? "London" : timeZone;
}

export function cleanMeetingLink(value: unknown) {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw invalid("Enter the full link, starting with https://.", "meetingLink");
  }
  const checked = checkMeetingLink(value ?? "");
  if (!checked.ok) throw invalid(checked.error, "meetingLink");
  return checked.link;
}

export async function getMeetingLink(actor: UserActor) {
  return withActor(actor, async (db) => readMeetingLink(db, actor));
}

async function readMeetingLink(db: Db, actor: UserActor) {
  const result = await db.query<{ meeting_link: string | null }>(
    "select meeting_link from crm.profiles where id = $1",
    [actor.userId],
  );
  return result.rows[0]?.meeting_link ?? null;
}

export async function saveMeetingLink(actor: UserActor, value: unknown) {
  const link = cleanMeetingLink(value);
  return withActor(actor, async (db) => {
    const saved = await db.query<{ meeting_link: string | null }>(
      "update crm.profiles set meeting_link = $2 where id = $1 returning meeting_link",
      [actor.userId, link],
    );
    if (!saved.rows[0]) throw new CrmError("not_found", "Profile not found.", 404);
    return saved.rows[0].meeting_link;
  });
}

function isConnected(stored: StoredConnection | null): stored is StoredConnection {
  return Boolean(stored && stored.status === "connected" && stored.refreshTokenCipher);
}

export async function getInviteSetup(actor: UserActor): Promise<InviteSetup> {
  return withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    const meetingLink = await readMeetingLink(db, actor);
    const own = await myAddresses(db, actor);
    const connected = microsoftConfigured() && isConnected(stored);
    const scopes = connected ? await readGrantedScopes(db, stored!.id) : null;
    return {
      connected,
      canWriteCalendar: connected && grantsCalendarWrite(scopes) !== false,
      meetingLink,
      ownEmails: [...own],
    };
  });
}

export function cleanGuests(values: unknown, own: Set<string>): InviteGuest[] {
  if (!Array.isArray(values) || values.length === 0) throw invalid("Add at least one guest.", "attendees");
  if (values.length > RAW_GUESTS_MAX) {
    throw invalid(`Invite up to ${INVITE_GUESTS_MAX} guests at a time.`, "attendees");
  }
  const guests = new Map<string, InviteGuest>();
  let skippedOwn = false;
  for (const value of values) {
    const item =
      typeof value === "string"
        ? { email: value }
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
    const raw = typeof item.email === "string" ? item.email : "";
    const email = guestEmail(raw);
    if (!email) {
      const shown = raw.trim().slice(0, 80);
      throw invalid(shown ? `“${shown}” isn't a valid email address.` : "Every guest needs an email address.", "attendees");
    }
    if (own.has(email)) {
      skippedOwn = true;
      continue;
    }
    if (guests.has(email)) continue;
    const name = typeof item.name === "string" ? item.name.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    guests.set(email, { email, name: name && guestEmail(name) !== email ? name : null });
  }
  if (guests.size === 0) {
    throw invalid(
      skippedOwn ? "You're the organiser, so invite someone other than yourself." : "Add at least one guest.",
      "attendees",
    );
  }
  if (guests.size > INVITE_GUESTS_MAX) {
    throw invalid(`Invite up to ${INVITE_GUESTS_MAX} guests at a time.`, "attendees");
  }
  return [...guests.values()];
}

export function inviteWindow(
  startLocal: unknown,
  durationMinutes: unknown,
  options: { timeZone?: string; now?: number } = {},
) {
  const timeZone = options.timeZone ?? appTimeZone();
  const now = options.now ?? Date.now();
  if (typeof startLocal !== "string" || !LOCAL_START.test(startLocal)) {
    throw invalid("Pick a date and start time.", "startLocal");
  }
  const start = parseDateTime(startLocal, timeZone);
  if (!start) throw invalid("Pick a date and start time.", "startLocal");
  if (dateTimeInputValue(start.toISOString(), timeZone) !== startLocal) {
    throw invalid(
      `${startLocal.slice(11)} doesn't exist in ${zoneLabel(timeZone)} that day because the clocks go forward. Pick another time.`,
      "startLocal",
    );
  }
  if (start.getTime() <= now) throw invalid("Pick a start time in the future.", "startLocal");
  if (start.getTime() > now + MAX_AHEAD_MS) throw invalid("Pick a date within the next two years.", "startLocal");
  const duration = typeof durationMinutes === "string" ? Number(durationMinutes) : durationMinutes;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < MIN_DURATION ||
    duration > MAX_DURATION
  ) {
    throw invalid("Pick a duration between 5 minutes and 8 hours.", "durationMinutes");
  }
  return { start, end: new Date(start.getTime() + duration * 60_000), durationMinutes: duration, timeZone };
}

function cleanTitle(value: unknown) {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!title) throw invalid("Add a title.", "title");
  if (title.length > INVITE_TITLE_MAX) {
    throw invalid(`Keep the title under ${INVITE_TITLE_MAX} characters.`, "title");
  }
  return title;
}

function cleanNotes(value: unknown, max: number, field: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid("Notes must be text.", field);
  const notes = value.replace(/\r\n?/g, "\n").trim();
  if (notes.length > max) throw invalid(`Keep this under ${max} characters.`, field);
  return notes || null;
}

function cleanContactIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && isUuid(item)))].slice(
    0,
    INVITE_GUESTS_MAX,
  );
}

function formatWhen(start: Date, end: Date, timeZone: string) {
  const day = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone,
    }).format(date);
  const time = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
  const range =
    day(start) === day(end)
      ? `${day(start)}, ${time(start)} to ${time(end)}`
      : `${day(start)} ${time(start)} to ${day(end)} ${time(end)}`;
  return `${range} ${zoneLabel(timeZone)} time`;
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function writeFailure(error: unknown): CrmError {
  if (error instanceof CrmError) return error;
  if (error instanceof CalendarWriteScopeError) return new CrmError("scope_missing", INVITE_RECONNECT, 403);
  if (error instanceof CalendarWriteError) {
    if (error.status === 429) return new CrmError("rate_limited", error.message, 429);
    if (error.status === 400 || error.status === 404) return new CrmError("invalid_input", error.message, 400);
    return new CrmError("upstream_error", error.message, 502);
  }
  return new CrmError(
    "upstream_error",
    sanitizeMicrosoftError(error instanceof Error ? error.message : "Could not reach Microsoft."),
    502,
  );
}

async function writableToken(
  actor: UserActor,
  stored: StoredConnection,
  scopes: string | null,
  fetchImpl: typeof fetch,
): Promise<MicrosoftToken> {
  if (grantsCalendarWrite(scopes) === false) throw new CrmError("scope_missing", INVITE_RECONNECT, 403);
  let token: MicrosoftToken;
  let refreshed: boolean;
  try {
    token = await currentToken(stored, fetchImpl);
    refreshed = token.expiresAt !== stored.accessTokenExpiresAt;
    if (!token.scope && scopes === null) {
      token = await refreshMicrosoftToken(token.refreshToken, fetchImpl);
      refreshed = true;
    }
  } catch (error) {
    throw writeFailure(error);
  }
  if (refreshed) {
    await withActor(actor, async (db) => {
      await storeToken(db, stored.id, token);
      if (token.scope) await storeGrantedScopes(db, actor, stored.id, token.scope);
    });
  }
  if (grantsCalendarWrite(token.scope ?? scopes) === false) {
    throw new CrmError("scope_missing", INVITE_RECONNECT, 403);
  }
  return token;
}

async function defaultCalendar(db: Db, connectionId: string) {
  const result = await db.query<{ id: string; provider_calendar_id: string }>(
    `select id, provider_calendar_id from crm.calendars
     where connection_id = $1 and is_default
     order by (provider_calendar_id = $2) asc, id
     limit 1`,
    [connectionId, DEFAULT_CALENDAR_PLACEHOLDER],
  );
  return result.rows[0] ?? null;
}

async function ensureDefaultCalendar(db: Db, actor: UserActor, connectionId: string) {
  const found = await defaultCalendar(db, connectionId);
  if (found) return found.id;
  const created = await db.query<{ id: string }>(
    `insert into crm.calendars (
       workspace_id, user_id, connection_id, provider_calendar_id, name, color,
       is_default, is_visible, use_for_crm, can_edit
     ) values ($1, $2, $3, $4, 'Calendar', '#4f9be8', true, true, true, true)
     on conflict (user_id, coalesce(account_id, connection_id), provider_calendar_id) do update set
       is_default = true
     returning id`,
    [actor.workspaceId, actor.userId, connectionId, DEFAULT_CALENDAR_PLACEHOLDER],
  );
  return created.rows[0].id;
}

async function matchContacts(db: Db, actor: UserActor, emails: string[], preferred: string[]) {
  if (emails.length === 0) return [];
  const result = await db.query<{ id: string; email: string; name: string; company_id: string | null }>(
    `select id, normalized_email as email, company_id,
            coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) as name
     from crm.contacts
     where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])
     order by created_at, id`,
    [actor.workspaceId, emails],
  );
  const wanted = new Set(preferred);
  const chosen = new Map<string, ContactMatch>();
  for (const row of result.rows) {
    const current = chosen.get(row.email);
    if (current && (wanted.has(current.id) || !wanted.has(row.id))) continue;
    chosen.set(row.email, { id: row.id, email: row.email, name: row.name, companyId: row.company_id });
  }
  return emails.map((email) => chosen.get(email)).filter((match): match is ContactMatch => Boolean(match));
}

function fallbackEvent(
  id: string,
  created: { iCalUId?: string | null },
  values: {
    subject: string;
    start: Date;
    end: Date;
    link: string | null;
    organizer: { name: string | null; email: string };
    guests: InviteGuest[];
  },
): CalendarEvent {
  return {
    providerEventId: id,
    icalUid: created.iCalUId?.slice(0, 400) ?? null,
    subject: values.subject,
    startsAt: values.start.toISOString(),
    endsAt: values.end.toISOString(),
    isAllDay: false,
    isCancelled: false,
    location: values.link,
    webLink: null,
    onlineMeetingUrl: null,
    organizer: values.organizer,
    attendees: values.guests.map((guest) => ({ ...guest, response: "none" })),
    showAs: "busy",
  };
}

async function saveCreatedEvent(
  db: Db,
  actor: UserActor,
  calendarId: string,
  connectionId: string,
  event: CalendarEvent,
) {
  const result = await db.query<{ id: string }>(
    `insert into crm.calendar_events (
       workspace_id, calendar_id, connection_id, user_id, provider_event_id, ical_uid,
       subject, starts_at, ends_at, is_all_day, is_cancelled, location, web_link,
       online_meeting_url, organizer, attendees, show_as, created_by_orbit
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, true)
     on conflict (calendar_id, provider_event_id) do update set
       ical_uid = excluded.ical_uid,
       subject = excluded.subject,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       is_cancelled = excluded.is_cancelled,
       location = excluded.location,
       web_link = excluded.web_link,
       organizer = excluded.organizer,
       attendees = excluded.attendees,
       show_as = excluded.show_as,
       created_by_orbit = true
     returning id`,
    [
      actor.workspaceId,
      calendarId,
      connectionId,
      actor.userId,
      event.providerEventId,
      event.icalUid,
      event.subject,
      event.startsAt,
      event.endsAt,
      event.isAllDay,
      event.isCancelled,
      event.location,
      event.webLink,
      event.onlineMeetingUrl,
      JSON.stringify(event.organizer),
      JSON.stringify(event.attendees),
      event.showAs,
    ],
  );
  return result.rows[0].id;
}

type InviteSender = {
  stored: StoredConnection;
  own: Set<string>;
  meetingLink: string | null;
  scopes: string | null;
  calendar: { id: string; provider_calendar_id: string } | null;
};

type OpenInviteSender = InviteSender & { token: MicrosoftToken; calendarId: string | null };

type InviteActivity = (
  contact: { id: string; name: string; companyId: string | null },
  details: {
    eventId: string;
    providerEventId: string;
    startsAt: string;
    when: string;
    subject: string;
    link: string | null;
    notes: string | null;
  },
) => { title: string; body: string; metadata: Record<string, unknown> };

type InviteSend = {
  subject: string;
  start: Date;
  end: Date;
  timeZone: string;
  guests: InviteGuest[];
  notes: string | null;
  link: string | null;
  transactionId: string;
  contactIds?: string[];
  createContacts?: boolean;
  activity?: InviteActivity;
  provenance?: Provenance;
  fetchImpl?: typeof fetch;
};

async function loadInviteSender(actor: UserActor): Promise<InviteSender> {
  const prepared = await withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    return {
      stored,
      own: await myAddresses(db, actor),
      meetingLink: await readMeetingLink(db, actor),
      scopes: stored ? await readGrantedScopes(db, stored.id) : null,
      calendar: stored ? await defaultCalendar(db, stored.id) : null,
    };
  });
  const stored = prepared.stored;
  if (!isConnected(stored)) throw new CrmError("not_connected", INVITE_NOT_CONNECTED, 400);
  return { ...prepared, stored };
}

function providerCalendarId(calendar: InviteSender["calendar"]) {
  return calendar && calendar.provider_calendar_id !== DEFAULT_CALENDAR_PLACEHOLDER
    ? calendar.provider_calendar_id
    : null;
}

export async function openInviteSender(
  actor: UserActor,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<OpenInviteSender> {
  assertScope(actor.scopes, "activities:write");
  if (!microsoftConfigured()) throw new CrmError("not_connected", INVITE_NOT_CONNECTED, 400);
  const sender = await loadInviteSender(actor);
  const token = await writableToken(actor, sender.stored, sender.scopes, options.fetchImpl ?? fetch);
  return { ...sender, token, calendarId: providerCalendarId(sender.calendar) };
}

const defaultActivity: InviteActivity = (contact, details) => ({
  title: `Invited ${contact.name} to ${details.subject}`,
  body: [details.when, details.link ? `Join: ${details.link}` : null, details.notes ? `\n${details.notes}` : null]
    .filter(Boolean)
    .join("\n"),
  metadata: {
    source: "orbit",
    kind: "invite",
    eventId: details.eventId,
    providerEventId: details.providerEventId,
    startsAt: details.startsAt,
  },
});

async function ensureGuestContacts(db: Db, actor: UserActor, guests: InviteGuest[], own: string[]) {
  const ids: string[] = [];
  for (const guest of guests) {
    await db.query("savepoint invite_contact");
    try {
      const saved = await createContactFromAttendeeInDb(db, actor, guest, own);
      ids.push(saved.contactId);
      await db.query("release savepoint invite_contact");
    } catch (error) {
      await db.query("rollback to savepoint invite_contact");
      if (!(error instanceof CrmError)) throw error;
    }
  }
  return ids;
}

export async function sendInvite(
  actor: UserActor,
  sender: OpenInviteSender,
  input: InviteSend,
): Promise<InviteResult> {
  assertScope(actor.scopes, "activities:write");
  if (input.createContacts) {
    assertScope(actor.scopes, "contacts:write");
    assertScope(actor.scopes, "companies:write");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const { stored, token } = sender;
  const { subject, guests, notes, link } = input;
  const draft = inviteDraft({
    subject,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone,
    guests,
    notes,
    link,
    transactionId: input.transactionId,
  });
  let created: Awaited<ReturnType<typeof createGraphEvent>>;
  try {
    created = await createGraphEvent(token.accessToken, draft, { calendarId: sender.calendarId, fetchImpl });
  } catch (error) {
    throw writeFailure(error);
  }

  const result: InviteResult = {
    eventId: null,
    providerEventId: typeof created.id === "string" ? created.id : "",
    subject,
    startsAt: input.start.toISOString(),
    endsAt: input.end.toISOString(),
    guests,
    loggedOn: 0,
    warning: null,
  };
  const providerEventId = created.id?.trim();
  if (!providerEventId || providerEventId.length > 400) return { ...result, warning: SAVE_WARNING };
  const parsed = toCalendarEvent(created);
  const event = parsed
    ? { ...parsed, startsAt: input.start.toISOString(), endsAt: input.end.toISOString() }
    : fallbackEvent(providerEventId, created, {
      subject,
      start: input.start,
      end: input.end,
      link,
      organizer: { name: actor.fullName, email: stored.email },
      guests,
    });
  const when = formatWhen(new Date(event.startsAt), new Date(event.endsAt), input.timeZone);
  const activity = input.activity ?? defaultActivity;
  try {
    const saved = await withActor(actor, async (db) => {
      const calendarRow = sender.calendar?.id ?? (await ensureDefaultCalendar(db, actor, stored.id));
      const eventId = await saveCreatedEvent(db, actor, calendarRow, stored.id, event);
      const preferred = [...(input.contactIds ?? [])];
      if (input.createContacts) {
        preferred.push(...(await ensureGuestContacts(db, actor, guests, [stored.email, ...sender.own])));
      }
      await linkEvents(db, actor, [eventId]);
      const contacts = await matchContacts(
        db,
        actor,
        guests.map((guest) => guest.email),
        preferred,
      );
      for (const contact of contacts) {
        const written = activity(contact, {
          eventId,
          providerEventId,
          startsAt: event.startsAt,
          when,
          subject,
          link,
          notes,
        });
        await createActivityInDb(
          db,
          actor,
          {
            type: "meeting",
            title: clip(written.title, 200),
            body: written.body,
            contactId: contact.id,
            companyId: contact.companyId,
            metadata: written.metadata,
          },
          input.provenance ?? { operation: "send_invite", source: "microsoft" },
        );
      }
      return { eventId, loggedOn: contacts.length };
    });
    return { ...result, eventId: saved.eventId, loggedOn: saved.loggedOn };
  } catch (error) {
    console.error("Invite sent but not saved", error);
    return { ...result, warning: SAVE_WARNING };
  }
}

export async function createInvite(
  actor: UserActor,
  input: InviteInput,
  options: InviteOptions = {},
): Promise<InviteResult> {
  assertScope(actor.scopes, "activities:write");
  const fetchImpl = options.fetchImpl ?? fetch;
  const subject = cleanTitle(input.title);
  const window = inviteWindow(input.startLocal, input.durationMinutes, { now: options.now });
  const notes = cleanNotes(input.notes, INVITE_NOTES_MAX, "notes");
  const contactIds = cleanContactIds(input.contactIds);
  const transactionId =
    typeof input.transactionId === "string" && isUuid(input.transactionId) ? input.transactionId : randomUUID();
  if (input.includeMeetingLink !== undefined && typeof input.includeMeetingLink !== "boolean") {
    throw invalid("Choose whether to add the meeting link.", "includeMeetingLink");
  }
  if (!microsoftConfigured()) throw new CrmError("not_connected", INVITE_NOT_CONNECTED, 400);

  const sender = await loadInviteSender(actor);
  const guests = cleanGuests(input.attendees, sender.own);
  if (input.includeMeetingLink === true && !sender.meetingLink) {
    throw invalid("Add your meeting link in Settings › General first.", "includeMeetingLink");
  }
  const link = input.includeMeetingLink === false ? null : sender.meetingLink;
  const token = await writableToken(actor, sender.stored, sender.scopes, fetchImpl);
  return sendInvite(
    actor,
    { ...sender, token, calendarId: providerCalendarId(sender.calendar) },
    {
      subject,
      start: window.start,
      end: window.end,
      timeZone: window.timeZone,
      guests,
      notes,
      link,
      transactionId,
      contactIds,
      fetchImpl,
    },
  );
}

type OrganisedRow = {
  id: string;
  provider_event_id: string;
  connection_id: string | null;
  subject: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  is_all_day: boolean;
  organizer: unknown;
  attendees: unknown;
  contact_ids: string[];
  is_cancelled: boolean;
  created_by_orbit: boolean;
};

const ORGANISER_ONLY = {
  cancel: "Only the organiser can cancel this meeting. Decline it in Outlook instead.",
  move: "Only the organiser can move this meeting. Propose a new time in Outlook instead.",
};

async function organisedEvent(
  actor: UserActor,
  eventId: string,
  verb: "cancel" | "move",
  options: { fetchImpl: typeof fetch; now: number },
) {
  if (!isUuid(eventId)) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  const found = await withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    const event = await db.query<OrganisedRow>(
      `select id, provider_event_id, connection_id, subject, starts_at, ends_at, is_all_day, organizer, attendees,
              contact_ids, is_cancelled, created_by_orbit
       from crm.calendar_events
       where id = $1 and user_id = $2 and workspace_id = $3`,
      [eventId, actor.userId, actor.workspaceId],
    );
    return {
      stored,
      event: event.rows[0] ?? null,
      own: await myAddresses(db, actor),
      scopes: stored ? await readGrantedScopes(db, stored.id) : null,
    };
  });
  const row = found.event;
  if (!row) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  if (row.is_cancelled) {
    throw new CrmError("conflict", verb === "cancel" ? "This meeting is already cancelled." : "This meeting is cancelled.", 409);
  }
  const organizer = readPerson(row.organizer);
  if (!row.created_by_orbit && !(organizer && found.own.has(organizer.email))) {
    throw new CrmError("forbidden", ORGANISER_ONLY[verb], 403);
  }
  if (verb === "move" && row.is_all_day) throw new CrmError("invalid_input", "Move all-day events in Outlook.", 400);
  const startsAt = new Date(row.starts_at);
  if (startsAt.getTime() <= options.now) {
    throw new CrmError("invalid_input", `This meeting has already started, so Orbit can't ${verb} it.`, 400);
  }
  const stored = found.stored;
  if (!microsoftConfigured() || !isConnected(stored)) throw new CrmError("not_connected", INVITE_NOT_CONNECTED, 400);
  if (row.connection_id !== stored.id) {
    throw new CrmError(
      "invalid_input",
      `Orbit can only ${verb} meetings in the calendar of the mailbox connected in Capture.`,
      400,
    );
  }
  const token = await writableToken(actor, stored, found.scopes, options.fetchImpl);
  const guests = [
    ...new Set(
      [organizer, ...readPeople(row.attendees)]
        .map((person) => person?.email)
        .filter((email): email is string => Boolean(email) && !found.own.has(email!)),
    ),
  ];
  return { row, token, guests, startsAt, endsAt: new Date(row.ends_at) };
}

export async function cancelInvite(
  actor: UserActor,
  eventId: string,
  comment?: unknown,
  options: InviteOptions = {},
): Promise<CancelResult> {
  assertScope(actor.scopes, "activities:write");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  if (!isUuid(eventId)) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  const message = cleanNotes(comment, INVITE_COMMENT_MAX, "comment");
  const { row, token, guests, startsAt, endsAt } = await organisedEvent(actor, eventId, "cancel", { fetchImpl, now });
  let warning: string | null = null;
  try {
    await cancelGraphEvent(token.accessToken, row.provider_event_id, message, fetchImpl);
  } catch (error) {
    if (!(error instanceof CalendarWriteError && error.status === 404)) throw writeFailure(error);
    warning = "Outlook had already removed this meeting, so no cancellation was sent.";
  }
  const subject = row.subject ?? "Untitled event";
  const when = formatWhen(startsAt, endsAt, appTimeZone());
  try {
    const loggedOn = await withActor(actor, async (db) => {
      await db.query("update crm.calendar_events set is_cancelled = true where id = $1", [row.id]);
      const contacts = await matchContacts(db, actor, guests, row.contact_ids ?? []);
      for (const contact of contacts) {
        await createActivityInDb(
          db,
          actor,
          {
            type: "meeting",
            title: clip(`Cancelled ${subject}`, 200),
            body: [when, message ? `\nMessage to guests: ${message}` : null].filter(Boolean).join("\n"),
            contactId: contact.id,
            companyId: contact.companyId,
            metadata: { source: "orbit", kind: "cancel", eventId: row.id, startsAt: startsAt.toISOString() },
          },
          { operation: "cancel_invite", source: "microsoft" },
        );
      }
      return contacts.length;
    });
    return { warning, loggedOn };
  } catch (error) {
    console.error("Meeting cancelled but not saved", error);
    return {
      warning: "The meeting was cancelled in Outlook, but Orbit couldn't update it yet. It disappears after the next sync.",
      loggedOn: 0,
    };
  }
}

export type RescheduleInput = {
  eventId?: unknown;
  startLocal?: unknown;
  endLocal?: unknown;
  durationMinutes?: unknown;
  message?: unknown;
};

export type RescheduleResult = {
  eventId: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  previousStartsAt: string;
  previousEndsAt: string;
  guests: string[];
  loggedOn: number;
  warning: string | null;
};

function localInstant(value: unknown, timeZone: string, field: string, missing: string) {
  if (typeof value !== "string" || !LOCAL_START.test(value)) throw invalid(missing, field);
  const instant = parseDateTime(value, timeZone);
  if (!instant) throw invalid(missing, field);
  if (dateTimeInputValue(instant.toISOString(), timeZone) !== value) {
    throw invalid(
      `${value.slice(11)} doesn't exist in ${zoneLabel(timeZone)} that day because the clocks go forward. Pick another time.`,
      field,
    );
  }
  return instant;
}

export function moveWindow(
  input: Pick<RescheduleInput, "startLocal" | "endLocal" | "durationMinutes">,
  currentMinutes: number,
  options: { timeZone?: string; now?: number } = {},
) {
  const timeZone = options.timeZone ?? appTimeZone();
  const hasEnd = input.endLocal !== undefined && input.endLocal !== null && input.endLocal !== "";
  if (!hasEnd) {
    const duration = input.durationMinutes === undefined || input.durationMinutes === null ? currentMinutes : input.durationMinutes;
    return inviteWindow(input.startLocal, duration, { timeZone, now: options.now });
  }
  const start = localInstant(input.startLocal, timeZone, "startLocal", "Pick a date and start time.");
  const end = localInstant(input.endLocal, timeZone, "endLocal", "Pick an end time.");
  if (end.getTime() <= start.getTime()) throw invalid("End the meeting after it starts.", "endLocal");
  const minutes = (end.getTime() - start.getTime()) / 60_000;
  if (minutes < MIN_DURATION || minutes > MAX_DURATION) {
    throw invalid("Pick a duration between 5 minutes and 8 hours.", "endLocal");
  }
  return inviteWindow(input.startLocal, minutes, { timeZone, now: options.now });
}

export async function rescheduleInvite(
  actor: UserActor,
  input: RescheduleInput,
  options: InviteOptions = {},
): Promise<RescheduleResult> {
  assertScope(actor.scopes, "activities:write");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const eventId = typeof input.eventId === "string" ? input.eventId : "";
  if (!isUuid(eventId)) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  const message = cleanNotes(input.message, INVITE_COMMENT_MAX, "message");
  const timeZone = appTimeZone();
  const current = await withActor(actor, async (db) => {
    const result = await db.query<{ starts_at: Date | string; ends_at: Date | string }>(
      "select starts_at, ends_at from crm.calendar_events where id = $1 and user_id = $2 and workspace_id = $3",
      [eventId, actor.userId, actor.workspaceId],
    );
    return result.rows[0] ?? null;
  });
  if (!current) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  const currentMinutes = Math.round((new Date(current.ends_at).getTime() - new Date(current.starts_at).getTime()) / 60_000);
  const window = moveWindow(input, currentMinutes, { timeZone, now });
  if (
    window.start.getTime() === new Date(current.starts_at).getTime() &&
    window.end.getTime() === new Date(current.ends_at).getTime()
  ) {
    throw invalid("That's when the meeting already is. Pick another time.", "startLocal");
  }
  const { row, token, guests, startsAt, endsAt } = await organisedEvent(actor, eventId, "move", { fetchImpl, now });
  let updated: Awaited<ReturnType<typeof moveGraphEvent>>;
  try {
    updated = await moveGraphEvent(
      token.accessToken,
      row.provider_event_id,
      { start: window.start, end: window.end, timeZone, message },
      fetchImpl,
    );
  } catch (error) {
    throw writeFailure(error);
  }
  const subject = row.subject ?? "Untitled event";
  const result: RescheduleResult = {
    eventId: row.id,
    subject,
    startsAt: window.start.toISOString(),
    endsAt: window.end.toISOString(),
    previousStartsAt: startsAt.toISOString(),
    previousEndsAt: endsAt.toISOString(),
    guests,
    loggedOn: 0,
    warning: null,
  };
  const parsed = toCalendarEvent(updated);
  const was = formatWhen(startsAt, endsAt, timeZone);
  const when = formatWhen(window.start, window.end, timeZone);
  try {
    const loggedOn = await withActor(actor, async (db) => {
      await db.query(
        `update crm.calendar_events
         set starts_at = $2, ends_at = $3, attendees = coalesce($4::jsonb, attendees)
         where id = $1`,
        [row.id, result.startsAt, result.endsAt, parsed ? JSON.stringify(parsed.attendees) : null],
      );
      const contacts = await matchContacts(db, actor, guests, row.contact_ids ?? []);
      for (const contact of contacts) {
        await createActivityInDb(
          db,
          actor,
          {
            type: "meeting",
            title: clip(`Moved ${subject}`, 200),
            body: [when, `Was ${was}`, message ? `\nMessage to guests: ${message}` : null].filter(Boolean).join("\n"),
            contactId: contact.id,
            companyId: contact.companyId,
            metadata: {
              source: "orbit",
              kind: "move",
              eventId: row.id,
              startsAt: result.startsAt,
              previousStartsAt: result.previousStartsAt,
            },
          },
          { operation: "reschedule_invite", source: "microsoft" },
        );
      }
      return contacts.length;
    });
    return { ...result, loggedOn };
  } catch (error) {
    console.error("Meeting moved but not saved", error);
    return {
      ...result,
      warning: "The meeting was moved in Outlook, but Orbit couldn't update it yet. It moves after the next sync.",
    };
  }
}
