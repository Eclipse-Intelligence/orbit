import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ClickUpTask } from "@/lib/clickup";
import {
  createContactFromMeeting,
  getCalendarStatus,
  getMeetings,
  hideAttendee,
  listPeopleMet,
  resetCalendarSync,
  syncCalendar,
} from "@/lib/crm/calendar";
import { findClickUpLink } from "@/lib/crm/clickup";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { createContactFromAttendee, ensureIntegration } from "@/lib/crm/conversations";
import { saveMailbox, syncMailbox } from "@/lib/crm/inbox";
import { saveOtherEmails } from "@/lib/crm/profile";
import { DEFAULT_STEPS } from "@/lib/crm/scheduler";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  calendarViewUrl,
  fetchCalendarView,
  graphInstant,
  toCalendarEvent,
  type GraphEvent,
} from "@/lib/microsoft/calendar";
import { grantsCalendar, MICROSOFT_SCOPES } from "@/lib/microsoft/oauth";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Call = { url: string; init?: RequestInit };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function utc(at: number) {
  return { dateTime: new Date(at).toISOString().replace("Z", "0000"), timeZone: "UTC" };
}

function graphEvent(
  id: string,
  startsAt: number,
  extra: Partial<GraphEvent> & { people?: { name?: string; email: string; type?: string }[] } = {},
): GraphEvent {
  const { people, ...rest } = extra;
  return {
    id,
    iCalUId: `ical-${id}`,
    subject: `Meeting ${id}`,
    start: utc(startsAt),
    end: utc(startsAt + HOUR),
    isAllDay: false,
    isCancelled: false,
    location: { displayName: "Room 1" },
    webLink: `https://outlook.office365.com/owa/?itemid=${id}`,
    onlineMeeting: { joinUrl: `https://teams.microsoft.com/l/meetup-join/${id}` },
    organizer: { emailAddress: { name: "Founder", address: "founder@orbit-calendar.test" } },
    attendees: (people ?? []).map((person) => ({
      type: person.type ?? "required",
      status: { response: "accepted" },
      emailAddress: { name: person.name ?? person.email, address: person.email },
    })),
    ...rest,
  };
}

export const MAIN_CALENDARS = [
  { id: "cal-main", name: "Calendar", isDefaultCalendar: true, hexColor: "", color: "auto", canEdit: true },
];

function isCalendarList(url: string) {
  return new URL(url).pathname.endsWith("/me/calendars");
}

function graphStub(
  pages: () => GraphEvent[][],
  calls: Call[],
  options: { status?: number; code?: string; calendars?: unknown[] } = {},
) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (options.status) return json({ error: { code: options.code, message: "Access is denied." } }, options.status);
    const parsed = new URL(url);
    if (isCalendarList(url)) return json({ value: options.calendars ?? MAIN_CALENDARS });
    const list = pages();
    const page = Number(parsed.searchParams.get("page") ?? "0");
    const next = page + 1 < list.length ? `${parsed.origin}${parsed.pathname}?page=${page + 1}` : undefined;
    return json({ value: list[page] ?? [], ...(next ? { "@odata.nextLink": next } : {}) });
  }) as typeof fetch;
}

async function connect(actor: UserActor, email: string, expiresAt = new Date(Date.now() + HOUR).toISOString()) {
  await saveMailbox(actor, {
    email,
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt,
  });
}

async function eventRows(userId: string) {
  const result = await getAdminPool().query<{
    provider_event_id: string;
    subject: string | null;
    starts_at: Date;
    is_cancelled: boolean;
    contact_ids: string[];
    company_ids: string[];
    attendees: { name: string | null; email: string; response: string | null }[];
  }>(
    `select provider_event_id, subject, starts_at, is_cancelled, contact_ids, company_ids, attendees
     from crm.calendar_events where user_id = $1 order by provider_event_id`,
    [userId],
  );
  return new Map(result.rows.map((row) => [row.provider_event_id, row]));
}

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
});

after(async () => {
  await getPool().end();
});

describe("graph calendar view", () => {
  it("asks for the default scopes including the calendar", () => {
    assert.equal(MICROSOFT_SCOPES, "offline_access Mail.Read Mail.Send User.Read Calendars.ReadWrite");
    assert.equal(grantsCalendar("openid https://graph.microsoft.com/Calendars.Read Mail.Read"), true);
    assert.equal(grantsCalendar("https%3A%2F%2Fgraph.microsoft.com%2Fcalendars.readwrite"), true);
    assert.equal(grantsCalendar("Mail.Read Mail.Send User.Read"), false);
    assert.equal(grantsCalendar(null), null);
    assert.equal(grantsCalendar(""), null);
  });

  it("reads UTC and zoned graph times", () => {
    assert.equal(
      graphInstant({ dateTime: "2026-10-16T13:00:00.0000000", timeZone: "UTC" }),
      "2026-10-16T13:00:00.000Z",
    );
    assert.equal(
      graphInstant({ dateTime: "2026-10-16T14:00:00.0000000", timeZone: "Europe/London" }),
      "2026-10-16T13:00:00.000Z",
    );
    assert.equal(graphInstant({ dateTime: "2026-10-16T13:00:00", timeZone: null }), "2026-10-16T13:00:00.000Z");
    assert.equal(graphInstant({ dateTime: "not a date", timeZone: "UTC" }), null);
    assert.equal(graphInstant(null), null);
  });

  it("drops rooms, cleans attendees and prefers the join url", () => {
    const event = toCalendarEvent({
      ...graphEvent("e1", Date.UTC(2026, 9, 16, 13)),
      attendees: [
        { type: "required", status: { response: "accepted" }, emailAddress: { name: "Jane", address: "JANE@Acme.com" } },
        { type: "resource", emailAddress: { name: "Room", address: "room@acme.com" } },
        { type: "optional", status: { response: "none" }, emailAddress: { name: "jane@acme.com", address: "jane@acme.com" } },
        { type: "optional", emailAddress: { name: "bob@acme.com", address: "bob@acme.com" } },
        { type: "optional", emailAddress: { name: "No address" } },
      ],
      onlineMeetingUrl: "https://example.com/legacy",
      webLink: "javascript:alert(1)",
    })!;
    assert.deepEqual(event.attendees, [
      { name: "Jane", email: "jane@acme.com", response: "accepted" },
      { name: null, email: "bob@acme.com", response: null },
    ]);
    assert.equal(event.onlineMeetingUrl, "https://teams.microsoft.com/l/meetup-join/e1");
    assert.equal(event.webLink, null);
    assert.equal(event.startsAt, "2026-10-16T13:00:00.000Z");
    assert.equal(toCalendarEvent({ id: "", start: utc(0), end: utc(0) }), null);
  });

  it("pages with nextLink, asks for UTC and stops at the page cap", async () => {
    const start = new Date("2026-09-14T12:00:00.000Z");
    const end = new Date("2026-12-13T12:00:00.000Z");
    const first = new URL(calendarViewUrl(start, end));
    assert.equal(first.pathname, "/v1.0/me/calendarView");
    assert.equal(first.searchParams.get("startDateTime"), "2026-09-14T12:00:00.000Z");
    assert.equal(first.searchParams.get("endDateTime"), "2026-12-13T12:00:00.000Z");
    assert.equal(first.searchParams.get("$top"), "100");
    assert.match(first.searchParams.get("$select") ?? "", /attendees/);
    assert.match(first.searchParams.get("$select") ?? "", /onlineMeeting,/);

    const at = Date.UTC(2026, 9, 16, 13);
    const pages = [[graphEvent("a", at), graphEvent("b", at)], [graphEvent("b", at), graphEvent("c", at)], [graphEvent("d", at)]];
    const calls: Call[] = [];
    const fetched = await fetchCalendarView("token", { start, end }, { fetchImpl: graphStub(() => pages, calls) });
    assert.equal(fetched.complete, true);
    assert.deepEqual(
      fetched.events.map((event) => event.providerEventId),
      ["a", "b", "c", "d"],
    );
    assert.equal(calls.length, 3);
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.prefer, 'outlook.timezone="UTC"');
    assert.equal(headers.authorization, "Bearer token");

    const capped: Call[] = [];
    const partial = await fetchCalendarView(
      "token",
      { start, end },
      { fetchImpl: graphStub(() => pages, capped), pageLimit: 2 },
    );
    assert.equal(partial.complete, false);
    assert.equal(capped.length, 2);

    const outOfTime = await fetchCalendarView(
      "token",
      { start, end },
      { fetchImpl: graphStub(() => pages, []), deadline: Date.now() + 1000 },
    );
    assert.equal(outOfTime.complete, false);
    assert.equal(outOfTime.events.length, 0);

    const foreign = (async () =>
      json({ value: [graphEvent("x", at)], "@odata.nextLink": "https://evil.example/next" })) as typeof fetch;
    const stopped = await fetchCalendarView("token", { start, end }, { fetchImpl: foreign });
    assert.equal(stopped.complete, false);
    assert.equal(stopped.events.length, 1);
  });
});

describe("calendar sync", () => {
  let owner: UserActor;
  let acmeId: string;
  let janeId: string;
  let gmailCompanyId: string;
  let pages: GraphEvent[][];
  const now = Date.now();

  before(async () => {
    owner = await createUser("founder@orbit-calendar.test", "Founder");
    await saveOtherEmails(owner, ["founder@ridgeon.me"]);
    await connect(owner, "founder@orbit-calendar.test");
    acmeId = (await createCompany(owner, { name: "Acme", domain: "acme.com" })).body.company.id;
    gmailCompanyId = (await createCompany(owner, { name: "Gmail people", domain: "gmail.com" })).body.company.id;
    await createCompany(owner, { name: "Ridgeon", domain: "ridgeon.me" });
    janeId = (
      await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.com", companyId: acmeId })
    ).body.contact.id;
  });

  beforeEach(async () => {
    await getAdminPool().query(
      "update crm.integration_state set last_attempt_at = null where source = 'calendar'",
    );
  });

  it("stores the window, links contacts and companies, and skips internal and free-mail domains", async () => {
    pages = [
      [
        graphEvent("past", now - 2 * DAY, {
          subject: "Renewal kickoff",
          people: [
            { name: "Jane Doe", email: "jane@acme.com" },
            { name: "Partner", email: "partner@ridgeon.me" },
            { name: "Me", email: "founder@ridgeon.me" },
          ],
        }),
        graphEvent("next", now + 2 * DAY, {
          subject: "Renewal review",
          people: [{ name: "Raj", email: "raj@acme.com" }],
        }),
      ],
      [
        graphEvent("gmail", now + 3 * DAY, {
          people: [{ name: "Pat", email: "pat@gmail.com" }],
        }),
        graphEvent("cancelled", now + 4 * DAY, { isCancelled: true, people: [{ email: "jane@acme.com" }] }),
      ],
    ];
    const calls: Call[] = [];
    const result = await syncCalendar(owner, { fetchImpl: graphStub(() => pages, calls), now });
    assert.equal(result.ran, true, result.error);
    assert.equal(result.error, undefined);
    assert.equal(result.complete, true);
    assert.equal(result.saved, 4);
    assert.ok(isCalendarList(calls[0].url));
    const url = new URL(calls[1].url);
    assert.equal(url.pathname, "/v1.0/me/calendars/cal-main/calendarView");
    assert.equal(url.searchParams.get("startDateTime"), new Date(now - 30 * DAY).toISOString());
    assert.equal(url.searchParams.get("endDateTime"), new Date(now + 60 * DAY).toISOString());

    const rows = await eventRows(owner.userId);
    assert.deepEqual(rows.get("past")!.contact_ids, [janeId]);
    assert.deepEqual(rows.get("past")!.company_ids, [acmeId]);
    assert.deepEqual(rows.get("next")!.contact_ids, []);
    assert.deepEqual(rows.get("next")!.company_ids, [acmeId]);
    assert.deepEqual(rows.get("gmail")!.company_ids, []);
    assert.equal(rows.get("cancelled")!.is_cancelled, true);
    assert.ok(!rows.get("gmail")!.company_ids.includes(gmailCompanyId));

    const again = await syncCalendar(owner, { fetchImpl: graphStub(() => pages, []), now });
    assert.equal(again.ran, false);

    const status = await getCalendarStatus(owner);
    assert.equal(status?.scopeMissing, false);
    assert.equal(status?.lastSyncedAt, new Date(now).toISOString());
  });

  it("updates changed events and removes vanished ones only after a complete fetch", async () => {
    pages = [
      [
        graphEvent("past", now - 2 * DAY, {
          subject: "Renewal kickoff (moved)",
          people: [{ name: "Jane Doe", email: "jane@acme.com" }],
        }),
        graphEvent("next", now + 2 * DAY, {
          subject: "Renewal review",
          people: [{ name: "Raj", email: "raj@acme.com" }],
        }),
      ],
      [graphEvent("gmail", now + 3 * DAY, { people: [{ name: "Pat", email: "pat@gmail.com" }] })],
    ];
    const failing = await syncCalendar(owner, {
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (isCalendarList(String(input))) return json({ value: MAIN_CALENDARS });
        if (new URL(String(input)).searchParams.get("page")) return json({ error: { message: "Page two failed" } }, 503);
        return json({ value: pages[0], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?page=1" });
      }) as typeof fetch,
      now,
    });
    assert.equal(failing.error, "Page two failed");
    assert.equal((await eventRows(owner.userId)).size, 4);

    await getAdminPool().query("update crm.integration_state set last_attempt_at = null where source = 'calendar'");
    const capped = await syncCalendar(owner, {
      fetchImpl: graphStub(() => [pages[0], ...Array<GraphEvent[]>(20).fill([])], []),
      now,
    });
    assert.equal(capped.complete, false);
    assert.equal((await eventRows(owner.userId)).size, 4);

    await getAdminPool().query("update crm.integration_state set last_attempt_at = null where source = 'calendar'");
    const full = await syncCalendar(owner, { fetchImpl: graphStub(() => pages, []), now });
    assert.equal(full.complete, true);
    assert.equal(full.removed, 1);
    const rows = await eventRows(owner.userId);
    assert.deepEqual([...rows.keys()], ["gmail", "next", "past"]);
    assert.equal(rows.get("past")!.subject, "Renewal kickoff (moved)");
  });

  it("shows upcoming and recent meetings with Granola notes nearby", async () => {
    const granola = await getAdminPool().query<{ id: string }>(
      `insert into crm.activities (workspace_id, type, title, occurred_at, contact_id, company_id, metadata)
       values ($1, 'meeting', 'Renewal kickoff', $2, $3, $4, '{"source":"granola"}'::jsonb)
       returning id`,
      [owner.workspaceId, new Date(now - 2 * DAY + 30 * 60 * 1000).toISOString(), janeId, acmeId],
    );
    await getAdminPool().query(
      `insert into crm.activities (workspace_id, type, title, occurred_at, contact_id, metadata)
       values ($1, 'meeting', 'Far away', $2, $3, '{"source":"granola"}'::jsonb)`,
      [owner.workspaceId, new Date(now + 2 * DAY - 3 * HOUR).toISOString(), janeId],
    );
    const forJane = await getMeetings(owner, { contactId: janeId }, now);
    assert.equal(forJane.scopeMissing, false);
    assert.deepEqual(forJane.upcoming, []);
    assert.equal(forJane.recent.length, 1);
    assert.equal(forJane.recent[0].subject, "Renewal kickoff (moved)");
    assert.equal(forJane.recent[0].granolaActivityId, granola.rows[0].id);
    assert.equal(forJane.recent[0].organizer?.email, "founder@orbit-calendar.test");
    assert.equal(forJane.recent[0].attendeeCount, 1);

    const forAcme = await getMeetings(owner, { companyId: acmeId }, now);
    assert.deepEqual(
      forAcme.upcoming.map((meeting) => [meeting.subject, meeting.granolaActivityId]),
      [["Renewal review", null]],
    );
    assert.equal(forAcme.upcoming[0].joinUrl, "https://teams.microsoft.com/l/meetup-join/next");
    assert.equal(forAcme.recent[0].granolaActivityId, granola.rows[0].id);
    assert.deepEqual(await getMeetings(owner, { contactId: "not-a-uuid" }, now), {
      scopeMissing: false,
      upcoming: [],
      recent: [],
    });
  });

  it("keeps events private to the owner, apart from CRM meetings", async () => {
    const teammate = await createUser("teammate@orbit-calendar.test", "Teammate");
    await getAdminPool().query(
      "insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [owner.workspaceId, teammate.userId],
    );
    const theirs = await queryAsUser<{ total: number; unlinked: number }>(
      teammate.userId,
      `select count(*)::int as total,
         count(*) filter (where cardinality(contact_ids) = 0 and cardinality(company_ids) = 0)::int as unlinked
       from crm.calendar_events`,
    );
    const shared = await getAdminPool().query<{ total: number }>(
      `select count(*)::int as total from crm.calendar_events e
       join crm.calendars c on c.id = e.calendar_id
       where e.workspace_id = $1 and c.use_for_crm and (cardinality(e.contact_ids) > 0 or cardinality(e.company_ids) > 0)`,
      [owner.workspaceId],
    );
    assert.equal(theirs[0].unlinked, 0);
    assert.equal(theirs[0].total, shared.rows[0].total);
    const mine = await queryAsUser<{ total: number }>(
      owner.userId,
      "select count(*)::int as total from crm.calendar_events",
    );
    assert.equal(mine[0].total, 3);
    const connection = await getAdminPool().query<{ id: string; calendar_id: string }>(
      `select m.id, c.id as calendar_id from crm.mailbox_connections m
       join crm.calendars c on c.connection_id = m.id
       where m.user_id = $1`,
      [owner.userId],
    );
    for (const userId of [teammate.userId, owner.userId]) {
      await assert.rejects(
        queryAsUser(
          teammate.userId,
          `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, starts_at, ends_at)
           values ($1, $2, $3, $4, 'sneaky', now(), now())`,
          [owner.workspaceId, connection.rows[0].calendar_id, connection.rows[0].id, userId],
        ),
        /row-level security/,
      );
    }
    const removed = await queryAsUser<{ id: string }>(
      teammate.userId,
      "delete from crm.calendar_events returning id",
    );
    assert.equal(removed.length, 0);
    const teammateState = await queryAsUser<{ total: number }>(
      teammate.userId,
      "select count(*)::int as total from crm.integration_state where source = 'calendar'",
    );
    assert.equal(teammateState[0].total, 0);
    await getAdminPool().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [
      owner.workspaceId,
      teammate.userId,
    ]);
  });

  it("lists people met who aren't contacts, hides people, and creates contacts from attendees", async () => {
    pages = [
      [
        graphEvent("p1", now - 5 * DAY, {
          subject: "Intro",
          people: [
            { name: "Isabelle Pitman", email: "isabelle@jumpstart-uk.com" },
            { name: "Jane Doe", email: "jane@acme.com" },
            { name: "Partner", email: "partner@ridgeon.me" },
            { name: "Teammate", email: "someone@orbit-calendar.test" },
          ],
        }),
        graphEvent("p2", now - 1 * DAY, {
          subject: "Follow-up",
          people: [
            { name: "isabelle@jumpstart-uk.com", email: "Isabelle@Jumpstart-UK.com" },
            { name: "Pat", email: "pat@gmail.com" },
          ],
        }),
        graphEvent("p3", now + 3 * DAY, {
          subject: "Workshop",
          people: [
            { name: "Isabelle Pitman", email: "isabelle@jumpstart-uk.com" },
            { name: "Future Only", email: "future@later.io" },
            { name: "Spam", email: "spam@noise.io" },
          ],
        }),
        graphEvent("p4", now + 5 * DAY, {
          subject: "Called off",
          isCancelled: true,
          people: [{ name: "Ghost", email: "ghost@cancelled.io" }],
        }),
      ],
    ];
    const synced = await syncCalendar(owner, { fetchImpl: graphStub(() => pages, []), now });
    assert.equal(synced.error, undefined);
    await hideAttendee(owner, "Spam@Noise.io");
    await hideAttendee(owner, "spam@noise.io");
    await assert.rejects(hideAttendee(owner, "nope"), /valid email/);

    const people = await listPeopleMet(owner, now);
    assert.deepEqual(
      people.map((person) => [person.email, person.name, person.meetings, person.lastMeeting?.subject ?? null, person.nextMeeting?.subject ?? null]),
      [
        ["isabelle@jumpstart-uk.com", "Isabelle Pitman", 3, "Follow-up", "Workshop"],
        ["pat@gmail.com", "Pat", 1, "Follow-up", null],
        ["future@later.io", "Future Only", 1, null, "Workshop"],
      ],
    );

    await assert.rejects(createContactFromMeeting(owner, "stranger@nowhere.io"), /isn't in your calendar/);
    await assert.rejects(createContactFromMeeting(owner, "partner@ridgeon.me"), /belongs to you/);
    const created = await createContactFromMeeting(owner, "ISABELLE@jumpstart-uk.com");
    assert.equal(created.created, true);
    assert.equal(created.contactName, "Isabelle Pitman");
    const company = await getAdminPool().query<{ id: string; name: string; source: string }>(
      "select id, name, source from crm.companies where workspace_id = $1 and domain = 'jumpstart-uk.com'",
      [owner.workspaceId],
    );
    assert.equal(company.rows[0].name, "Jumpstart UK");
    const rows = await eventRows(owner.userId);
    assert.deepEqual(rows.get("p1")!.contact_ids.sort(), [created.contactId, janeId].sort());
    assert.ok(rows.get("p3")!.company_ids.includes(company.rows[0].id));
    assert.deepEqual(
      (await listPeopleMet(owner, now)).map((person) => person.email),
      ["pat@gmail.com", "future@later.io"],
    );

    const freeMail = await createContactFromAttendee(owner, { name: "Pat", email: "pat@gmail.com" });
    assert.equal(freeMail.created, true);
    const pat = await getAdminPool().query<{ company_id: string | null; first_name: string }>(
      "select company_id, first_name from crm.contacts where id = $1",
      [freeMail.contactId],
    );
    assert.equal(pat.rows[0].company_id, null);
    assert.equal(pat.rows[0].first_name, "Pat");
    const repeat = await createContactFromAttendee(owner, { name: "Pat Again", email: "PAT@gmail.com" });
    assert.equal(repeat.created, false);
    assert.equal(repeat.contactId, freeMail.contactId);
  });

  it("asks to reconnect when the token lacks the calendar scope, without breaking mail", async () => {
    const legacy = await createUser("legacy@orbit-legacy.test", "Legacy");
    await connect(legacy, "legacy@orbit-legacy.test", new Date(Date.now() - 60_000).toISOString());
    const calls: Call[] = [];
    const refresh = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("login.microsoftonline.com")) {
        return json({
          access_token: "legacy-access",
          refresh_token: "legacy-refresh",
          expires_in: 3600,
          scope: "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read",
        });
      }
      if (url.includes("/messages")) return json({ value: [] });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const result = await syncCalendar(legacy, { fetchImpl: refresh });
    assert.equal(result.scopeMissing, true);
    assert.equal(result.error, undefined);
    assert.equal(calls.length, 1);
    const body = new URLSearchParams(String(calls[0].init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.has("scope"), false);
    assert.equal((await getCalendarStatus(legacy))?.scopeMissing, true);

    const mail = await syncMailbox(legacy, refresh);
    assert.equal(mail.error, undefined);

    const contact = (await createContact(legacy, { firstName: "Old", email: "old@legacy-client.io" })).body.contact.id;
    assert.deepEqual(await getMeetings(legacy, { contactId: contact }), {
      scopeMissing: true,
      upcoming: [],
      recent: [],
    });

    await resetCalendarSync(legacy);
    assert.equal((await getCalendarStatus(legacy))?.scopeMissing, false);

    const denied: Call[] = [];
    const forbidden = graphStub(() => [], denied, { status: 403, code: "ErrorAccessDenied" });
    const second = await syncCalendar(legacy, { fetchImpl: forbidden });
    assert.equal(second.scopeMissing, true);
    assert.equal(denied.length, 1);
    assert.equal((await getCalendarStatus(legacy))?.scopeMissing, true);

    await getAdminPool().query("update crm.integration_state set last_attempt_at = null where source = 'calendar'");
    const broken = await syncCalendar(legacy, {
      fetchImpl: graphStub(() => [], [], { status: 500, code: "ErrorInternalServerError" }),
    });
    assert.equal(broken.scopeMissing, false);
    assert.equal(broken.error, "Access is denied.");
    const status = await getCalendarStatus(legacy);
    assert.equal(status?.lastError, "Access is denied.");

    await getAdminPool().query("update crm.integration_state set last_attempt_at = null where source = 'calendar'");
    const fixed = await syncCalendar(legacy, { fetchImpl: graphStub(() => [[]], []) });
    assert.equal(fixed.error, undefined);
    const healthy = await getCalendarStatus(legacy);
    assert.equal(healthy?.scopeMissing, false);
    assert.equal(healthy?.lastError, null);
  });

  it("re-applies the migration and keeps transcript and calendar state side by side", async () => {
    const sql = readFileSync("supabase/migrations/20261020100000_calendar.sql", "utf8");
    const multi = readFileSync("supabase/migrations/20261022100000_multi_calendar.sql", "utf8");
    const before = await eventRows(owner.userId);
    await getAdminPool().query(sql);
    await getAdminPool().query(multi);
    await getAdminPool().query(multi);
    assert.deepEqual([...(await eventRows(owner.userId)).keys()], [...before.keys()]);
    const connection = await getAdminPool().query<{ id: string }>(
      "select id from crm.mailbox_connections where user_id = $1",
      [owner.userId],
    );
    await withActor(owner, async (db) => {
      await ensureIntegration(db, {
        workspaceId: owner.workspaceId,
        source: "teams_transcripts",
        connectionId: connection.rows[0].id,
        userId: owner.userId,
      });
    });
    const states = await getAdminPool().query<{ source: string }>(
      "select source from crm.integration_state where connection_id = $1 order by source",
      [connection.rows[0].id],
    );
    assert.deepEqual(
      states.rows.map((row) => row.source),
      ["calendar", "teams_transcripts"],
    );
    const step = DEFAULT_STEPS.find((item) => item.name === "calendar");
    assert.ok(step);
    assert.equal(step.applies({ actor: owner, mailbox: true, members: [owner], granola: null }), true);
    assert.equal(step.applies({ actor: owner, mailbox: false, members: [owner], granola: null }), false);
  });

  it("does not run without a connected mailbox", async () => {
    const nobody = await createUser("nobody@orbit-none.test", "Nobody");
    const result = await syncCalendar(nobody, { fetchImpl: graphStub(() => [], []) });
    assert.equal(result.ran, false);
    assert.match(result.error ?? "", /Connect Microsoft/);
    assert.equal(await getCalendarStatus(nobody), null);
    assert.deepEqual(await listPeopleMet(nobody), []);
  });
});

describe("clickup linking ignores your own addresses", () => {
  it("skips aliases mentioned in a task description", async () => {
    const owner = await createUser("lead@orbit-clickup-alias.test", "Lead");
    await saveOtherEmails(owner, ["lead@sideproject.io"]);
    await createContact(owner, { firstName: "Me", email: "lead@sideproject.io" });
    const client = (await createContact(owner, { firstName: "Client", email: "client@customer.io" })).body.contact.id;
    const task = {
      id: "abc123",
      name: "Follow up",
      description: "From lead@sideproject.io about client@customer.io",
      status: null,
      date_updated: null,
      due_date: null,
      url: "https://app.clickup.com/t/abc123",
      list: null,
    } satisfies ClickUpTask;
    const link = await withActor(owner, (db) => findClickUpLink(db, owner.workspaceId, task));
    assert.equal(link?.contactId, client);
  });
});
