import { readAccounts, type CalendarProvider } from "@/lib/crm/calendar-accounts";
import {
  createContactFromPerson,
  ownAddresses,
  readPeople,
  readPerson,
  relinkCalendar,
  wantedEmail,
  DEFAULT_CALENDAR_PLACEHOLDER,
} from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { internalAddresses } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { readStored } from "@/lib/crm/inbox";
import { isUuid } from "@/lib/crm/mutate";
import { maskFeedUrl } from "@/lib/ical/fetch";
import { assertScope } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";

const EVENTS_SHOWN = 1500;
const STALE_MS = 10 * 60 * 1000;

export type CalendarEntry = {
  id: string;
  name: string;
  color: string;
  isDefault: boolean;
  isVisible: boolean;
  useForCrm: boolean;
  canEdit: boolean;
  ownerEmail: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type CalendarGroup = {
  kind: "primary" | "account";
  provider: CalendarProvider;
  id: string;
  email: string | null;
  label: string;
  displayName: string | null;
  connected: boolean;
  scopeMissing: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  calendars: CalendarEntry[];
};

export type EventPerson = {
  name: string | null;
  email: string;
  response: string | null;
  contactId: string | null;
  internal: boolean;
};

export type CalendarItem = {
  id: string;
  calendarId: string;
  subject: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  showAs: string | null;
  location: string | null;
  webLink: string | null;
  joinUrl: string | null;
  organizer: EventPerson | null;
  attendees: EventPerson[];
  granolaHref: string | null;
};

type CalendarRow = {
  id: string;
  account_id: string | null;
  connection_id: string | null;
  name: string;
  color: string;
  is_default: boolean;
  is_visible: boolean;
  use_for_crm: boolean;
  can_edit: boolean;
  owner_email: string | null;
  last_synced_at: Date | string | null;
  last_error: string | null;
};

function iso(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function mapCalendar(row: CalendarRow): CalendarEntry {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isDefault: row.is_default,
    isVisible: row.is_visible,
    useForCrm: row.use_for_crm,
    canEdit: row.can_edit,
    ownerEmail: row.owner_email,
    lastSyncedAt: iso(row.last_synced_at),
    lastError: row.last_error,
  };
}

export async function listCalendarGroups(actor: UserActor): Promise<CalendarGroup[]> {
  return withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    const accounts = await readAccounts(db, actor);
    const calendars = await db.query<CalendarRow>(
      `select id, account_id, connection_id, name, color, is_default, is_visible, use_for_crm, can_edit,
              owner_email, last_synced_at, last_error
       from crm.calendars
       where user_id = $1 and workspace_id = $2
       order by is_default desc, lower(name), id`,
      [actor.userId, actor.workspaceId],
    );
    const groups: CalendarGroup[] = [];
    if (stored) {
      const state = await db.query<{
        scope_missing: boolean;
        last_synced_at: Date | string | null;
        last_error: string | null;
      }>(
        `select scope_missing, last_synced_at, last_error from crm.integration_state
         where connection_id = $1 and source = 'calendar'`,
        [stored.id],
      );
      groups.push({
        kind: "primary",
        provider: "microsoft",
        id: stored.id,
        email: stored.email,
        label: stored.email,
        displayName: null,
        connected: stored.status === "connected" && Boolean(stored.refreshTokenCipher),
        scopeMissing: Boolean(state.rows[0]?.scope_missing),
        lastSyncedAt: iso(state.rows[0]?.last_synced_at ?? null),
        lastError: state.rows[0]?.last_error ?? null,
        calendars: calendars.rows.filter((row) => row.connection_id === stored.id).map(mapCalendar),
      });
    }
    for (const account of accounts) {
      groups.push({
        kind: "account",
        provider: account.provider,
        id: account.id,
        email: account.email,
        label: account.feed ? maskFeedUrl(account.feed.host) : (account.email ?? "Calendar"),
        displayName: account.displayName,
        connected:
          account.status === "connected" &&
          (account.provider === "ics" ? Boolean(account.feed) : Boolean(account.refreshTokenCipher)),
        scopeMissing: account.scopeMissing,
        lastSyncedAt: account.lastSyncedAt,
        lastError: account.lastError,
        calendars: calendars.rows.filter((row) => row.account_id === account.id).map(mapCalendar),
      });
    }
    return groups;
  });
}

async function updateCalendar(
  actor: UserActor,
  calendarId: string,
  column: "is_visible" | "use_for_crm",
  value: boolean,
) {
  if (!isUuid(calendarId)) throw new CrmError("not_found", "That calendar isn't connected.", 404);
  const row = await withActor(actor, async (db) => {
    const result = await db.query<{ last_synced_at: Date | string | null; provider_calendar_id: string }>(
      `update crm.calendars set ${column} = $4
       where id = $1 and user_id = $2 and workspace_id = $3
       returning last_synced_at, provider_calendar_id`,
      [calendarId, actor.userId, actor.workspaceId, value],
    );
    return result.rows[0] ?? null;
  });
  if (!row) throw new CrmError("not_found", "That calendar isn't connected.", 404);
  const synced = row.last_synced_at ? new Date(row.last_synced_at).getTime() : 0;
  return {
    needsSync: value && row.provider_calendar_id !== DEFAULT_CALENDAR_PLACEHOLDER && Date.now() - synced > STALE_MS,
  };
}

export async function setCalendarVisible(actor: UserActor, calendarId: string, visible: boolean) {
  return updateCalendar(actor, calendarId, "is_visible", visible);
}

export async function setCalendarForCrm(actor: UserActor, calendarId: string, useForCrm: boolean) {
  const result = await updateCalendar(actor, calendarId, "use_for_crm", useForCrm);
  await relinkCalendar(actor);
  return result;
}

type ItemRow = {
  id: string;
  calendar_id: string;
  subject: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  is_all_day: boolean;
  show_as: string | null;
  location: string | null;
  web_link: string | null;
  online_meeting_url: string | null;
  organizer: unknown;
  attendees: unknown;
  granola_id: string | null;
  granola_contact_id: string | null;
  granola_company_id: string | null;
};

function readResponse(value: unknown, email: string) {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.email === "string" && item.email.toLowerCase() === email) {
      return typeof item.response === "string" ? item.response : null;
    }
  }
  return null;
}

export async function listCalendarItems(
  actor: UserActor,
  range: { start: Date; end: Date },
): Promise<CalendarItem[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<ItemRow>(
      `select e.id, e.calendar_id, e.subject, e.starts_at, e.ends_at, e.is_all_day, e.show_as,
              e.location, e.web_link, e.online_meeting_url, e.organizer, e.attendees,
              g.id as granola_id, g.contact_id as granola_contact_id, g.company_id as granola_company_id
       from crm.calendar_events e
       join crm.calendars c on c.id = e.calendar_id and c.is_visible
       left join lateral (
         select a.id, a.contact_id, a.company_id from crm.activities a
         where a.workspace_id = e.workspace_id
           and a.type = 'meeting'
           and a.metadata->>'source' = 'granola'
           and a.occurred_at between e.starts_at - interval '2 hours' and e.starts_at + interval '2 hours'
           and (a.contact_id = any(e.contact_ids) or a.company_id = any(e.company_ids))
         order by abs(extract(epoch from a.occurred_at - e.starts_at))
         limit 1
       ) g on true
       where e.user_id = $1 and e.workspace_id = $2
         and not e.is_cancelled
         and e.starts_at < $4
         and (e.ends_at > $3 or e.starts_at >= $3)
       order by e.starts_at, e.ends_at desc, e.id
       limit ${EVENTS_SHOWN}`,
      [actor.userId, actor.workspaceId, range.start.toISOString(), range.end.toISOString()],
    );
    const emails = new Set<string>();
    for (const row of result.rows) {
      for (const person of [readPerson(row.organizer), ...readPeople(row.attendees)]) {
        if (person) emails.add(person.email);
      }
    }
    const contacts = new Map<string, string>();
    if (emails.size > 0) {
      const found = await db.query<{ id: string; normalized_email: string }>(
        `select id, normalized_email from crm.contacts
         where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])
         order by created_at`,
        [actor.workspaceId, [...emails]],
      );
      for (const row of found.rows) {
        if (!contacts.has(row.normalized_email)) contacts.set(row.normalized_email, row.id);
      }
    }
    const internal = await internalAddresses(db, actor.workspaceId, await ownAddresses(db, actor));
    const describe = (person: { name: string | null; email: string } | null, response: string | null) =>
      person
        ? {
            name: person.name,
            email: person.email,
            response,
            contactId: contacts.get(person.email) ?? null,
            internal: internal.isInternal(person.email),
          }
        : null;
    return result.rows.map((row) => {
      const granolaHref = row.granola_id
        ? row.granola_contact_id
          ? `${contactHref(row.granola_contact_id)}#activity-${row.granola_id}`
          : row.granola_company_id
            ? `${companyHref(row.granola_company_id)}#activity-${row.granola_id}`
            : null
        : null;
      return {
        id: row.id,
        calendarId: row.calendar_id,
        subject: row.subject,
        startsAt: iso(row.starts_at)!,
        endsAt: iso(row.ends_at)!,
        isAllDay: row.is_all_day,
        showAs: row.show_as,
        location: row.location,
        webLink: row.web_link,
        joinUrl: row.online_meeting_url,
        organizer: describe(readPerson(row.organizer), null),
        attendees: readPeople(row.attendees).map(
          (person) => describe(person, readResponse(row.attendees, person.email))!,
        ),
        granolaHref,
      };
    });
  });
}

export async function createContactFromEvent(actor: UserActor, eventId: string, email: string) {
  const wanted = wantedEmail(email);
  if (!isUuid(eventId)) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  const found = await withActor(actor, async (db) => {
    const result = await db.query<{ organizer: unknown; attendees: unknown }>(
      `select organizer, attendees from crm.calendar_events
       where id = $1 and user_id = $2 and workspace_id = $3`,
      [eventId, actor.userId, actor.workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const person = [readPerson(row.organizer), ...readPeople(row.attendees)].find(
      (item) => item?.email === wanted,
    );
    return { person: person ?? null, own: await ownAddresses(db, actor) };
  });
  if (!found) throw new CrmError("not_found", "That meeting isn't in your calendar.", 404);
  if (!found.person) {
    throw new CrmError("invalid_input", "That person isn't in this meeting.", 400, { field: "email" });
  }
  return createContactFromPerson(actor, found.person, found.own);
}
