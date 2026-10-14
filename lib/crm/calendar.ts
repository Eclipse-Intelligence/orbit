import type { Db } from "@/lib/db/pool";
import { isFreeMailDomain } from "@/lib/crm/communications";
import { withActor } from "@/lib/crm/context";
import {
  claimIntegration,
  createContactFromAttendee,
  errorText,
  finishIntegration,
  internalAddresses,
  type IntegrationKey,
} from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { currentToken, readStored, storeToken, type StoredConnection } from "@/lib/crm/inbox";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import {
  CalendarScopeError,
  fetchCalendarView,
  type CalendarEvent,
  type CalendarPerson,
} from "@/lib/microsoft/calendar";
import { grantsCalendar, sanitizeMicrosoftError } from "@/lib/microsoft/oauth";

const DAY_MS = 86_400_000;
export const CALENDAR_BACK_MS = 30 * DAY_MS;
export const CALENDAR_AHEAD_MS = 60 * DAY_MS;
const SYNC_GAP_MS = 5 * 60 * 1000;
const SAVE_BATCH = 200;
const MEETINGS_SHOWN = 5;
const PEOPLE_SHOWN = 25;
export const CALENDAR_RECONNECT = "Reconnect Microsoft to include your calendar.";
const NOT_CONNECTED = "Connect Microsoft to read your calendar.";

export type CalendarSyncResult = {
  ran: boolean;
  saved: number;
  removed: number;
  linked: number;
  complete: boolean;
  scopeMissing: boolean;
  error?: string;
};

export type CalendarStatus = {
  connected: boolean;
  scopeMissing: boolean;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

export type Meeting = {
  id: string;
  subject: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  location: string | null;
  webLink: string | null;
  joinUrl: string | null;
  organizer: CalendarPerson | null;
  attendeeCount: number;
  granolaActivityId: string | null;
};

export type MeetingsSummary = {
  scopeMissing: boolean;
  upcoming: Meeting[];
  recent: Meeting[];
};

export type MeetingRef = { subject: string | null; startsAt: string };

export type MetPerson = {
  email: string;
  name: string | null;
  meetings: number;
  lastMeeting: MeetingRef | null;
  nextMeeting: MeetingRef | null;
};

type EventRow = {
  id: string;
  subject: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  is_all_day: boolean;
  location: string | null;
  web_link: string | null;
  online_meeting_url: string | null;
  organizer: unknown;
  attendee_count: number;
  granola_activity_id: string | null;
};

function iso(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function calendarWindow(now = Date.now()) {
  return { start: new Date(now - CALENDAR_BACK_MS), end: new Date(now + CALENDAR_AHEAD_MS) };
}

function calendarKey(actor: UserActor, connectionId: string): IntegrationKey {
  return {
    workspaceId: actor.workspaceId,
    source: "calendar",
    connectionId,
    userId: actor.userId,
  };
}

function readPerson(value: unknown): CalendarPerson | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const email = typeof item.email === "string" ? canonicalEmail(item.email) : null;
  if (!email) return null;
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
  return { name: name && !canonicalEmail(name) ? name : null, email };
}

function readPeople(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(readPerson).filter((person): person is CalendarPerson => person !== null);
}

async function setScopeMissing(db: Db, key: IntegrationKey, missing: boolean) {
  await db.query(
    `update crm.integration_state set scope_missing = $3
     where connection_id = $1 and source = $2`,
    [key.connectionId, key.source, missing],
  );
}

async function saveEvents(db: Db, actor: UserActor, connectionId: string, events: CalendarEvent[]) {
  let saved = 0;
  for (let index = 0; index < events.length; index += SAVE_BATCH) {
    const batch = events.slice(index, index + SAVE_BATCH).map((event) => ({
      provider_event_id: event.providerEventId,
      ical_uid: event.icalUid,
      subject: event.subject,
      starts_at: event.startsAt,
      ends_at: event.endsAt,
      is_all_day: event.isAllDay,
      is_cancelled: event.isCancelled,
      location: event.location,
      web_link: event.webLink,
      online_meeting_url: event.onlineMeetingUrl,
      organizer: event.organizer,
      attendees: event.attendees,
    }));
    const result = await db.query(
      `insert into crm.calendar_events (
         workspace_id, connection_id, user_id, provider_event_id, ical_uid, subject,
         starts_at, ends_at, is_all_day, is_cancelled, location, web_link,
         online_meeting_url, organizer, attendees
       )
       select $1, $2, $3, e.provider_event_id, e.ical_uid, e.subject,
              e.starts_at, e.ends_at, e.is_all_day, e.is_cancelled, e.location, e.web_link,
              e.online_meeting_url, e.organizer, coalesce(e.attendees, '[]'::jsonb)
       from jsonb_to_recordset($4::jsonb) as e(
         provider_event_id text, ical_uid text, subject text, starts_at timestamptz,
         ends_at timestamptz, is_all_day boolean, is_cancelled boolean, location text,
         web_link text, online_meeting_url text, organizer jsonb, attendees jsonb
       )
       on conflict (connection_id, provider_event_id) do update set
         ical_uid = excluded.ical_uid,
         subject = excluded.subject,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         is_all_day = excluded.is_all_day,
         is_cancelled = excluded.is_cancelled,
         location = excluded.location,
         web_link = excluded.web_link,
         online_meeting_url = excluded.online_meeting_url,
         organizer = excluded.organizer,
         attendees = excluded.attendees`,
      [actor.workspaceId, connectionId, actor.userId, JSON.stringify(batch)],
    );
    saved += result.rowCount ?? 0;
  }
  return saved;
}

async function removeEvents(db: Db, connectionId: string, keep: string[] | null, windowStart: Date) {
  const result = keep
    ? await db.query(
        `delete from crm.calendar_events
         where connection_id = $1 and provider_event_id <> all($2::text[])`,
        [connectionId, keep],
      )
    : await db.query(
        "delete from crm.calendar_events where connection_id = $1 and ends_at <= $2",
        [connectionId, windowStart.toISOString()],
      );
  return result.rowCount ?? 0;
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((id) => set.has(id));
}

async function linkEvents(db: Db, actor: UserActor, mailbox: Pick<StoredConnection, "id" | "email">) {
  const events = await db.query<{
    id: string;
    organizer: unknown;
    attendees: unknown;
    contact_ids: string[];
    company_ids: string[];
  }>(
    `select id, organizer, attendees, contact_ids, company_ids
     from crm.calendar_events
     where connection_id = $1`,
    [mailbox.id],
  );
  if (events.rows.length === 0) return 0;
  const internal = await internalAddresses(db, actor.workspaceId, [actor.email, mailbox.email]);
  const perEvent = events.rows.map((row) => {
    const emails = new Set<string>();
    for (const person of [readPerson(row.organizer), ...readPeople(row.attendees)]) {
      if (person && !internal.isInternal(person.email)) emails.add(person.email);
    }
    return [...emails];
  });
  const allEmails = [...new Set(perEvent.flat())];
  const domains = new Set<string>();
  for (const email of allEmails) {
    const domain = canonicalDomain(email.split("@")[1] ?? "");
    if (domain && !isFreeMailDomain(domain)) domains.add(domain);
  }
  const contacts = new Map<string, { id: string; companyId: string | null }[]>();
  if (allEmails.length > 0) {
    const found = await db.query<{ id: string; normalized_email: string; company_id: string | null }>(
      `select id, normalized_email, company_id from crm.contacts
       where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])`,
      [actor.workspaceId, allEmails],
    );
    for (const row of found.rows) {
      const list = contacts.get(row.normalized_email) ?? [];
      list.push({ id: row.id, companyId: row.company_id });
      contacts.set(row.normalized_email, list);
    }
  }
  const companies = new Map<string, string[]>();
  if (domains.size > 0) {
    const found = await db.query<{ id: string; domain: string }>(
      `select id, domain from crm.companies
       where workspace_id = $1 and archived_at is null and domain = any($2::text[])`,
      [actor.workspaceId, [...domains]],
    );
    for (const row of found.rows) {
      const list = companies.get(row.domain) ?? [];
      list.push(row.id);
      companies.set(row.domain, list);
    }
  }
  let linked = 0;
  for (const [index, row] of events.rows.entries()) {
    const contactIds = new Set<string>();
    const companyIds = new Set<string>();
    for (const email of perEvent[index]) {
      for (const contact of contacts.get(email) ?? []) {
        contactIds.add(contact.id);
        if (contact.companyId) companyIds.add(contact.companyId);
      }
      const domain = canonicalDomain(email.split("@")[1] ?? "");
      if (domain && !isFreeMailDomain(domain)) {
        for (const id of companies.get(domain) ?? []) companyIds.add(id);
      }
    }
    const nextContacts = [...contactIds].sort();
    const nextCompanies = [...companyIds].sort();
    if (sameIds(row.contact_ids ?? [], nextContacts) && sameIds(row.company_ids ?? [], nextCompanies)) continue;
    await db.query(
      "update crm.calendar_events set contact_ids = $2::uuid[], company_ids = $3::uuid[] where id = $1",
      [row.id, nextContacts, nextCompanies],
    );
    linked += 1;
  }
  return linked;
}

export async function relinkCalendar(actor: UserActor) {
  return withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    if (!stored) return 0;
    return linkEvents(db, actor, stored);
  });
}

export async function syncCalendar(
  actor: UserActor,
  options: { fetchImpl?: typeof fetch; deadline?: number; force?: boolean; now?: number } = {},
): Promise<CalendarSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const idle: CalendarSyncResult = {
    ran: false,
    saved: 0,
    removed: 0,
    linked: 0,
    complete: false,
    scopeMissing: false,
  };
  const stored = await withActor(actor, (db) => readStored(db, actor));
  if (!stored || stored.status !== "connected" || !stored.refreshTokenCipher) {
    return { ...idle, error: NOT_CONNECTED };
  }
  const key = calendarKey(actor, stored.id);
  const claim = await withActor(actor, (db) =>
    claimIntegration(db, key, Boolean(options.force), SYNC_GAP_MS),
  );
  if (!claim) return idle;
  const now = options.now ?? Date.now();
  const window = calendarWindow(now);
  const missing = async () => {
    await withActor(actor, async (db) => {
      await finishIntegration(db, key, { error: null });
      await setScopeMissing(db, key, true);
    });
    return { ...idle, ran: true, scopeMissing: true };
  };
  try {
    const token = await currentToken(stored, fetchImpl);
    if (token.expiresAt !== stored.accessTokenExpiresAt) {
      await withActor(actor, (db) => storeToken(db, stored.id, token));
    }
    if (grantsCalendar(token.scope) === false) return await missing();
    const fetched = await fetchCalendarView(token.accessToken, window, {
      fetchImpl,
      deadline: options.deadline,
    });
    return await withActor(actor, async (db) => {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`calendar:${stored.id}`]);
      const saved = await saveEvents(db, actor, stored.id, fetched.events);
      const removed = await removeEvents(
        db,
        stored.id,
        fetched.complete ? fetched.events.map((event) => event.providerEventId) : null,
        window.start,
      );
      const linked = await linkEvents(db, actor, stored);
      await finishIntegration(db, key, {
        syncedAt: fetched.complete ? new Date(now).toISOString() : null,
        error: null,
      });
      await setScopeMissing(db, key, false);
      return { ran: true, saved, removed, linked, complete: fetched.complete, scopeMissing: false };
    });
  } catch (error) {
    if (error instanceof CalendarScopeError) return missing();
    const message = sanitizeMicrosoftError(errorText(error, "Could not sync the calendar."));
    await withActor(actor, (db) => finishIntegration(db, key, { error: message }));
    return { ...idle, ran: true, error: message };
  }
}

export async function resetCalendarSync(actor: UserActor) {
  await withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    if (!stored) return;
    await db.query(
      `update crm.integration_state
       set scope_missing = false, last_attempt_at = null, last_error = null
       where connection_id = $1 and source = 'calendar'`,
      [stored.id],
    );
  });
}

async function readStatus(db: Db, actor: UserActor) {
  const stored = await readStored(db, actor);
  if (!stored) return null;
  const result = await db.query<{
    scope_missing: boolean;
    last_synced_at: Date | string | null;
    last_attempt_at: Date | string | null;
    last_error: string | null;
  }>(
    `select scope_missing, last_synced_at, last_attempt_at, last_error
     from crm.integration_state
     where connection_id = $1 and source = 'calendar'`,
    [stored.id],
  );
  const row = result.rows[0];
  return {
    stored,
    status: {
      connected: stored.status === "connected" && Boolean(stored.refreshTokenCipher),
      scopeMissing: Boolean(row?.scope_missing),
      lastSyncedAt: iso(row?.last_synced_at ?? null),
      lastAttemptAt: iso(row?.last_attempt_at ?? null),
      lastError: row?.last_error ?? null,
    } satisfies CalendarStatus,
  };
}

export async function getCalendarStatus(actor: UserActor): Promise<CalendarStatus | null> {
  return withActor(actor, async (db) => (await readStatus(db, actor))?.status ?? null);
}

function mapMeeting(row: EventRow): Meeting {
  return {
    id: row.id,
    subject: row.subject,
    startsAt: iso(row.starts_at)!,
    endsAt: iso(row.ends_at)!,
    isAllDay: row.is_all_day,
    location: row.location,
    webLink: row.web_link,
    joinUrl: row.online_meeting_url,
    organizer: readPerson(row.organizer),
    attendeeCount: row.attendee_count,
    granolaActivityId: row.granola_activity_id,
  };
}

export async function getMeetings(
  actor: UserActor,
  target: { contactId: string } | { companyId: string },
  now = Date.now(),
): Promise<MeetingsSummary> {
  assertScope(actor.scopes, "crm:read");
  const byContact = "contactId" in target;
  const id = byContact ? target.contactId : target.companyId;
  if (!isUuid(id)) return { scopeMissing: false, upcoming: [], recent: [] };
  return withActor(actor, async (db) => {
    const status = (await readStatus(db, actor))?.status;
    const column = byContact ? "contact_ids" : "company_ids";
    const notes = byContact
      ? "a.contact_id = $3"
      : "(a.company_id = $3 or a.contact_id = any(e.contact_ids))";
    const select = (upcoming: boolean) =>
      db.query<EventRow>(
        `select e.id, e.subject, e.starts_at, e.ends_at, e.is_all_day, e.location, e.web_link,
                e.online_meeting_url, e.organizer, jsonb_array_length(e.attendees)::int as attendee_count,
                g.id as granola_activity_id
         from crm.calendar_events e
         left join lateral (
           select a.id from crm.activities a
           where a.workspace_id = e.workspace_id
             and a.type = 'meeting'
             and a.metadata->>'source' = 'granola'
             and a.occurred_at between e.starts_at - interval '2 hours' and e.starts_at + interval '2 hours'
             and ${notes}
           order by abs(extract(epoch from a.occurred_at - e.starts_at))
           limit 1
         ) g on true
         where e.user_id = $1 and e.workspace_id = $2
           and e.${column} @> array[$3]::uuid[]
           and not e.is_cancelled
           and ${upcoming ? "e.ends_at > $4" : "e.ends_at <= $4"}
         order by e.starts_at ${upcoming ? "asc" : "desc"}
         limit ${MEETINGS_SHOWN}`,
        [actor.userId, actor.workspaceId, id, new Date(now).toISOString()],
      );
    const upcoming = await select(true);
    const recent = await select(false);
    return {
      scopeMissing: Boolean(status?.scopeMissing),
      upcoming: upcoming.rows.map(mapMeeting),
      recent: recent.rows.map(mapMeeting),
    };
  });
}

export async function listPeopleMet(actor: UserActor, now = Date.now()): Promise<MetPerson[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    const events = await db.query<{
      subject: string | null;
      starts_at: Date | string;
      organizer: unknown;
      attendees: unknown;
    }>(
      `select subject, starts_at, organizer, attendees
       from crm.calendar_events
       where user_id = $1 and workspace_id = $2 and not is_cancelled
       order by starts_at desc`,
      [actor.userId, actor.workspaceId],
    );
    if (events.rows.length === 0) return [];
    const internal = await internalAddresses(db, actor.workspaceId, [actor.email, stored?.email]);
    const people = new Map<string, MetPerson>();
    for (const row of events.rows) {
      const startsAt = iso(row.starts_at)!;
      const ref = { subject: row.subject, startsAt };
      const past = new Date(startsAt).getTime() <= now;
      const seen = new Set<string>();
      for (const person of [readPerson(row.organizer), ...readPeople(row.attendees)]) {
        if (!person || seen.has(person.email) || internal.isInternal(person.email)) continue;
        seen.add(person.email);
        const entry = people.get(person.email) ?? {
          email: person.email,
          name: null,
          meetings: 0,
          lastMeeting: null,
          nextMeeting: null,
        };
        entry.name ??= person.name;
        entry.meetings += 1;
        if (past && (!entry.lastMeeting || entry.lastMeeting.startsAt < startsAt)) entry.lastMeeting = ref;
        if (!past && (!entry.nextMeeting || entry.nextMeeting.startsAt > startsAt)) entry.nextMeeting = ref;
        people.set(person.email, entry);
      }
    }
    const emails = [...people.keys()];
    if (emails.length === 0) return [];
    const known = await db.query<{ email: string }>(
      `select normalized_email as email from crm.contacts
       where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])
       union
       select email from crm.hidden_attendees
       where user_id = $3 and workspace_id = $1 and email = any($2::text[])`,
      [actor.workspaceId, emails, actor.userId],
    );
    for (const row of known.rows) people.delete(row.email);
    return [...people.values()]
      .sort((left, right) => {
        if (left.lastMeeting && right.lastMeeting) {
          return right.lastMeeting.startsAt.localeCompare(left.lastMeeting.startsAt);
        }
        if (left.lastMeeting || right.lastMeeting) return left.lastMeeting ? -1 : 1;
        return (left.nextMeeting?.startsAt ?? "").localeCompare(right.nextMeeting?.startsAt ?? "");
      })
      .slice(0, PEOPLE_SHOWN);
  });
}

function wantedEmail(email: unknown) {
  const wanted = typeof email === "string" ? canonicalEmail(email) : null;
  if (!wanted) {
    throw new CrmError("invalid_input", "Enter a valid email address.", 400, { field: "email" });
  }
  return wanted;
}

export async function hideAttendee(actor: UserActor, email: string) {
  assertScope(actor.scopes, "crm:read");
  const wanted = wantedEmail(email);
  await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.hidden_attendees (user_id, workspace_id, email)
       values ($1, $2, $3)
       on conflict do nothing`,
      [actor.userId, actor.workspaceId, wanted],
    );
  });
}

export async function createContactFromMeeting(actor: UserActor, email: string) {
  const wanted = wantedEmail(email);
  const found = await withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    const result = await db.query<{ organizer: unknown; attendees: unknown }>(
      `select organizer, attendees from crm.calendar_events
       where user_id = $1 and workspace_id = $2
         and (attendees @> $3::jsonb or organizer->>'email' = $4)
       order by starts_at desc
       limit 20`,
      [actor.userId, actor.workspaceId, JSON.stringify([{ email: wanted }]), wanted],
    );
    let name: string | null = null;
    let present = false;
    for (const row of result.rows) {
      for (const person of [readPerson(row.organizer), ...readPeople(row.attendees)]) {
        if (person?.email !== wanted) continue;
        present = true;
        name ??= person.name;
      }
    }
    return { present, name, mailboxEmail: stored?.email ?? null };
  });
  if (!found.present) {
    throw new CrmError("invalid_input", "That person isn't in your calendar.", 400, { field: "email" });
  }
  const created = await createContactFromAttendee(
    actor,
    { name: found.name, email: wanted },
    [found.mailboxEmail],
  );
  try {
    await relinkCalendar(actor);
  } catch (error) {
    console.error("Could not relink calendar events", error);
  }
  return created;
}
