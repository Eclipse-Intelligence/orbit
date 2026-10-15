import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { storeGrantedScopes, syncCalendar } from "@/lib/crm/calendar";
import { listCalendarItems } from "@/lib/crm/calendars";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import {
  cancelInvite,
  cleanGuests,
  cleanMeetingLink,
  createInvite,
  getInviteSetup,
  getMeetingLink,
  INVITE_NOT_CONNECTED,
  INVITE_RECONNECT,
  inviteWindow,
  saveMeetingLink,
} from "@/lib/crm/invites";
import { saveOtherEmails } from "@/lib/crm/profile";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { defaultInviteSlot, snapTime } from "@/lib/invite-rules";
import { graphDateTimes, inviteBodyHtml, type GraphEvent } from "@/lib/microsoft/calendar";
import { grantsCalendarWrite, MICROSOFT_SCOPES } from "@/lib/microsoft/oauth";
import { createUser, resetDatabase } from "./helpers";

const NOW = Date.UTC(2026, 9, 15, 9, 0);
const WRITE_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read offline_access";
const READ_SCOPES = "https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Mail.Read offline_access";
const TRANSACTION = "7e163156-7762-4beb-a1c6-729ea81755a7";
const MAILBOX = "founder@orbit-invites.test";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 202 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function utc(iso: string) {
  return { dateTime: iso.replace("Z", "").replace(/\.\d{3}$/, ".0000000"), timeZone: "UTC" };
}

function createdEvent(
  draft: { subject: string; attendees: { emailAddress: { address: string; name?: string } }[] },
  start: string,
  end: string,
  id = "evt-1",
): GraphEvent {
  return {
    id,
    iCalUId: `ical-${id}`,
    subject: draft.subject,
    start: utc(start),
    end: utc(end),
    isAllDay: false,
    isCancelled: false,
    location: { displayName: "https://whereby.com/eclipse" },
    webLink: `https://outlook.office365.com/owa/?itemid=${id}`,
    organizer: { emailAddress: { name: "Founder", address: MAILBOX } },
    attendees: draft.attendees.map((attendee) => ({
      type: "required",
      status: { response: "none" },
      emailAddress: attendee.emailAddress,
    })),
    showAs: "busy",
  };
}

function graph(
  calls: Call[],
  options: {
    create?: (draft: Record<string, unknown>, attempt: number) => Response;
    cancel?: () => Response;
    token?: () => Response;
    events?: () => GraphEvent[];
  } = {},
) {
  let creates = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    } else if (body instanceof URLSearchParams) body = Object.fromEntries(body.entries());
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const parsed = new URL(url);
    if (parsed.hostname === "login.microsoftonline.com") {
      return options.token?.() ?? json({ access_token: "fresh-token", expires_in: 3600, scope: WRITE_SCOPES });
    }
    if (parsed.pathname.endsWith("/cancel")) return options.cancel?.() ?? json(null, 202);
    if (init?.method === "POST" && parsed.pathname.endsWith("/events")) {
      creates += 1;
      const draft = body as Record<string, unknown>;
      if (options.create) return options.create(draft, creates);
      return json(
        createdEvent(draft as never, "2026-10-20T13:00:00.000Z", "2026-10-20T13:30:00.000Z"),
        201,
      );
    }
    if (parsed.pathname.endsWith("/me/calendars")) {
      return json({ value: [{ id: "cal-main", name: "Calendar", isDefaultCalendar: true, canEdit: true }] });
    }
    if (parsed.pathname.includes("/calendarView")) return json({ value: options.events?.() ?? [] });
    return json({ error: { code: "NotFound", message: "Unexpected call" } }, 404);
  }) as typeof fetch;
}

function posts(calls: Call[]) {
  return calls.filter((call) => call.method === "POST" && new URL(call.url).hostname === "graph.microsoft.com");
}

async function connect(actor: UserActor, scopes: string | null = WRITE_SCOPES) {
  await saveMailbox(actor, {
    email: MAILBOX,
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const connection = await getAdminPool().query<{ id: string }>(
    "select id from crm.mailbox_connections where user_id = $1",
    [actor.userId],
  );
  const id = connection.rows[0].id;
  if (scopes) await withActor(actor, (db) => storeGrantedScopes(db, actor, id, scopes));
  return id;
}

async function addMainCalendar(actor: UserActor, connectionId: string) {
  const row = await getAdminPool().query<{ id: string }>(
    `insert into crm.calendars (
       workspace_id, user_id, connection_id, provider_calendar_id, name, color,
       is_default, is_visible, use_for_crm, can_edit
     ) values ($1, $2, $3, 'cal-main', 'Calendar', '#4f9be8', true, true, true, true)
     returning id`,
    [actor.workspaceId, actor.userId, connectionId],
  );
  return row.rows[0].id;
}

async function rejects(run: () => Promise<unknown>, check: { code?: string; message?: string | RegExp; field?: string }) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof CrmError, `expected CrmError, got ${String(error)}`);
    if (check.code) assert.equal(error.code, check.code);
    if (typeof check.message === "string") assert.equal(error.message, check.message);
    if (check.message instanceof RegExp) assert.match(error.message, check.message);
    if (check.field) assert.equal(error.details?.field, check.field);
    return true;
  });
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Eclipse × Jane Doe",
    startLocal: "2026-10-20T14:00",
    durationMinutes: 30,
    attendees: [{ email: "jane@acme-invites.test", name: "Jane Doe" }],
    notes: "",
    transactionId: TRANSACTION,
    ...overrides,
  };
}

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
});

after(async () => {
  await getPool().end();
});

describe("invite rules", () => {
  it("asks for Calendars.ReadWrite and reads write grants from the token scope", () => {
    assert.match(MICROSOFT_SCOPES, /\bCalendars\.ReadWrite\b/);
    assert.doesNotMatch(MICROSOFT_SCOPES, /Calendars\.Read(\s|$)/);
    assert.equal(grantsCalendarWrite(WRITE_SCOPES), true);
    assert.equal(grantsCalendarWrite("https%3A%2F%2Fgraph.microsoft.com%2Fcalendars.readwrite"), true);
    assert.equal(grantsCalendarWrite(READ_SCOPES), false);
    assert.equal(grantsCalendarWrite(null), null);
    assert.equal(grantsCalendarWrite(""), null);
  });

  it("converts London wall time to Graph times across daylight saving", () => {
    const summer = inviteWindow("2026-10-20T14:00", 30, { now: NOW, timeZone: "Europe/London" });
    assert.equal(summer.start.toISOString(), "2026-10-20T13:00:00.000Z");
    assert.equal(summer.end.toISOString(), "2026-10-20T13:30:00.000Z");
    assert.deepEqual(graphDateTimes(summer.start, summer.end, "Europe/London"), {
      start: { dateTime: "2026-10-20T14:00:00", timeZone: "GMT Standard Time" },
      end: { dateTime: "2026-10-20T14:30:00", timeZone: "GMT Standard Time" },
    });

    const winter = inviteWindow("2026-11-03T14:00", 45, { now: NOW, timeZone: "Europe/London" });
    assert.equal(winter.start.toISOString(), "2026-11-03T14:00:00.000Z");
    assert.deepEqual(graphDateTimes(winter.start, winter.end, "Europe/London").end, {
      dateTime: "2026-11-03T14:45:00",
      timeZone: "GMT Standard Time",
    });

    const spring = inviteWindow("2027-03-28T00:30", 90, { now: NOW, timeZone: "Europe/London" });
    assert.equal(spring.start.toISOString(), "2027-03-28T00:30:00.000Z");
    assert.equal(spring.end.toISOString(), "2027-03-28T02:00:00.000Z");
    assert.deepEqual(graphDateTimes(spring.start, spring.end, "Europe/London"), {
      start: { dateTime: "2027-03-28T00:30:00", timeZone: "GMT Standard Time" },
      end: { dateTime: "2027-03-28T03:00:00", timeZone: "GMT Standard Time" },
    });

    const autumn = inviteWindow("2026-10-25T00:30", 120, { now: NOW, timeZone: "Europe/London" });
    assert.equal(autumn.start.toISOString(), "2026-10-24T23:30:00.000Z");
    assert.equal(autumn.end.toISOString(), "2026-10-25T01:30:00.000Z");
    assert.deepEqual(graphDateTimes(autumn.start, autumn.end, "Europe/London"), {
      start: { dateTime: "2026-10-24T23:30:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-25T01:30:00", timeZone: "UTC" },
    });

    assert.deepEqual(graphDateTimes(summer.start, summer.end, "Asia/Tokyo").start, {
      dateTime: "2026-10-20T13:00:00",
      timeZone: "UTC",
    });
  });

  it("rejects missing, past, impossible and badly sized times", () => {
    assert.throws(() => inviteWindow("2027-03-28T01:30", 30, { now: NOW, timeZone: "Europe/London" }), /clocks go forward/);
    assert.throws(() => inviteWindow("2026-10-15T09:00", 30, { now: NOW, timeZone: "Europe/London" }), /in the future/);
    assert.throws(() => inviteWindow("2026-10-20", 30, { now: NOW }), /date and start time/);
    assert.throws(() => inviteWindow("2026-02-30T10:00", 30, { now: NOW }), /date and start time/);
    assert.throws(() => inviteWindow("2026-10-20T14:00", 0, { now: NOW }), /duration/);
    assert.throws(() => inviteWindow("2026-10-20T14:00", 12.5, { now: NOW }), /duration/);
    assert.throws(() => inviteWindow("2029-10-20T14:00", 30, { now: NOW }), /two years/);
  });

  it("escapes notes, keeps line breaks and adds the join link", () => {
    assert.equal(
      inviteBodyHtml('Agenda <script>alert("x")</script>\nItem & more\r\nLast', "https://whereby.com/a?b=1&c='2'"),
      '<div><p>Agenda &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>Item &amp; more<br>Last</p>' +
        '<p>Join: <a href="https://whereby.com/a?b=1&amp;c=&#39;2&#39;">https://whereby.com/a?b=1&amp;c=&#39;2&#39;</a></p></div>',
    );
    assert.equal(inviteBodyHtml(null, null), null);
  });

  it("validates guests, drops the user's own addresses and dedupes", () => {
    const own = new Set(["founder@orbit-invites.test", "me@alias.test"]);
    assert.deepEqual(
      cleanGuests(
        [
          { email: " Jane@Acme.test ", name: "Jane Doe" },
          { email: "jane@acme.test", name: "Duplicate" },
          { email: "ME@alias.test" },
          "bob@acme.test",
          { email: "carol@acme.test", name: "carol@acme.test" },
        ],
        own,
      ),
      [
        { email: "jane@acme.test", name: "Jane Doe" },
        { email: "bob@acme.test", name: null },
        { email: "carol@acme.test", name: null },
      ],
    );
    assert.throws(() => cleanGuests([{ email: "Founder@orbit-invites.test" }], own), /someone other than yourself/);
    assert.throws(() => cleanGuests([], own), /at least one guest/);
    assert.throws(() => cleanGuests([{ email: "not-an-email" }], own), /“not-an-email” isn't a valid email/);
    const many = Array.from({ length: 51 }, (_, index) => ({ email: `guest${index}@acme.test` }));
    assert.throws(() => cleanGuests(many, own), /up to 50 guests/);
    assert.equal(cleanGuests(many.slice(0, 50), own).length, 50);
  });

  it("only accepts https meeting links up to 500 characters", () => {
    assert.equal(cleanMeetingLink(" https://whereby.com/eclipse "), "https://whereby.com/eclipse");
    assert.equal(cleanMeetingLink(""), null);
    assert.equal(cleanMeetingLink(null), null);
    assert.throws(() => cleanMeetingLink("http://whereby.com/eclipse"), /https/);
    assert.throws(() => cleanMeetingLink("javascript:alert(1)"), /https/);
    assert.throws(() => cleanMeetingLink("whereby.com/eclipse"), /https/);
    assert.throws(() => cleanMeetingLink("https://user:pass@whereby.com/x"), /sign-in details/);
    assert.throws(() => cleanMeetingLink(`https://whereby.com/${"a".repeat(490)}`), /500 characters/);
    assert.throws(() => cleanMeetingLink(42), /https/);
  });

  it("suggests the next working half hour and snaps grid clicks to 15 minutes", () => {
    assert.deepEqual(defaultInviteSlot(Date.UTC(2026, 9, 15, 9, 10), "Europe/London"), { date: "2026-10-15", time: "10:30" });
    assert.deepEqual(defaultInviteSlot(Date.UTC(2026, 9, 15, 5, 0), "Europe/London"), { date: "2026-10-15", time: "09:00" });
    assert.deepEqual(defaultInviteSlot(Date.UTC(2026, 9, 15, 17, 0), "Europe/London"), { date: "2026-10-16", time: "09:00" });
    assert.deepEqual(defaultInviteSlot(Date.UTC(2026, 9, 16, 17, 0), "Europe/London"), { date: "2026-10-19", time: "09:00" });
    assert.deepEqual(defaultInviteSlot(Date.UTC(2026, 9, 17, 11, 0), "Europe/London"), { date: "2026-10-19", time: "09:00" });
    assert.equal(snapTime(14 * 60 + 7), "14:00");
    assert.equal(snapTime(14 * 60 + 52.9), "14:45");
    assert.equal(snapTime(-5), "00:00");
    assert.equal(snapTime(24 * 60 + 10), "23:45");
  });
});

describe("sending invites", () => {
  let owner: UserActor;
  let connectionId: string;
  let calendarRow: string;
  let jane: string;
  let bob: string;
  let acme: string;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser("founder@example.com", "Founder");
    await saveOtherEmails(owner, ["me@alias.test"]);
    acme = (await createCompany(owner, { name: "Acme", domain: "acme-invites.test" })).body.company.id;
    jane = (
      await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme-invites.test", companyId: acme })
    ).body.contact.id;
    bob = (await createContact(owner, { firstName: "Bob", lastName: "Stone", email: "bob@elsewhere-invites.test" })).body
      .contact.id;
    connectionId = await connect(owner);
    calendarRow = await addMainCalendar(owner, connectionId);
    await saveMeetingLink(owner, "https://whereby.com/eclipse");
  });

  it("posts the documented event body to the default calendar", async () => {
    const calls: Call[] = [];
    const result = await createInvite(
      owner,
      baseInput({
        attendees: [
          { email: "jane@acme-invites.test", name: "Jane Doe" },
          { email: "BOB@elsewhere-invites.test", name: "Bob Stone" },
          { email: "me@alias.test" },
          { email: MAILBOX },
          { email: "jane@acme-invites.test" },
        ],
        notes: "Agenda:\n<b>pricing</b> & terms",
      }),
      { fetchImpl: graph(calls), now: NOW },
    );
    const [post] = posts(calls);
    assert.equal(posts(calls).length, 1);
    assert.equal(post.url, "https://graph.microsoft.com/v1.0/me/calendars/cal-main/events");
    assert.equal(post.headers.authorization, "Bearer access-token");
    assert.equal(post.headers.prefer, 'outlook.timezone="UTC"');
    assert.deepEqual(post.body, {
      subject: "Eclipse × Jane Doe",
      body: {
        contentType: "HTML",
        content:
          '<div><p>Agenda:<br>&lt;b&gt;pricing&lt;/b&gt; &amp; terms</p>' +
          '<p>Join: <a href="https://whereby.com/eclipse">https://whereby.com/eclipse</a></p></div>',
      },
      start: { dateTime: "2026-10-20T14:00:00", timeZone: "GMT Standard Time" },
      end: { dateTime: "2026-10-20T14:30:00", timeZone: "GMT Standard Time" },
      location: { displayName: "https://whereby.com/eclipse" },
      attendees: [
        { emailAddress: { address: "jane@acme-invites.test", name: "Jane Doe" }, type: "required" },
        { emailAddress: { address: "bob@elsewhere-invites.test", name: "Bob Stone" }, type: "required" },
      ],
      isOnlineMeeting: false,
      responseRequested: true,
      allowNewTimeProposals: true,
      transactionId: TRANSACTION,
    });
    assert.equal(result.warning, null);
    assert.equal(result.loggedOn, 2);
    assert.deepEqual(
      result.guests.map((guest) => guest.email),
      ["jane@acme-invites.test", "bob@elsewhere-invites.test"],
    );
  });

  it("leaves the link out when asked, and needs a saved link to add it", async () => {
    const calls: Call[] = [];
    await createInvite(owner, baseInput({ includeMeetingLink: false }), { fetchImpl: graph(calls), now: NOW });
    const body = posts(calls)[0].body as Record<string, unknown>;
    assert.equal(body.location, undefined);
    assert.equal(body.body, undefined);

    await saveMeetingLink(owner, "");
    assert.equal(await getMeetingLink(owner), null);
    await rejects(() => createInvite(owner, baseInput({ includeMeetingLink: true }), { fetchImpl: graph([]), now: NOW }), {
      field: "includeMeetingLink",
      message: /Settings/,
    });
    const quiet: Call[] = [];
    await createInvite(owner, baseInput({ notes: "Hi" }), { fetchImpl: graph(quiet), now: NOW });
    const plain = posts(quiet)[0].body as Record<string, unknown>;
    assert.equal(plain.location, undefined);
    assert.deepEqual(plain.body, { contentType: "HTML", content: "<div><p>Hi</p></div>" });
  });

  it("generates a transaction id when none is given and reuses it on a retry", async () => {
    const calls: Call[] = [];
    const flaky = graph(calls, {
      create: (draft, attempt) =>
        attempt === 1
          ? json({ error: { code: "ServiceUnavailable", message: "busy" } }, 503)
          : json(createdEvent(draft as never, "2026-10-20T13:00:00.000Z", "2026-10-20T13:30:00.000Z"), 201),
    });
    await createInvite(owner, baseInput({ transactionId: "not-a-uuid" }), { fetchImpl: flaky, now: NOW });
    const sent = posts(calls).map((call) => (call.body as { transactionId: string }).transactionId);
    assert.equal(sent.length, 2);
    assert.match(sent[0], /^[0-9a-f-]{36}$/);
    assert.notEqual(sent[0], "not-a-uuid");
    assert.equal(sent[0], sent[1]);
  });

  it("saves the event straight away, links it and logs a meeting on each guest contact", async () => {
    const calls: Call[] = [];
    const result = await createInvite(
      owner,
      baseInput({
        attendees: [
          { email: "jane@acme-invites.test", name: "Jane Doe" },
          { email: "bob@elsewhere-invites.test" },
          { email: "stranger@nowhere-invites.test" },
        ],
        notes: "Bring numbers",
        contactIds: [jane],
      }),
      { fetchImpl: graph(calls), now: NOW },
    );
    assert.ok(result.eventId);
    const events = await getAdminPool().query<{
      id: string;
      calendar_id: string;
      connection_id: string;
      provider_event_id: string;
      created_by_orbit: boolean;
      contact_ids: string[];
      company_ids: string[];
      starts_at: Date;
      location: string;
    }>("select * from crm.calendar_events where user_id = $1", [owner.userId]);
    assert.equal(events.rows.length, 1);
    const row = events.rows[0];
    assert.equal(row.id, result.eventId);
    assert.equal(row.calendar_id, calendarRow);
    assert.equal(row.connection_id, connectionId);
    assert.equal(row.provider_event_id, "evt-1");
    assert.equal(row.created_by_orbit, true);
    assert.deepEqual([...row.contact_ids].sort(), [jane, bob].sort());
    assert.deepEqual(row.company_ids, [acme]);
    assert.equal(row.starts_at.toISOString(), "2026-10-20T13:00:00.000Z");

    const activities = await getAdminPool().query<{
      contact_id: string;
      company_id: string | null;
      type: string;
      title: string;
      body: string;
      occurred_at: Date;
      metadata: Record<string, unknown>;
    }>("select * from crm.activities where workspace_id = $1 order by title", [owner.workspaceId]);
    assert.equal(activities.rows.length, 2);
    const [toBob, toJane] = activities.rows;
    assert.equal(toJane.type, "meeting");
    assert.equal(toJane.contact_id, jane);
    assert.equal(toJane.company_id, acme);
    assert.equal(toJane.title, "Invited Jane Doe to Eclipse × Jane Doe");
    assert.equal(
      toJane.body,
      "Tue, 20 Oct 2026, 14:00–14:30 London time\nJoin: https://whereby.com/eclipse\n\nBring numbers",
    );
    assert.equal(toJane.metadata.eventId, result.eventId);
    assert.equal(toJane.metadata.startsAt, "2026-10-20T13:00:00.000Z");
    assert.ok(Math.abs(toJane.occurred_at.getTime() - Date.now()) < 60_000);
    assert.equal(toBob.title, "Invited Bob Stone to Eclipse × Jane Doe");
    assert.equal(toBob.contact_id, bob);

    const items = await listCalendarItems(
      owner,
      { start: new Date("2026-10-19T00:00:00Z"), end: new Date("2026-10-22T00:00:00Z") },
      NOW,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].createdByOrbit, true);
    assert.equal(items[0].canCancel, true);

    const created = createdEvent(
      { subject: "Eclipse × Jane Doe", attendees: [{ emailAddress: { address: "jane@acme-invites.test" } }] },
      "2026-10-20T13:00:00.000Z",
      "2026-10-20T13:30:00.000Z",
    );
    const sync = await syncCalendar(owner, { fetchImpl: graph([], { events: () => [created] }), force: true });
    assert.equal(sync.error, undefined);
    const after = await getAdminPool().query<{ id: string; created_by_orbit: boolean }>(
      "select id, created_by_orbit from crm.calendar_events where user_id = $1",
      [owner.userId],
    );
    assert.deepEqual(after.rows, [{ id: result.eventId, created_by_orbit: true }]);
  });

  it("keeps a far-future Orbit invite through a sync that can't see it yet", async () => {
    const result = await createInvite(owner, baseInput({ startLocal: "2027-02-10T10:00" }), {
      fetchImpl: graph([], {
        create: (draft) =>
          json(createdEvent(draft as never, "2027-02-10T10:00:00.000Z", "2027-02-10T10:30:00.000Z", "evt-far"), 201),
      }),
      now: NOW,
    });
    await syncCalendar(owner, { fetchImpl: graph([], { events: () => [] }), force: true });
    const rows = await getAdminPool().query("select id from crm.calendar_events where id = $1", [result.eventId]);
    assert.equal(rows.rows.length, 1);
  });

  it("creates in the default calendar and keeps the row when the calendar list hasn't synced", async () => {
    await getAdminPool().query("delete from crm.calendars where id = $1", [calendarRow]);
    const calls: Call[] = [];
    const result = await createInvite(owner, baseInput(), { fetchImpl: graph(calls), now: NOW });
    assert.equal(posts(calls)[0].url, "https://graph.microsoft.com/v1.0/me/events");
    const calendar = await getAdminPool().query<{ provider_calendar_id: string; is_default: boolean }>(
      `select c.provider_calendar_id, c.is_default from crm.calendar_events e
       join crm.calendars c on c.id = e.calendar_id where e.id = $1`,
      [result.eventId],
    );
    assert.deepEqual(calendar.rows, [{ provider_calendar_id: "__default__", is_default: true }]);
  });

  it("asks to reconnect when the connection only granted Calendars.Read", async () => {
    await withActor(owner, (db) => storeGrantedScopes(db, owner, connectionId, READ_SCOPES));
    const setup = await getInviteSetup(owner);
    assert.equal(setup.connected, true);
    assert.equal(setup.canWriteCalendar, false);
    assert.equal(setup.meetingLink, "https://whereby.com/eclipse");
    assert.ok(setup.ownEmails.includes("me@alias.test"));
    assert.ok(setup.ownEmails.includes(MAILBOX));
    const calls: Call[] = [];
    await rejects(() => createInvite(owner, baseInput(), { fetchImpl: graph(calls), now: NOW }), {
      code: "scope_missing",
      message: INVITE_RECONNECT,
    });
    assert.equal(calls.length, 0);
  });

  it("learns the granted scopes from a refresh when it doesn't know them", async () => {
    await getAdminPool().query("update crm.integration_state set granted_scopes = null where connection_id = $1", [
      connectionId,
    ]);
    assert.equal((await getInviteSetup(owner)).canWriteCalendar, true);
    const calls: Call[] = [];
    await rejects(
      () =>
        createInvite(owner, baseInput(), {
          fetchImpl: graph(calls, { token: () => json({ access_token: "fresh", expires_in: 3600, scope: READ_SCOPES }) }),
          now: NOW,
        }),
      { code: "scope_missing", message: "Reconnect Microsoft to send invites." },
    );
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).hostname, "login.microsoftonline.com");
    assert.equal((calls[0].body as Record<string, string>).scope, undefined);
    assert.equal((await getInviteSetup(owner)).canWriteCalendar, false);
  });

  it("explains access denied and throttling from Graph", async () => {
    await rejects(
      () =>
        createInvite(owner, baseInput(), {
          fetchImpl: graph([], {
            create: () => json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403),
          }),
          now: NOW,
        }),
      { code: "scope_missing", message: INVITE_RECONNECT },
    );
    await rejects(
      () =>
        createInvite(owner, baseInput(), {
          fetchImpl: graph([], {
            create: () =>
              json({ error: { code: "TooManyRequests", message: "Please retry again later." } }, 429, {
                "retry-after": "30",
              }),
          }),
          now: NOW,
        }),
      { code: "rate_limited", message: "Microsoft is limiting requests right now. Try again in 30 seconds." },
    );
    const rows = await getAdminPool().query("select 1 from crm.calendar_events where user_id = $1", [owner.userId]);
    assert.equal(rows.rows.length, 0);
  });

  it("refuses without a connected mailbox", async () => {
    await getAdminPool().query("delete from crm.mailbox_connections where user_id = $1", [owner.userId]);
    const setup = await getInviteSetup(owner);
    assert.deepEqual([setup.connected, setup.canWriteCalendar], [false, false]);
    await rejects(() => createInvite(owner, baseInput(), { fetchImpl: graph([]), now: NOW }), {
      code: "not_connected",
      message: INVITE_NOT_CONNECTED,
    });
  });

  it("stores only https links in the profile", async () => {
    assert.equal(await getMeetingLink(owner), "https://whereby.com/eclipse");
    await rejects(() => saveMeetingLink(owner, "http://whereby.com/eclipse"), { field: "meetingLink" });
    await assert.rejects(() =>
      getAdminPool().query("update crm.profiles set meeting_link = 'http://whereby.com/x' where id = $1", [owner.userId]),
    );
    await assert.rejects(() =>
      getAdminPool().query("update crm.profiles set meeting_link = $2 where id = $1", [
        owner.userId,
        `https://whereby.com/${"a".repeat(500)}`,
      ]),
    );
  });
});

describe("cancelling invites", () => {
  let owner: UserActor;
  let connectionId: string;
  let jane: string;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser("founder@example.com", "Founder");
    const acme = (await createCompany(owner, { name: "Acme", domain: "acme-invites.test" })).body.company.id;
    jane = (
      await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme-invites.test", companyId: acme })
    ).body.contact.id;
    connectionId = await connect(owner);
    await addMainCalendar(owner, connectionId);
  });

  async function invite() {
    const result = await createInvite(owner, baseInput(), { fetchImpl: graph([]), now: NOW });
    return result.eventId!;
  }

  it("posts the cancellation with the message, marks it cancelled and logs it", async () => {
    const eventId = await invite();
    const calls: Call[] = [];
    const result = await cancelInvite(owner, eventId, "  Something came up.  ", { fetchImpl: graph(calls), now: NOW });
    assert.equal(result.warning, null);
    assert.equal(result.loggedOn, 1);
    const [post] = posts(calls);
    assert.equal(post.url, "https://graph.microsoft.com/v1.0/me/events/evt-1/cancel");
    assert.deepEqual(post.body, { comment: "Something came up." });
    const row = await getAdminPool().query<{ is_cancelled: boolean }>(
      "select is_cancelled from crm.calendar_events where id = $1",
      [eventId],
    );
    assert.equal(row.rows[0].is_cancelled, true);
    const logged = await getAdminPool().query<{ title: string; body: string; contact_id: string }>(
      "select title, body, contact_id from crm.activities where title like 'Cancelled%'",
    );
    assert.deepEqual(logged.rows, [
      {
        title: "Cancelled Eclipse × Jane Doe",
        body: "Tue, 20 Oct 2026, 14:00–14:30 London time\n\nMessage to guests: Something came up.",
        contact_id: jane,
      },
    ]);
    const items = await listCalendarItems(
      owner,
      { start: new Date("2026-10-19T00:00:00Z"), end: new Date("2026-10-22T00:00:00Z") },
      NOW,
    );
    assert.equal(items.length, 0);
    await rejects(() => cancelInvite(owner, eventId, "", { fetchImpl: graph([]), now: NOW }), { code: "conflict" });
  });

  it("sends an empty body without a message", async () => {
    const eventId = await invite();
    const calls: Call[] = [];
    await cancelInvite(owner, eventId, "", { fetchImpl: graph(calls), now: NOW });
    assert.deepEqual(posts(calls)[0].body, {});
  });

  it("only lets the organiser cancel, and only before it starts", async () => {
    const eventId = await invite();
    await rejects(
      () => cancelInvite(owner, eventId, "", { fetchImpl: graph([]), now: Date.UTC(2026, 9, 20, 13, 5) }),
      { message: /already started/ },
    );
    await getAdminPool().query(
      `update crm.calendar_events
       set created_by_orbit = false, organizer = '{"name":"Jane Doe","email":"jane@acme-invites.test"}'::jsonb
       where id = $1`,
      [eventId],
    );
    const items = await listCalendarItems(
      owner,
      { start: new Date("2026-10-19T00:00:00Z"), end: new Date("2026-10-22T00:00:00Z") },
      NOW,
    );
    assert.equal(items[0].canCancel, false);
    const calls: Call[] = [];
    await rejects(() => cancelInvite(owner, eventId, "", { fetchImpl: graph(calls), now: NOW }), {
      code: "forbidden",
      message: /Only the organiser/,
    });
    assert.equal(calls.length, 0);

    await getAdminPool().query(
      `update crm.calendar_events set organizer = '{"name":"Founder","email":"founder@orbit-invites.test"}'::jsonb where id = $1`,
      [eventId],
    );
    const own = await listCalendarItems(
      owner,
      { start: new Date("2026-10-19T00:00:00Z"), end: new Date("2026-10-22T00:00:00Z") },
      NOW,
    );
    assert.equal(own[0].canCancel, true);
    await rejects(
      () =>
        cancelInvite(owner, eventId, "", {
          fetchImpl: graph([], {
            cancel: () =>
              json(
                {
                  error: {
                    code: "ErrorInvalidRequest",
                    message: "Your request can't be completed. You need to be an organizer to cancel a meeting.",
                  },
                },
                400,
              ),
          }),
          now: NOW,
        }),
      { message: "Only the organiser can cancel this meeting. Decline it in Outlook instead." },
    );
    await rejects(() => cancelInvite(owner, "not-a-uuid", "", { fetchImpl: graph([]), now: NOW }), { code: "not_found" });
  });

  it("marks it cancelled when Outlook no longer has it", async () => {
    const eventId = await invite();
    const result = await cancelInvite(owner, eventId, "", {
      fetchImpl: graph([], {
        cancel: () => json({ error: { code: "ErrorItemNotFound", message: "The specified object was not found." } }, 404),
      }),
      now: NOW,
    });
    assert.match(result.warning ?? "", /already removed/);
    const row = await getAdminPool().query<{ is_cancelled: boolean }>(
      "select is_cancelled from crm.calendar_events where id = $1",
      [eventId],
    );
    assert.equal(row.rows[0].is_cancelled, true);
  });

  it("asks to reconnect before cancelling without write access", async () => {
    const eventId = await invite();
    await withActor(owner, (db) => storeGrantedScopes(db, owner, connectionId, READ_SCOPES));
    const calls: Call[] = [];
    await rejects(() => cancelInvite(owner, eventId, "", { fetchImpl: graph(calls), now: NOW }), {
      code: "scope_missing",
    });
    assert.equal(calls.length, 0);
  });
});

describe("Graph time zones in responses", () => {
  it("reads Windows zone names such as GMT Standard Time as London time", async () => {
    const { graphInstant } = await import("@/lib/microsoft/calendar");
    assert.equal(
      graphInstant({ dateTime: "2026-10-16T13:15:00.0000000", timeZone: "GMT Standard Time" }),
      "2026-10-16T12:15:00.000Z",
    );
    assert.equal(
      graphInstant({ dateTime: "2026-12-16T13:15:00.0000000", timeZone: "GMT Standard Time" }),
      "2026-12-16T13:15:00.000Z",
    );
    assert.equal(graphInstant({ dateTime: "2026-10-16T13:15:00.0000000", timeZone: "UTC" }), "2026-10-16T13:15:00.000Z");
  });
});
