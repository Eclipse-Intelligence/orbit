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
} from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { createContactFromAttendeeInDb } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { readStored, type StoredConnection } from "@/lib/crm/inbox";
import {
  accountEmail,
  assertSenderReady,
  defaultInviteAddress,
  graphSourceFor,
  INVITE_NOT_CONNECTED,
  INVITE_RECONNECT,
  pickInviteSender,
  readInviteSenders,
  rememberInviteSender,
  writableSourceToken,
  type GraphSource,
  type InviteSenderCandidate,
  type InviteSenderOption,
} from "@/lib/crm/invite-senders";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { buildItipMime, inviteUid, type ItipEmail, type ItipEvent } from "@/lib/ical/itip";
import {
  checkMeetingLink,
  guestEmail,
  INVITE_COMMENT_MAX,
  INVITE_GUESTS_MAX,
  INVITE_NOTES_MAX,
  INVITE_TITLE_MAX,
} from "@/lib/invite-rules";
import {
  defaultSentSaver,
  defaultSmtpSender,
  identityForSend,
  noteIdentityError,
  type SendIdentity,
  type SentSaver,
  type SmtpSender,
} from "@/lib/mail/identities";
import {
  CalendarWriteError,
  CalendarWriteScopeError,
  cancelGraphEvent,
  createGraphEvent,
  deleteGraphEvent,
  holdDraft,
  inviteDraft,
  moveGraphEvent,
  RESPOND_ORGANISER,
  RESPONSE_STATUS_FOR,
  respondToGraphEvent,
  toCalendarEvent,
  type CalendarEvent,
  type GraphEvent,
  type InviteGuest,
  type InviteResponse,
} from "@/lib/microsoft/calendar";
import {
  grantsCalendarWrite,
  microsoftConfigured,
  sanitizeMicrosoftError,
  type MicrosoftToken,
} from "@/lib/microsoft/oauth";
import { appTimeZone, dateTimeInputValue, parseDateTime, zoneLabel } from "@/lib/time";

export { INVITE_NOT_CONNECTED, INVITE_RECONNECT };
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
  senders: InviteSenderOption[];
  defaultFrom: string | null;
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
  from?: unknown;
};

type InviteResult = {
  eventId: string | null;
  providerEventId: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  guests: InviteGuest[];
  from: string;
  loggedOn: number;
  warning: string | null;
};

type CancelResult = { warning: string | null; loggedOn: number };

type InviteOptions = { fetchImpl?: typeof fetch; now?: number; smtp?: SmtpSender; saveSent?: SentSaver };

type ContactMatch = { id: string; email: string; name: string; companyId: string | null };

function invalid(message: string, field: string) {
  return new CrmError("invalid_input", message, 400, { field });
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

async function ownInviteAddresses(db: Db, actor: UserActor) {
  const own = await myAddresses(db, actor);
  const identities = await db.query<{ email: string }>("select email from crm.send_identities where user_id = $1", [actor.userId]);
  for (const row of identities.rows) own.add(row.email.toLowerCase());
  return own;
}

function senderOption(sender: InviteSenderCandidate): InviteSenderOption {
  return { address: sender.address, kind: sender.kind, primary: sender.primary, problem: sender.problem, fixHref: sender.fixHref };
}

export async function getInviteSetup(actor: UserActor): Promise<InviteSetup> {
  return withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    const meetingLink = await readMeetingLink(db, actor);
    const own = await ownInviteAddresses(db, actor);
    const connected = microsoftConfigured() && isConnected(stored);
    const scopes = connected ? await readGrantedScopes(db, stored!.id) : null;
    const senders = await readInviteSenders(db, actor);
    return {
      connected,
      canWriteCalendar: connected && grantsCalendarWrite(scopes) !== false,
      meetingLink,
      ownEmails: [...own],
      senders: senders.map(senderOption),
      defaultFrom: await defaultInviteAddress(db, actor, senders),
    };
  });
}

export async function resolveInviteFrom(actor: UserActor, from?: unknown) {
  return withActor(actor, async (db) => {
    const senders = await readInviteSenders(db, actor);
    return pickInviteSender(senders, from, await defaultInviteAddress(db, actor, senders)).address;
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

function futureStart(startLocal: unknown, timeZone: string, now: number) {
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
  return start;
}

export function inviteWindow(
  startLocal: unknown,
  durationMinutes: unknown,
  options: { timeZone?: string; now?: number } = {},
) {
  const timeZone = options.timeZone ?? appTimeZone();
  const start = futureStart(startLocal, timeZone, options.now ?? Date.now());
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

function sourceToken(actor: UserActor, source: GraphSource, fetchImpl: typeof fetch) {
  return writableSourceToken(actor, source, fetchImpl, writeFailure);
}

async function ensureDefaultCalendar(db: Db, actor: UserActor, connectionId: string) {
  const found = await db.query<{ id: string }>(
    `select id from crm.calendars
     where connection_id = $1 and is_default
     order by (provider_calendar_id = $2) asc, id
     limit 1`,
    [connectionId, DEFAULT_CALENDAR_PLACEHOLDER],
  );
  if (found.rows[0]) return found.rows[0].id;
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
    responseStatus: "organizer",
  };
}

type EmailInvite = { identityId: string; uid: string; sequence: number; notes: string | null };

async function saveCreatedEvent(
  db: Db,
  actor: UserActor,
  calendarId: string,
  source: Pick<GraphSource, "kind" | "id">,
  event: CalendarEvent,
  email: EmailInvite | null = null,
) {
  const result = await db.query<{ id: string }>(
    `insert into crm.calendar_events (
       workspace_id, calendar_id, connection_id, account_id, user_id, provider_event_id, ical_uid,
       subject, starts_at, ends_at, is_all_day, is_cancelled, location, web_link,
       online_meeting_url, organizer, attendees, show_as, response_status, created_by_orbit,
       invite_identity_id, invite_uid, invite_sequence, invite_notes
     ) values ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18, $19, true,
               $20::uuid, $21, $22, $23)
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
       response_status = excluded.response_status,
       created_by_orbit = true,
       invite_identity_id = excluded.invite_identity_id,
       invite_uid = excluded.invite_uid,
       invite_sequence = excluded.invite_sequence,
       invite_notes = excluded.invite_notes
     returning id`,
    [
      actor.workspaceId,
      calendarId,
      source.kind === "connection" ? source.id : null,
      source.kind === "account" ? source.id : null,
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
      event.responseStatus ?? "organizer",
      email?.identityId ?? null,
      email?.uid ?? null,
      email?.sequence ?? 0,
      email?.notes ?? null,
    ],
  );
  return result.rows[0].id;
}

type ReadySender = InviteSenderCandidate & { source: GraphSource };

type InviteSender = {
  sender: ReadySender;
  own: Set<string>;
  meetingLink: string | null;
  mainEmail: string | null;
};

type OpenInviteSender = InviteSender & { token: MicrosoftToken; calendarId: string | null; address: string };

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

type Delivery = { smtp?: SmtpSender; saveSent?: SentSaver };

type InviteSend = Delivery & {
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
  now?: number;
};

async function loadInviteSender(actor: UserActor, from: unknown, fallback: "workspace" | "main" = "workspace"): Promise<InviteSender> {
  const prepared = await withActor(actor, async (db) => {
    const senders = await readInviteSenders(db, actor);
    const main = senders.find((sender) => sender.primary)?.address ?? null;
    const sender = pickInviteSender(senders, from, fallback === "main" ? main : await defaultInviteAddress(db, actor, senders));
    const stored = await readStored(db, actor);
    return {
      sender,
      own: await ownInviteAddresses(db, actor),
      meetingLink: await readMeetingLink(db, actor),
      mainEmail: isConnected(stored) ? stored.email : null,
    };
  });
  const sender = prepared.sender;
  assertSenderReady(sender);
  return { ...prepared, sender };
}

function opened(sender: InviteSender, token: MicrosoftToken): OpenInviteSender {
  return { ...sender, token, calendarId: sender.sender.calendar?.providerCalendarId ?? null, address: sender.sender.address };
}

export async function openInviteSender(
  actor: UserActor,
  options: { fetchImpl?: typeof fetch; from?: unknown; fallback?: "workspace" | "main" } = {},
): Promise<OpenInviteSender> {
  assertScope(actor.scopes, "activities:write");
  const sender = await loadInviteSender(actor, options.from, options.fallback);
  return opened(sender, await sourceToken(actor, sender.sender.source, options.fetchImpl ?? fetch));
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

function organiserOf(identity: Pick<SendIdentity, "email" | "displayName">, actor: UserActor) {
  return { email: identity.email.toLowerCase(), name: identity.displayName ?? actor.fullName ?? null };
}

async function deliverItip(
  actor: UserActor,
  identity: SendIdentity & { password: string },
  event: ItipEvent,
  email: ItipEmail,
  delivery: Delivery,
) {
  const raw = await buildItipMime(event, email);
  try {
    await (delivery.smtp ?? defaultSmtpSender)(identity, { from: identity.email, to: event.guests.map((guest) => guest.email), raw });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await noteIdentityError(actor, identity.id, reason).catch(() => undefined);
    throw new CrmError("upstream_error", `${identity.email} couldn't send the invite: ${reason.slice(0, 200)}`, 502, { field: "from" });
  }
  await noteIdentityError(actor, identity.id, null).catch(() => undefined);
  await (delivery.saveSent ?? defaultSentSaver)(identity, raw).catch((error) => console.error("Saving the invite to Sent failed", error));
}

async function emailIdentity(actor: UserActor, identityId: string) {
  try {
    return await identityForSend(actor, identityId);
  } catch (error) {
    if (error instanceof CrmError) throw new CrmError(error.code, error.message, error.status, { field: "from" });
    throw error;
  }
}

async function createEventFor(
  actor: UserActor,
  sender: OpenInviteSender,
  input: InviteSend,
  fetchImpl: typeof fetch,
): Promise<{ created: GraphEvent; organizer: { name: string | null; email: string }; email: EmailInvite | null }> {
  const { subject, guests, notes, link } = input;
  if (sender.sender.kind !== "smtp" || !sender.sender.identityId) {
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
    try {
      const created = await createGraphEvent(sender.token.accessToken, draft, { calendarId: sender.calendarId, fetchImpl });
      return { created, organizer: { name: actor.fullName, email: sender.address }, email: null };
    } catch (error) {
      throw writeFailure(error);
    }
  }
  const identity = await emailIdentity(actor, sender.sender.identityId);
  const organizer = organiserOf(identity, actor);
  let created: GraphEvent;
  try {
    created = await createGraphEvent(
      sender.token.accessToken,
      holdDraft({
        subject,
        start: input.start,
        end: input.end,
        timeZone: input.timeZone,
        notes,
        link,
        sentFrom: identity.email,
        transactionId: input.transactionId,
      }),
      { calendarId: sender.calendarId, fetchImpl },
    );
  } catch (error) {
    throw writeFailure(error);
  }
  const uid = inviteUid(input.transactionId, identity.email);
  const event: ItipEvent = {
    method: "REQUEST",
    uid,
    sequence: 0,
    organizer,
    guests,
    subject,
    start: input.start,
    end: input.end,
    notes,
    link,
    stamp: new Date(input.now ?? Date.now()),
  };
  try {
    await deliverItip(actor, identity, event, { kind: "invite", when: formatWhen(input.start, input.end, input.timeZone) }, input);
  } catch (error) {
    const holdId = created.id?.trim();
    if (holdId) await deleteGraphEvent(sender.token.accessToken, holdId, fetchImpl).catch(() => undefined);
    throw error;
  }
  return { created, organizer, email: { identityId: identity.id, uid, sequence: 0, notes } };
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
  const { subject, guests, notes, link } = input;
  const source = sender.sender.source;
  const { created, organizer, email } = await createEventFor(actor, sender, input, fetchImpl);

  const result: InviteResult = {
    eventId: null,
    providerEventId: typeof created.id === "string" ? created.id : "",
    subject,
    startsAt: input.start.toISOString(),
    endsAt: input.end.toISOString(),
    guests,
    from: sender.address,
    loggedOn: 0,
    warning: null,
  };
  const providerEventId = created.id?.trim();
  if (!providerEventId || providerEventId.length > 400) return { ...result, warning: SAVE_WARNING };
  const parsed = toCalendarEvent(created);
  const base = parsed
    ? { ...parsed, startsAt: input.start.toISOString(), endsAt: input.end.toISOString() }
    : fallbackEvent(providerEventId, created, { subject, start: input.start, end: input.end, link, organizer, guests });
  const event = email
    ? {
        ...base,
        organizer,
        attendees: guests.map((guest) => ({ ...guest, response: "none" })),
        showAs: base.showAs ?? "busy",
        responseStatus: "organizer",
      }
    : base;
  const when = formatWhen(new Date(event.startsAt), new Date(event.endsAt), input.timeZone);
  const activity = input.activity ?? defaultActivity;
  try {
    const saved = await withActor(actor, async (db) => {
      const calendarRow =
        sender.sender.calendar?.id ?? (source.kind === "connection" ? await ensureDefaultCalendar(db, actor, source.id) : null);
      if (!calendarRow) throw new Error("No calendar row for the invite.");
      const eventId = await saveCreatedEvent(db, actor, calendarRow, source, event, email);
      const preferred = [...(input.contactIds ?? [])];
      if (input.createContacts) {
        preferred.push(...(await ensureGuestContacts(db, actor, guests, [sender.address, ...sender.own])));
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
            metadata: { ...written.metadata, from: sender.address },
          },
          input.provenance ?? { operation: "send_invite", source: email ? "email" : "microsoft" },
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

  const sender = await loadInviteSender(actor, input.from);
  const guests = cleanGuests(input.attendees, sender.own);
  if (input.includeMeetingLink === true && !sender.meetingLink) {
    throw invalid("Add your meeting link in Settings › General first.", "includeMeetingLink");
  }
  const link = input.includeMeetingLink === false ? null : sender.meetingLink;
  const token = await sourceToken(actor, sender.sender.source, fetchImpl);
  const sent = await sendInvite(actor, opened(sender, token), {
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
    smtp: options.smtp,
    saveSent: options.saveSent,
    now: options.now,
  });
  await rememberInviteSender(actor, sender.sender.address).catch((error) => console.error("Remembering the invite sender failed", error));
  return sent;
}

type OrganisedRow = {
  id: string;
  provider_event_id: string;
  connection_id: string | null;
  account_id: string | null;
  subject: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  is_all_day: boolean;
  location: string | null;
  organizer: unknown;
  attendees: unknown;
  contact_ids: string[];
  is_cancelled: boolean;
  created_by_orbit: boolean;
  response_status: string | null;
  show_as: string | null;
  invite_identity_id: string | null;
  invite_uid: string | null;
  invite_sequence: number;
  invite_notes: string | null;
};

export const MEETING_GONE = "This meeting no longer exists in Outlook, so Orbit has taken it off your calendar.";
export const HOLD_GONE =
  "The hold for this meeting was deleted from Outlook, so Orbit has taken it off your calendar. Your guests still have the invite.";

const ORGANISER_ONLY = {
  cancel: "Only the organiser can cancel this meeting. Decline it in Outlook instead.",
  move: "Only the organiser can move this meeting. Propose a new time in Outlook instead.",
};

type EventVerb = "cancel" | "move" | "answer";

const NOT_CONNECTED_FOR: Record<EventVerb, string> = {
  cancel: INVITE_NOT_CONNECTED,
  move: INVITE_NOT_CONNECTED,
  answer: "Connect Microsoft in Settings › Integrations to answer invites.",
};

async function readOwnEvent(actor: UserActor, eventId: string, verb: EventVerb) {
  if (!isUuid(eventId)) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  return withActor(actor, async (db) => {
    const event = await db.query<OrganisedRow>(
      `select id, provider_event_id, connection_id, account_id, subject, starts_at, ends_at, is_all_day, location,
              organizer, attendees, contact_ids, is_cancelled, created_by_orbit, response_status, show_as,
              invite_identity_id, invite_uid, invite_sequence, invite_notes
       from crm.calendar_events
       where id = $1 and user_id = $2`,
      [eventId, actor.userId],
    );
    const row = event.rows[0] ?? null;
    return {
      event: row,
      own: await ownInviteAddresses(db, actor),
      source: row ? await eventSource(db, actor, row, verb) : null,
    };
  });
}

async function eventSource(db: Db, actor: UserActor, row: OrganisedRow, verb: EventVerb): Promise<GraphSource | CrmError> {
  const source = await graphSourceFor(db, actor, row);
  if (source) return source;
  if (row.account_id) {
    const account = await accountEmail(db, row.account_id);
    if (account?.provider === "ics") {
      return new CrmError("invalid_input", "This meeting comes from a calendar link, which Orbit can only read.", 400);
    }
    const email = account?.email ?? "that calendar account";
    return new CrmError(
      "not_connected",
      `Reconnect ${email} in Settings › Calendars so Orbit can ${verb === "answer" ? "answer" : verb} meetings in its calendar.`,
      400,
    );
  }
  const stored = await readStored(db, actor);
  if (!microsoftConfigured() || !isConnected(stored)) return new CrmError("not_connected", NOT_CONNECTED_FOR[verb], 400);
  return new CrmError(
    "invalid_input",
    verb === "answer"
      ? "Orbit can only answer invites in the calendars of your connected Microsoft accounts."
      : `Orbit can only ${verb} meetings in the calendars of your connected Microsoft accounts.`,
    400,
  );
}

function organisedByUser(row: Pick<OrganisedRow, "created_by_orbit" | "response_status" | "organizer">, own: Set<string>) {
  const organizer = readPerson(row.organizer);
  return row.created_by_orbit || row.response_status === "organizer" || Boolean(organizer && own.has(organizer.email));
}

type Organised = {
  row: OrganisedRow;
  guests: string[];
  people: InviteGuest[];
  startsAt: Date;
  endsAt: Date;
  source: GraphSource;
  identityId: string | null;
  token: (fetchImpl: typeof fetch) => Promise<MicrosoftToken>;
};

async function organisedEvent(actor: UserActor, eventId: string, verb: "cancel" | "move", now: number): Promise<Organised> {
  const found = await readOwnEvent(actor, eventId, verb);
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
  if (startsAt.getTime() <= now) {
    throw new CrmError("invalid_input", `This meeting has already started, so Orbit can't ${verb} it.`, 400);
  }
  const source = found.source;
  if (!source) throw new CrmError("not_connected", INVITE_NOT_CONNECTED, 400);
  if (source instanceof CrmError) throw source;
  if (row.invite_identity_id && !row.invite_uid) {
    throw new CrmError("invalid_input", `Orbit can't ${verb} this meeting because its invite details are missing.`, 400);
  }
  const people = readPeople(row.attendees)
    .filter((person) => !found.own.has(person.email))
    .map((person) => ({ email: person.email, name: person.name }));
  const guests = [
    ...new Set(
      [organizer, ...readPeople(row.attendees)]
        .map((person) => person?.email)
        .filter((email): email is string => Boolean(email) && !found.own.has(email!)),
    ),
  ];
  return {
    row,
    guests,
    people,
    startsAt,
    endsAt: new Date(row.ends_at),
    source,
    identityId: row.invite_identity_id,
    token: (fetchImpl: typeof fetch) => sourceToken(actor, source, fetchImpl),
  };
}

function itipFor(
  actor: UserActor,
  identity: SendIdentity,
  found: Organised,
  method: ItipEvent["method"],
  window: { start: Date; end: Date },
  now: number,
): ItipEvent {
  return {
    method,
    uid: found.row.invite_uid!,
    sequence: found.row.invite_sequence + 1,
    organizer: organiserOf(identity, actor),
    guests: found.people,
    subject: found.row.subject ?? "Untitled event",
    start: window.start,
    end: window.end,
    notes: found.row.invite_notes,
    link: found.row.location,
    stamp: new Date(now),
  };
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
  const found = await organisedEvent(actor, eventId, "cancel", now);
  const { row, guests, startsAt, endsAt } = found;
  const token = await found.token(fetchImpl);
  let warning: string | null = null;
  if (found.identityId) {
    const identity = await emailIdentity(actor, found.identityId);
    const timeZone = appTimeZone();
    await deliverItip(
      actor,
      identity,
      itipFor(actor, identity, found, "CANCEL", { start: startsAt, end: endsAt }, now),
      { kind: "cancel", when: formatWhen(startsAt, endsAt, timeZone), message },
      options,
    );
    try {
      await deleteGraphEvent(token.accessToken, row.provider_event_id, fetchImpl);
    } catch {
      warning = "Your guests were told, but Orbit couldn't remove the hold from your Outlook calendar. Delete it there.";
    }
  } else {
    try {
      await cancelGraphEvent(token.accessToken, row.provider_event_id, message, fetchImpl);
    } catch (error) {
      if (!(error instanceof CalendarWriteError && error.status === 404)) throw writeFailure(error);
      warning = "Outlook had already removed this meeting, so no cancellation was sent.";
    }
  }
  const subject = row.subject ?? "Untitled event";
  const when = formatWhen(startsAt, endsAt, appTimeZone());
  try {
    const loggedOn = await withActor(actor, async (db) => {
      await db.query(
        "update crm.calendar_events set is_cancelled = true, invite_sequence = invite_sequence + $2 where id = $1",
        [row.id, found.identityId ? 1 : 0],
      );
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
          { operation: "cancel_invite", source: found.identityId ? "email" : "microsoft" },
        );
      }
      return contacts.length;
    });
    return { warning, loggedOn };
  } catch (error) {
    console.error("Meeting cancelled but not saved", error);
    return {
      warning: found.identityId
        ? "The meeting was cancelled, but Orbit couldn't update it yet. It disappears after the next sync."
        : "The meeting was cancelled in Outlook, but Orbit couldn't update it yet. It disappears after the next sync.",
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
  currentLengthMs: number,
  options: { timeZone?: string; now?: number } = {},
) {
  const timeZone = options.timeZone ?? appTimeZone();
  const now = options.now ?? Date.now();
  const given = (value: unknown) => value !== undefined && value !== null && value !== "";
  if (given(input.endLocal)) {
    const start = futureStart(input.startLocal, timeZone, now);
    const end = localInstant(input.endLocal, timeZone, "endLocal", "Pick an end time.");
    if (end.getTime() <= start.getTime()) throw invalid("End the meeting after it starts.", "endLocal");
    const minutes = (end.getTime() - start.getTime()) / 60_000;
    if (minutes < MIN_DURATION || minutes > MAX_DURATION) {
      throw invalid("Pick a duration between 5 minutes and 8 hours.", "endLocal");
    }
    return { start, end };
  }
  if (given(input.durationMinutes)) {
    const { start, end } = inviteWindow(input.startLocal, input.durationMinutes, { timeZone, now });
    return { start, end };
  }
  const start = futureStart(input.startLocal, timeZone, now);
  return { start, end: new Date(start.getTime() + currentLengthMs) };
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
  const found = await organisedEvent(actor, eventId, "move", now);
  const { row, guests, startsAt, endsAt, token: tokenFor } = found;
  const window = moveWindow(input, endsAt.getTime() - startsAt.getTime(), { timeZone, now });
  if (window.start.getTime() === startsAt.getTime() && window.end.getTime() === endsAt.getTime()) {
    throw invalid("That's when the meeting already is. Pick another time.", "startLocal");
  }
  const identity = found.identityId ? await emailIdentity(actor, found.identityId) : null;
  const token = await tokenFor(fetchImpl);
  let updated: Awaited<ReturnType<typeof moveGraphEvent>>;
  try {
    updated = await moveGraphEvent(
      token.accessToken,
      row.provider_event_id,
      { start: window.start, end: window.end, timeZone, message: identity ? null : message },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof CalendarWriteError && error.status === 404) {
      await withActor(actor, (db) => db.query("update crm.calendar_events set is_cancelled = true where id = $1", [row.id]));
      throw new CrmError("gone", identity ? HOLD_GONE : MEETING_GONE, 410);
    }
    throw writeFailure(error);
  }
  if (identity) {
    try {
      await deliverItip(
        actor,
        identity,
        itipFor(actor, identity, found, "REQUEST", window, now),
        { kind: "update", when: formatWhen(window.start, window.end, timeZone), previousWhen: formatWhen(startsAt, endsAt, timeZone), message },
        options,
      );
    } catch (error) {
      await moveGraphEvent(token.accessToken, row.provider_event_id, { start: startsAt, end: endsAt, timeZone, message: null }, fetchImpl).catch(
        () => undefined,
      );
      throw error;
    }
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
  const parsed = identity ? null : toCalendarEvent(updated);
  const was = formatWhen(startsAt, endsAt, timeZone);
  const when = formatWhen(window.start, window.end, timeZone);
  try {
    const loggedOn = await withActor(actor, async (db) => {
      await db.query(
        `update crm.calendar_events
         set starts_at = $2, ends_at = $3, attendees = coalesce($4::jsonb, attendees), invite_sequence = invite_sequence + $5
         where id = $1`,
        [row.id, result.startsAt, result.endsAt, parsed ? JSON.stringify(parsed.attendees) : null, identity ? 1 : 0],
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
          { operation: "reschedule_invite", source: identity ? "email" : "microsoft" },
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

export const RESPOND_NOT_CONNECTED = NOT_CONNECTED_FOR.answer;

export const MEETING_RESPONSES = ["accept", "tentative", "decline"] as const;

export type MeetingResponse = (typeof MEETING_RESPONSES)[number];

const GRAPH_RESPONSE: Record<MeetingResponse, InviteResponse> = {
  accept: "accept",
  tentative: "tentativelyAccept",
  decline: "decline",
};

const RESPONSE_TITLE: Record<MeetingResponse, string> = {
  accept: "Accepted",
  tentative: "Tentatively accepted",
  decline: "Declined",
};

export type RespondInput = {
  eventId?: unknown;
  response?: unknown;
  note?: unknown;
  sendResponse?: unknown;
  proposedStartLocal?: unknown;
  proposedDurationMinutes?: unknown;
};

export type RespondResult = {
  eventId: string;
  subject: string;
  response: MeetingResponse;
  responseStatus: string;
  organizer: { name: string | null; email: string } | null;
  organizerTold: boolean;
  proposedStartsAt: string | null;
  proposedEndsAt: string | null;
  loggedOn: number;
  warning: string | null;
};

const PROPOSAL_FIELDS: Record<string, string> = {
  startLocal: "proposedStartLocal",
  endLocal: "proposedStartLocal",
  durationMinutes: "proposedDurationMinutes",
};

function cleanResponse(value: unknown): MeetingResponse {
  const response = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((MEETING_RESPONSES as readonly string[]).includes(response)) return response as MeetingResponse;
  throw invalid("Choose Accept, Maybe or Decline.", "response");
}

function proposalWindow(
  input: RespondInput,
  currentLengthMs: number,
  options: { timeZone: string; now: number },
) {
  try {
    return moveWindow(
      { startLocal: input.proposedStartLocal, durationMinutes: input.proposedDurationMinutes },
      currentLengthMs,
      options,
    );
  } catch (error) {
    if (!(error instanceof CrmError)) throw error;
    const field = typeof error.details?.field === "string" ? error.details.field : "";
    throw invalid(error.message, PROPOSAL_FIELDS[field] ?? "proposedStartLocal");
  }
}

async function invitedEvent(actor: UserActor, eventId: string, now: number) {
  const found = await readOwnEvent(actor, eventId, "answer");
  const row = found.event;
  if (!row) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  if (row.is_cancelled) throw new CrmError("conflict", "This meeting is cancelled, so there's nothing to answer.", 409);
  if (organisedByUser(row, found.own)) throw new CrmError("forbidden", RESPOND_ORGANISER, 403);
  const startsAt = new Date(row.starts_at);
  if (startsAt.getTime() <= now) {
    throw new CrmError("invalid_input", "This meeting has already started, so Orbit can't answer it. Reply in Outlook if you need to.", 400);
  }
  const source = found.source;
  if (!source) throw new CrmError("not_connected", RESPOND_NOT_CONNECTED, 400);
  if (source instanceof CrmError) throw source;
  return {
    row,
    own: found.own,
    startsAt,
    endsAt: new Date(row.ends_at),
    token: (fetchImpl: typeof fetch) => sourceToken(actor, source, fetchImpl),
  };
}

function withOwnResponse(attendees: unknown, own: Set<string>, status: string) {
  if (!Array.isArray(attendees)) return null;
  let changed = false;
  const next = attendees.map((entry) => {
    const person = readPerson(entry);
    if (!person || !own.has(person.email)) return entry;
    changed = true;
    return { ...(entry as Record<string, unknown>), response: status };
  });
  return changed ? next : null;
}

function nextShowAs(response: MeetingResponse, current: string | null) {
  if (response === "tentative") return "tentative";
  if (response === "accept" && (current === "tentative" || current === null)) return "busy";
  return current;
}

export async function respondToInvite(
  actor: UserActor,
  input: RespondInput,
  options: InviteOptions = {},
): Promise<RespondResult> {
  assertScope(actor.scopes, "activities:write");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const eventId = typeof input.eventId === "string" ? input.eventId : "";
  if (!isUuid(eventId)) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  const response = cleanResponse(input.response);
  const note = cleanNotes(input.note, INVITE_COMMENT_MAX, "note");
  if (input.sendResponse !== undefined && input.sendResponse !== null && typeof input.sendResponse !== "boolean") {
    throw invalid("Choose whether to tell the organiser.", "sendResponse");
  }
  const sendResponse = input.sendResponse !== false;
  const proposing =
    input.proposedStartLocal !== undefined && input.proposedStartLocal !== null && input.proposedStartLocal !== "";
  if (proposing && response === "accept") {
    throw invalid("Only Maybe or Decline can suggest a new time.", "proposedStartLocal");
  }
  if (!sendResponse && (note || proposing)) {
    throw invalid(
      "Only the organiser sees a note or a new time, so tell them or leave those out.",
      note ? "note" : "proposedStartLocal",
    );
  }
  const timeZone = appTimeZone();
  const { row, own, startsAt, endsAt, token: tokenFor } = await invitedEvent(actor, eventId, now);
  const proposal = proposing ? proposalWindow(input, endsAt.getTime() - startsAt.getTime(), { timeZone, now }) : null;
  if (proposal && proposal.start.getTime() === startsAt.getTime() && proposal.end.getTime() === endsAt.getTime()) {
    throw invalid("That's when the meeting already is. Pick another time.", "proposedStartLocal");
  }
  const token = await tokenFor(fetchImpl);
  try {
    await respondToGraphEvent(
      token.accessToken,
      row.provider_event_id,
      {
        response: GRAPH_RESPONSE[response],
        comment: note,
        sendResponse,
        proposedNewTime: proposal ? { start: proposal.start, end: proposal.end, timeZone } : null,
      },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof CalendarWriteError && error.status === 404) {
      await withActor(actor, (db) => db.query("update crm.calendar_events set is_cancelled = true where id = $1", [row.id]));
      throw new CrmError("gone", MEETING_GONE, 410);
    }
    throw writeFailure(error);
  }
  const status = RESPONSE_STATUS_FOR[GRAPH_RESPONSE[response]];
  const subject = row.subject ?? "Untitled event";
  const organizer = readPerson(row.organizer);
  const result: RespondResult = {
    eventId: row.id,
    subject,
    response,
    responseStatus: status,
    organizer,
    organizerTold: sendResponse,
    proposedStartsAt: proposal?.start.toISOString() ?? null,
    proposedEndsAt: proposal?.end.toISOString() ?? null,
    loggedOn: 0,
    warning: null,
  };
  const when = formatWhen(startsAt, endsAt, timeZone);
  const proposed = proposal ? formatWhen(proposal.start, proposal.end, timeZone) : null;
  const attendees = withOwnResponse(row.attendees, own, status);
  try {
    const loggedOn = await withActor(actor, async (db) => {
      await db.query(
        `update crm.calendar_events
         set response_status = $2, show_as = $3, attendees = coalesce($4::jsonb, attendees)
         where id = $1`,
        [row.id, status, nextShowAs(response, row.show_as), attendees ? JSON.stringify(attendees) : null],
      );
      if (!sendResponse || !organizer) return 0;
      const contacts = await matchContacts(db, actor, [organizer.email], row.contact_ids ?? []);
      for (const contact of contacts) {
        await createActivityInDb(
          db,
          actor,
          {
            type: "meeting",
            title: clip(`${RESPONSE_TITLE[response]} ${subject}`, 200),
            body: [
              when,
              proposed ? `Suggested instead: ${proposed}` : null,
              note ? `\nNote to the organiser: ${note}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
            contactId: contact.id,
            companyId: contact.companyId,
            metadata: {
              source: "orbit",
              kind: "response",
              response: status,
              eventId: row.id,
              startsAt: startsAt.toISOString(),
              ...(proposal ? { proposedStartsAt: result.proposedStartsAt } : {}),
            },
          },
          { operation: "respond_to_invite", source: "microsoft" },
        );
      }
      return contacts.length;
    });
    return { ...result, loggedOn };
  } catch (error) {
    console.error("Invite answered but not saved", error);
    return {
      ...result,
      warning: "Your response reached Outlook, but Orbit couldn't update the meeting yet. It catches up after the next sync.",
    };
  }
}
