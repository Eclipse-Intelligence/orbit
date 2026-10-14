import type { Db } from "@/lib/db/pool";
import {
  claimAccount,
  finishAccount,
  readAccounts,
  storeAccountToken,
} from "@/lib/crm/calendar-accounts";
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
import { currentToken, readStored, storeToken, type StoredTokens } from "@/lib/crm/inbox";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import {
  CalendarScopeError,
  fetchCalendars,
  fetchCalendarView,
  type CalendarEvent,
  type CalendarFetch,
  type CalendarInfo,
  type CalendarListFetch,
  type CalendarPerson,
} from "@/lib/microsoft/calendar";
import { grantsCalendar, sanitizeMicrosoftError, type MicrosoftToken } from "@/lib/microsoft/oauth";

const DAY_MS = 86_400_000;
export const CALENDAR_BACK_MS = 30 * DAY_MS;
export const CALENDAR_AHEAD_MS = 60 * DAY_MS;
const SYNC_GAP_MS = 5 * 60 * 1000;
const SYNC_BUDGET_MS = 45_000;
const CALENDAR_RESERVE_MS = 5_000;
const SAVE_BATCH = 200;
const MEETINGS_SHOWN = 5;
const PEOPLE_SHOWN = 25;
export const DEFAULT_CALENDAR_PLACEHOLDER = "__default__";
export const CALENDAR_RECONNECT = "Reconnect Microsoft to include your calendar.";
export const CALENDAR_NO_ACCESS = "Microsoft didn't let Orbit read this calendar.";
const NOT_CONNECTED = "Connect Microsoft to read your calendar.";
const REJECTED = /rejected the mailbox connection|could not read the saved Microsoft connection/i;

export type CalendarSyncResult = {
  ran: boolean;
  saved: number;
  removed: number;
  linked: number;
  complete: boolean;
  scopeMissing: boolean;
  calendars?: number;
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

type SyncSource = {
  kind: "connection" | "account";
  id: string;
  email: string;
  tokens: StoredTokens;
  lastAttemptAt: string | null;
  colorOffset: number;
};

type SyncTarget = { id: string; providerCalendarId: string };

type SourceOutcome = {
  saved: number;
  removed: number;
  calendars: number;
  complete: boolean;
  scopeMissing: boolean;
  error?: string;
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

export function readPerson(value: unknown): CalendarPerson | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const email = typeof item.email === "string" ? canonicalEmail(item.email) : null;
  if (!email) return null;
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
  return { name: name && !canonicalEmail(name) ? name : null, email };
}

export function readPeople(value: unknown) {
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

function sourceColumn(source: Pick<SyncSource, "kind">) {
  return source.kind === "connection" ? "connection_id" : "account_id";
}

async function saveEvents(
  db: Db,
  actor: UserActor,
  source: SyncSource,
  calendarId: string,
  events: CalendarEvent[],
) {
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
      show_as: event.showAs,
    }));
    const result = await db.query(
      `insert into crm.calendar_events (
         workspace_id, calendar_id, connection_id, account_id, user_id, provider_event_id, ical_uid,
         subject, starts_at, ends_at, is_all_day, is_cancelled, location, web_link,
         online_meeting_url, organizer, attendees, show_as
       )
       select $1, $2, $3::uuid, $4::uuid, $5, e.provider_event_id, e.ical_uid,
              e.subject, e.starts_at, e.ends_at, e.is_all_day, e.is_cancelled, e.location, e.web_link,
              e.online_meeting_url, e.organizer, coalesce(e.attendees, '[]'::jsonb), e.show_as
       from jsonb_to_recordset($6::jsonb) as e(
         provider_event_id text, ical_uid text, subject text, starts_at timestamptz,
         ends_at timestamptz, is_all_day boolean, is_cancelled boolean, location text,
         web_link text, online_meeting_url text, organizer jsonb, attendees jsonb, show_as text
       )
       on conflict (calendar_id, provider_event_id) do update set
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
         attendees = excluded.attendees,
         show_as = excluded.show_as`,
      [
        actor.workspaceId,
        calendarId,
        source.kind === "connection" ? source.id : null,
        source.kind === "account" ? source.id : null,
        actor.userId,
        JSON.stringify(batch),
      ],
    );
    saved += result.rowCount ?? 0;
  }
  return saved;
}

async function removeEvents(db: Db, calendarId: string, keep: string[] | null, windowStart: Date) {
  const result = keep
    ? await db.query(
        `delete from crm.calendar_events
         where calendar_id = $1 and provider_event_id <> all($2::text[])`,
        [calendarId, keep],
      )
    : await db.query("delete from crm.calendar_events where calendar_id = $1 and ends_at <= $2", [
        calendarId,
        windowStart.toISOString(),
      ]);
  return result.rowCount ?? 0;
}

async function saveCalendarList(
  db: Db,
  actor: UserActor,
  source: SyncSource,
  listed: CalendarListFetch,
): Promise<SyncTarget[]> {
  const column = sourceColumn(source);
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`calendars:${source.id}`]);
  const primaryDefault = listed.calendars.find((calendar) => calendar.isDefault);
  if (source.kind === "connection" && primaryDefault) {
    const existing = await db.query<{ id: string; provider_calendar_id: string }>(
      `select id, provider_calendar_id from crm.calendars
       where connection_id = $1 and provider_calendar_id = any($2::text[])`,
      [source.id, [DEFAULT_CALENDAR_PLACEHOLDER, primaryDefault.providerCalendarId]],
    );
    const placeholder = existing.rows.find((row) => row.provider_calendar_id === DEFAULT_CALENDAR_PLACEHOLDER);
    if (placeholder) {
      const taken = existing.rows.some((row) => row.provider_calendar_id === primaryDefault.providerCalendarId);
      if (taken) await db.query("delete from crm.calendars where id = $1", [placeholder.id]);
      else
        await db.query("update crm.calendars set provider_calendar_id = $2 where id = $1", [
          placeholder.id,
          primaryDefault.providerCalendarId,
        ]);
    }
  }
  if (listed.calendars.length > 0) {
    const rows = JSON.stringify(
      listed.calendars.map((calendar: CalendarInfo) => ({
        provider_calendar_id: calendar.providerCalendarId,
        name: calendar.name,
        color: calendar.color,
        color_explicit: calendar.colorExplicit,
        owner_email: calendar.ownerEmail,
        is_default: calendar.isDefault,
        can_edit: calendar.canEdit,
      })),
    );
    await db.query(
      `insert into crm.calendars (
         workspace_id, user_id, ${column}, provider_calendar_id, name, color, owner_email,
         is_default, can_edit, use_for_crm
       )
       select $1, $2, $3, c.provider_calendar_id, c.name, c.color, c.owner_email,
              c.is_default, c.can_edit, $4::boolean and c.is_default
       from jsonb_to_recordset($5::jsonb) as c(
         provider_calendar_id text, name text, color text, owner_email text,
         is_default boolean, can_edit boolean
       )
       on conflict (user_id, coalesce(account_id, connection_id), provider_calendar_id) do update set
         name = excluded.name,
         owner_email = excluded.owner_email,
         is_default = excluded.is_default,
         can_edit = excluded.can_edit`,
      [actor.workspaceId, actor.userId, source.id, source.kind === "connection", rows],
    );
    await db.query(
      `update crm.calendars c
       set color = x.color
       from jsonb_to_recordset($2::jsonb) as x(provider_calendar_id text, color text, color_explicit boolean)
       where c.${column} = $1 and c.provider_calendar_id = x.provider_calendar_id
         and x.color_explicit and c.color <> x.color`,
      [source.id, rows],
    );
  }
  if (listed.complete) {
    await db.query(
      `delete from crm.calendars
       where ${column} = $1 and provider_calendar_id <> all($2::text[])`,
      [source.id, listed.calendars.map((calendar) => calendar.providerCalendarId)],
    );
  }
  const targets = await db.query<{ id: string; provider_calendar_id: string }>(
    `select id, provider_calendar_id from crm.calendars
     where ${column} = $1 and (is_visible or use_for_crm)
       and provider_calendar_id <> $2
     order by last_attempt_at asc nulls first, is_default desc, name`,
    [source.id, DEFAULT_CALENDAR_PLACEHOLDER],
  );
  return targets.rows.map((row) => ({ id: row.id, providerCalendarId: row.provider_calendar_id }));
}

async function saveCalendarEvents(
  db: Db,
  actor: UserActor,
  source: SyncSource,
  calendar: SyncTarget,
  fetched: CalendarFetch,
  window: { start: Date },
  now: number,
) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`calendar:${calendar.id}`]);
  const saved = await saveEvents(db, actor, source, calendar.id, fetched.events);
  const removed = await removeEvents(
    db,
    calendar.id,
    fetched.complete ? fetched.events.map((event) => event.providerEventId) : null,
    window.start,
  );
  await db.query(
    `update crm.calendars
     set last_attempt_at = now(),
         last_synced_at = coalesce($2::timestamptz, last_synced_at),
         last_error = null
     where id = $1`,
    [calendar.id, fetched.complete ? new Date(now).toISOString() : null],
  );
  return { saved, removed };
}

async function markCalendarError(db: Db, calendarId: string, error: string) {
  await db.query(
    "update crm.calendars set last_attempt_at = now(), last_error = $2 where id = $1",
    [calendarId, error.slice(0, 500)],
  );
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((id) => set.has(id));
}

export async function ownAddresses(db: Db, actor: UserActor) {
  const stored = await readStored(db, actor);
  const accounts = await db.query<{ email: string }>(
    "select email from crm.calendar_accounts where user_id = $1 and workspace_id = $2",
    [actor.userId, actor.workspaceId],
  );
  return [actor.email, stored?.email, ...accounts.rows.map((row) => row.email)];
}

async function linkEvents(db: Db, actor: UserActor) {
  await db.query(
    `update crm.calendar_events e
     set contact_ids = '{}', company_ids = '{}'
     from crm.calendars c
     where c.id = e.calendar_id and not c.use_for_crm
       and e.user_id = $1 and e.workspace_id = $2
       and (cardinality(e.contact_ids) > 0 or cardinality(e.company_ids) > 0)`,
    [actor.userId, actor.workspaceId],
  );
  const events = await db.query<{
    id: string;
    organizer: unknown;
    attendees: unknown;
    contact_ids: string[];
    company_ids: string[];
  }>(
    `select e.id, e.organizer, e.attendees, e.contact_ids, e.company_ids
     from crm.calendar_events e
     join crm.calendars c on c.id = e.calendar_id and c.use_for_crm
     where e.user_id = $1 and e.workspace_id = $2`,
    [actor.userId, actor.workspaceId],
  );
  if (events.rows.length === 0) return 0;
  const internal = await internalAddresses(db, actor.workspaceId, await ownAddresses(db, actor));
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
  return withActor(actor, (db) => linkEvents(db, actor));
}

async function readSources(actor: UserActor, accountId?: string) {
  return withActor(actor, async (db) => {
    const sources: SyncSource[] = [];
    if (!accountId) {
      const stored = await readStored(db, actor);
      if (stored && stored.status === "connected" && stored.refreshTokenCipher) {
        const state = await db.query<{ last_attempt_at: Date | string | null }>(
          "select last_attempt_at from crm.integration_state where connection_id = $1 and source = 'calendar'",
          [stored.id],
        );
        sources.push({
          kind: "connection",
          id: stored.id,
          email: stored.email,
          tokens: stored,
          lastAttemptAt: iso(state.rows[0]?.last_attempt_at ?? null),
          colorOffset: 0,
        });
      }
    }
    const accounts = await readAccounts(db, actor);
    for (const [index, account] of accounts.entries()) {
      if (accountId && account.id !== accountId) continue;
      if (account.status !== "connected" || !account.refreshTokenCipher) continue;
      sources.push({
        kind: "account",
        id: account.id,
        email: account.email,
        tokens: account,
        lastAttemptAt: account.lastAttemptAt,
        colorOffset: (index + 1) * 3,
      });
    }
    sources.sort((left, right) => (left.lastAttemptAt ?? "").localeCompare(right.lastAttemptAt ?? ""));
    return sources;
  });
}

async function claimSource(actor: UserActor, source: SyncSource, force: boolean) {
  return withActor(actor, async (db) => {
    if (source.kind === "account") return claimAccount(db, source.id, force, SYNC_GAP_MS);
    return Boolean(await claimIntegration(db, calendarKey(actor, source.id), force, SYNC_GAP_MS));
  });
}

async function finishSource(
  actor: UserActor,
  source: SyncSource,
  values: { syncedAt?: string | null; error: string | null; scopeMissing: boolean },
) {
  await withActor(actor, async (db) => {
    if (source.kind === "account") {
      await finishAccount(db, source.id, values);
      return;
    }
    const key = calendarKey(actor, source.id);
    await finishIntegration(db, key, { syncedAt: values.syncedAt, error: values.error });
    await setScopeMissing(db, key, values.scopeMissing);
  });
}

async function saveSourceToken(actor: UserActor, source: SyncSource, token: MicrosoftToken) {
  await withActor(actor, (db) =>
    source.kind === "account" ? storeAccountToken(db, source.id, token) : storeToken(db, source.id, token),
  );
}

async function syncSource(
  actor: UserActor,
  source: SyncSource,
  context: { fetchImpl: typeof fetch; deadline: number; now: number },
): Promise<SourceOutcome> {
  const outcome: SourceOutcome = { saved: 0, removed: 0, calendars: 0, complete: true, scopeMissing: false };
  const window = calendarWindow(context.now);
  const missing = async () => {
    await finishSource(actor, source, { error: null, scopeMissing: true });
    return { ...outcome, complete: false, scopeMissing: true };
  };
  try {
    const token = await currentToken(source.tokens, context.fetchImpl);
    if (token.expiresAt !== source.tokens.accessTokenExpiresAt) await saveSourceToken(actor, source, token);
    if (grantsCalendar(token.scope) === false) return await missing();
    const listed = await fetchCalendars(token.accessToken, {
      fetchImpl: context.fetchImpl,
      deadline: context.deadline,
      colorOffset: source.colorOffset,
    });
    if (!listed.complete) outcome.complete = false;
    const targets = await withActor(actor, (db) => saveCalendarList(db, actor, source, listed));
    for (const calendar of targets) {
      if (context.deadline - Date.now() < CALENDAR_RESERVE_MS) {
        outcome.complete = false;
        break;
      }
      try {
        const fetched = await fetchCalendarView(token.accessToken, window, {
          fetchImpl: context.fetchImpl,
          deadline: context.deadline,
          calendarId: calendar.providerCalendarId,
        });
        const saved = await withActor(actor, (db) =>
          saveCalendarEvents(db, actor, source, calendar, fetched, window, context.now),
        );
        outcome.saved += saved.saved;
        outcome.removed += saved.removed;
        outcome.calendars += 1;
        if (!fetched.complete) outcome.complete = false;
      } catch (error) {
        if (error instanceof CalendarScopeError) {
          await withActor(actor, (db) => markCalendarError(db, calendar.id, CALENDAR_NO_ACCESS));
          continue;
        }
        const message = sanitizeMicrosoftError(errorText(error, "Could not sync the calendar."));
        await withActor(actor, (db) => markCalendarError(db, calendar.id, message));
        outcome.complete = false;
        outcome.error ??= message;
        if (REJECTED.test(message)) break;
      }
    }
    await finishSource(actor, source, {
      syncedAt: outcome.complete ? new Date(context.now).toISOString() : null,
      error: outcome.error ?? null,
      scopeMissing: false,
    });
    return outcome;
  } catch (error) {
    if (error instanceof CalendarScopeError) return missing();
    const message = sanitizeMicrosoftError(errorText(error, "Could not sync the calendar."));
    await finishSource(actor, source, { error: message, scopeMissing: false });
    return { ...outcome, complete: false, error: message };
  }
}

export async function syncCalendar(
  actor: UserActor,
  options: {
    fetchImpl?: typeof fetch;
    deadline?: number;
    force?: boolean;
    now?: number;
    accountId?: string;
  } = {},
): Promise<CalendarSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = options.deadline ?? Date.now() + SYNC_BUDGET_MS;
  const result: CalendarSyncResult = {
    ran: false,
    saved: 0,
    removed: 0,
    linked: 0,
    complete: false,
    scopeMissing: false,
    calendars: 0,
  };
  const sources = await readSources(actor, options.accountId);
  if (sources.length === 0) return { ...result, error: NOT_CONNECTED };
  const now = options.now ?? Date.now();
  let complete = true;
  let firstError: string | undefined;
  for (const source of sources) {
    if (deadline - Date.now() < CALENDAR_RESERVE_MS) {
      complete = false;
      break;
    }
    const claimed = await claimSource(actor, source, Boolean(options.force));
    if (!claimed) continue;
    result.ran = true;
    const outcome = await syncSource(actor, source, { fetchImpl, deadline, now });
    result.saved += outcome.saved;
    result.removed += outcome.removed;
    result.calendars = (result.calendars ?? 0) + outcome.calendars;
    if (!outcome.complete) complete = false;
    if (source.kind === "connection" && outcome.scopeMissing) result.scopeMissing = true;
    if (outcome.error && (!firstError || source.kind === "connection")) firstError = outcome.error;
  }
  if (!result.ran) return { ...result, complete: false };
  try {
    result.linked = await relinkCalendar(actor);
  } catch (error) {
    console.error("Could not relink calendar events", error);
  }
  result.complete = complete && !result.scopeMissing;
  if (firstError) result.error = firstError;
  return result;
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
      : "(a.company_id = $3 or a.contact_id = any(m.contact_ids))";
    const select = (upcoming: boolean) =>
      db.query<EventRow>(
        `select m.id, m.subject, m.starts_at, m.ends_at, m.is_all_day, m.location, m.web_link,
                m.online_meeting_url, m.organizer, jsonb_array_length(m.attendees)::int as attendee_count,
                g.id as granola_activity_id
         from (
           select distinct on (coalesce(e.ical_uid, e.id::text)) e.*
           from crm.calendar_events e
           join crm.calendars c on c.id = e.calendar_id and c.use_for_crm
           where e.user_id = $1 and e.workspace_id = $2
             and e.${column} @> array[$3]::uuid[]
             and not e.is_cancelled
             and ${upcoming ? "e.ends_at > $4" : "e.ends_at <= $4"}
           order by coalesce(e.ical_uid, e.id::text), (e.connection_id is not null) desc, c.is_default desc, e.id
         ) m
         left join lateral (
           select a.id from crm.activities a
           where a.workspace_id = m.workspace_id
             and a.type = 'meeting'
             and a.metadata->>'source' = 'granola'
             and a.occurred_at between m.starts_at - interval '2 hours' and m.starts_at + interval '2 hours'
             and ${notes}
           order by abs(extract(epoch from a.occurred_at - m.starts_at))
           limit 1
         ) g on true
         order by m.starts_at ${upcoming ? "asc" : "desc"}
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
    const events = await db.query<{
      ical_uid: string | null;
      subject: string | null;
      starts_at: Date | string;
      organizer: unknown;
      attendees: unknown;
    }>(
      `select e.ical_uid, e.subject, e.starts_at, e.organizer, e.attendees
       from crm.calendar_events e
       join crm.calendars c on c.id = e.calendar_id and c.use_for_crm
       where e.user_id = $1 and e.workspace_id = $2 and not e.is_cancelled
       order by e.starts_at desc`,
      [actor.userId, actor.workspaceId],
    );
    if (events.rows.length === 0) return [];
    const internal = await internalAddresses(db, actor.workspaceId, await ownAddresses(db, actor));
    const people = new Map<string, MetPerson>();
    const meetings = new Set<string>();
    for (const row of events.rows) {
      const startsAt = iso(row.starts_at)!;
      if (row.ical_uid) {
        const key = `${row.ical_uid}|${startsAt}`;
        if (meetings.has(key)) continue;
        meetings.add(key);
      }
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

export function wantedEmail(email: unknown) {
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

export async function createContactFromPerson(
  actor: UserActor,
  person: { name: string | null; email: string },
  own: (string | null | undefined)[],
) {
  const created = await createContactFromAttendee(actor, person, own);
  try {
    await relinkCalendar(actor);
  } catch (error) {
    console.error("Could not relink calendar events", error);
  }
  return created;
}

export async function createContactFromMeeting(actor: UserActor, email: string) {
  const wanted = wantedEmail(email);
  const found = await withActor(actor, async (db) => {
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
    return { present, name, own: await ownAddresses(db, actor) };
  });
  if (!found.present) {
    throw new CrmError("invalid_input", "That person isn't in your calendar.", 400, { field: "email" });
  }
  return createContactFromPerson(actor, { name: found.name, email: wanted }, found.own);
}
