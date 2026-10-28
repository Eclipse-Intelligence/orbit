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
  MEETING_GONE,
  rescheduleInvite,
  RESPOND_NOT_CONNECTED,
  respondToInvite,
  saveMeetingLink,
} from "@/lib/crm/invites";
import { describeAction, recordNames } from "@/lib/assistant/tools";
import { saveOtherEmails } from "@/lib/crm/profile";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { defaultInviteSlot, snapTime } from "@/lib/invite-rules";
import { graphDateTimes, inviteBodyHtml, RESPOND_ORGANISER, type GraphEvent } from "@/lib/microsoft/calendar";
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
    move?: (patch: Record<string, unknown>) => Response;
    read?: () => Response;
    respond?: (action: string, body: Record<string, unknown>) => Response;
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
    const answer = /\/me\/events\/[^/]+\/(accept|tentativelyAccept|decline)$/.exec(parsed.pathname);
    if (answer && init?.method === "POST") {
      return options.respond?.(answer[1], body as Record<string, unknown>) ?? json(null, 202);
    }
    if (init?.method === "POST" && parsed.pathname.endsWith("/events")) {
      creates += 1;
      const draft = body as Record<string, unknown>;
      if (options.create) return options.create(draft, creates);
      return json(
        createdEvent(draft as never, "2026-10-20T13:00:00.000Z", "2026-10-20T13:30:00.000Z"),
        201,
      );
    }
    if (/\/me\/events\/[^/]+$/.test(parsed.pathname) && init?.method === "PATCH") {
      const patch = body as Record<string, unknown>;
      if (options.move) return options.move(patch);
      return json({
        ...createdEvent(
          { subject: "Eclipse × Jane Doe", attendees: [{ emailAddress: { address: "jane@acme-invites.test", name: "Jane Doe" } }] },
          "2026-10-20T13:00:00.000Z",
          "2026-10-20T13:30:00.000Z",
        ),
        start: patch.start,
        end: patch.end,
      });
    }
    if (/\/me\/events\/[^/]+$/.test(parsed.pathname) && (init?.method ?? "GET") === "GET") {
      return options.read?.() ?? json({ body: { contentType: "html", content: "" } });
    }
    if (parsed.pathname.endsWith("/me/calendars")) {
      return json({ value: [{ id: "cal-main", name: "Calendar", isDefaultCalendar: true, canEdit: true }] });
    }
    if (parsed.pathname.includes("/calendarView")) return json({ value: options.events?.() ?? [] });
    return json({ error: { code: "NotFound", message: "Unexpected call" } }, 404);
  }) as typeof fetch;
}

function patches(calls: Call[]) {
  return calls.filter((call) => call.method === "PATCH" && new URL(call.url).hostname === "graph.microsoft.com");
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
      "Tue, 20 Oct 2026, 14:00 to 14:30 London time\nJoin: https://whereby.com/eclipse\n\nBring numbers",
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
        body: "Tue, 20 Oct 2026, 14:00 to 14:30 London time\n\nMessage to guests: Something came up.",
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

describe("moving invites", () => {
  let owner: UserActor;
  let connectionId: string;
  let jane: string;
  const days = { start: new Date("2026-10-19T00:00:00Z"), end: new Date("2026-10-24T00:00:00Z") };

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

  it("patches the existing event's times, keeps the link, updates the calendar and logs it", async () => {
    const eventId = await invite();
    const calls: Call[] = [];
    const result = await rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00" }, { fetchImpl: graph(calls), now: NOW });
    assert.equal(posts(calls).length, 0);
    const [patch] = patches(calls);
    assert.equal(patches(calls).length, 1);
    assert.equal(patch.url, "https://graph.microsoft.com/v1.0/me/events/evt-1");
    assert.equal(patch.headers.authorization, "Bearer access-token");
    assert.deepEqual(patch.body, {
      start: { dateTime: "2026-10-22T10:00:00", timeZone: "GMT Standard Time" },
      end: { dateTime: "2026-10-22T10:30:00", timeZone: "GMT Standard Time" },
    });
    assert.deepEqual(result, {
      eventId,
      subject: "Eclipse × Jane Doe",
      startsAt: "2026-10-22T09:00:00.000Z",
      endsAt: "2026-10-22T09:30:00.000Z",
      previousStartsAt: "2026-10-20T13:00:00.000Z",
      previousEndsAt: "2026-10-20T13:30:00.000Z",
      guests: ["jane@acme-invites.test"],
      loggedOn: 1,
      warning: null,
    });
    const row = await getAdminPool().query<{ starts_at: Date; ends_at: Date; location: string; is_cancelled: boolean }>(
      "select starts_at, ends_at, location, is_cancelled from crm.calendar_events where id = $1",
      [eventId],
    );
    assert.equal(row.rows[0].starts_at.toISOString(), "2026-10-22T09:00:00.000Z");
    assert.equal(row.rows[0].ends_at.toISOString(), "2026-10-22T09:30:00.000Z");
    assert.equal(row.rows[0].location, "https://whereby.com/eclipse");
    assert.equal(row.rows[0].is_cancelled, false);
    const items = await listCalendarItems(owner, days, NOW);
    assert.deepEqual(
      items.map((item) => [item.id, item.startsAt]),
      [[eventId, "2026-10-22T09:00:00.000Z"]],
    );
    const logged = await getAdminPool().query<{ title: string; body: string; contact_id: string; metadata: Record<string, unknown> }>(
      "select title, body, contact_id, metadata from crm.activities where title like 'Moved%'",
    );
    assert.deepEqual(
      logged.rows.map(({ title, body, contact_id }) => ({ title, body, contact_id })),
      [
        {
          title: "Moved Eclipse × Jane Doe",
          body: "Thu, 22 Oct 2026, 10:00 to 10:30 London time\nWas Tue, 20 Oct 2026, 14:00 to 14:30 London time",
          contact_id: jane,
        },
      ],
    );
    assert.equal(logged.rows[0].metadata.kind, "move");
    const audit = await getAdminPool().query<{ count: string }>(
      "select count(*) from crm.audit_events where operation = 'reschedule_invite'",
    );
    assert.equal(audit.rows[0].count, "1");
  });

  it("adds the message to the top of the invite and can change the length", async () => {
    const eventId = await invite();
    const calls: Call[] = [];
    await rescheduleInvite(
      owner,
      { eventId, startLocal: "2026-11-03T09:30", durationMinutes: 60, message: "  Running late, <sorry>.  " },
      {
        fetchImpl: graph(calls, {
          read: () =>
            json({ body: { contentType: "html", content: '<html><body lang="en"><div>Join: https://whereby.com/eclipse</div></body></html>' } }),
        }),
        now: NOW,
      },
    );
    const read = calls.find((call) => call.method === "GET" && call.url.includes("/me/events/evt-1"));
    assert.equal(read?.url, "https://graph.microsoft.com/v1.0/me/events/evt-1?$select=body");
    assert.deepEqual(patches(calls)[0].body, {
      start: { dateTime: "2026-11-03T09:30:00", timeZone: "GMT Standard Time" },
      end: { dateTime: "2026-11-03T10:30:00", timeZone: "GMT Standard Time" },
      body: {
        contentType: "HTML",
        content: '<html><body lang="en"><p>Running late, &lt;sorry&gt;.</p><div>Join: https://whereby.com/eclipse</div></body></html>',
      },
    });
    const logged = await getAdminPool().query<{ body: string }>("select body from crm.activities where title like 'Moved%'");
    assert.equal(
      logged.rows[0].body,
      "Tue, 3 Nov 2026, 09:30 to 10:30 London time\nWas Tue, 20 Oct 2026, 14:00 to 14:30 London time\n\nMessage to guests: Running late, <sorry>.",
    );
  });

  it("takes an end time, and refuses past, backwards, unchanged and impossible times before calling Outlook", async () => {
    const eventId = await invite();
    const ended = await rescheduleInvite(
      owner,
      { eventId, startLocal: "2026-10-21T15:00", endLocal: "2026-10-21T15:45" },
      { fetchImpl: graph([]), now: NOW },
    );
    assert.equal(ended.endsAt, "2026-10-21T14:45:00.000Z");
    const calls: Call[] = [];
    const fetchImpl = graph(calls);
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2026-10-14T10:00" }, { fetchImpl, now: NOW }), {
      code: "invalid_input",
      field: "startLocal",
      message: "Pick a start time in the future.",
    });
    await rejects(
      () => rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00", endLocal: "2026-10-22T09:00" }, { fetchImpl, now: NOW }),
      { field: "endLocal", message: "End the meeting after it starts." },
    );
    await rejects(
      () => rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00", endLocal: "2026-10-22T19:00" }, { fetchImpl, now: NOW }),
      { field: "endLocal", message: /between 5 minutes and 8 hours/ },
    );
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2026-10-21T15:00", durationMinutes: 45 }, { fetchImpl, now: NOW }), {
      field: "startLocal",
      message: /already is/,
    });
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2027-03-28T01:30" }, { fetchImpl, now: NOW }), {
      message: /clocks go forward/,
    });
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "tomorrow" }, { fetchImpl, now: NOW }), { field: "startLocal" });
    await rejects(() => rescheduleInvite(owner, { eventId: "nope", startLocal: "2026-10-22T10:00" }, { fetchImpl, now: NOW }), {
      code: "not_found",
    });
    assert.equal(calls.length, 0);
  });

  it("uses the same organiser, start and connection checks as cancelling", async () => {
    const eventId = await invite();
    const calls: Call[] = [];
    const fetchImpl = graph(calls);
    await rejects(
      () => rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00" }, { fetchImpl, now: Date.UTC(2026, 9, 20, 13, 5) }),
      { message: "This meeting has already started, so Orbit can't move it." },
    );
    await getAdminPool().query(
      `update crm.calendar_events
       set created_by_orbit = false, organizer = '{"name":"Jane Doe","email":"jane@acme-invites.test"}'::jsonb
       where id = $1`,
      [eventId],
    );
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00" }, { fetchImpl, now: NOW }), {
      code: "forbidden",
      message: /Only the organiser can move/,
    });
    await getAdminPool().query("update crm.calendar_events set created_by_orbit = true, is_all_day = true where id = $1", [eventId]);
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00" }, { fetchImpl, now: NOW }), {
      message: "Move all-day events in Outlook.",
    });
    await getAdminPool().query("update crm.calendar_events set is_all_day = false, is_cancelled = true where id = $1", [eventId]);
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00" }, { fetchImpl, now: NOW }), {
      code: "conflict",
    });
    assert.equal(calls.length, 0);

    await getAdminPool().query("update crm.calendar_events set is_cancelled = false where id = $1", [eventId]);
    await withActor(owner, (db) => storeGrantedScopes(db, owner, connectionId, READ_SCOPES));
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00" }, { fetchImpl, now: NOW }), {
      code: "scope_missing",
    });
    assert.equal(calls.length, 0);
  });

  it("takes the meeting off the calendar and says so when Outlook no longer has it", async () => {
    const eventId = await invite();
    await rejects(
      () =>
        rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00" }, {
          fetchImpl: graph([], { move: () => json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, 404) }),
          now: NOW,
        }),
      { code: "gone", message: MEETING_GONE },
    );
    const row = await getAdminPool().query<{ starts_at: Date; is_cancelled: boolean }>(
      "select starts_at, is_cancelled from crm.calendar_events where id = $1",
      [eventId],
    );
    assert.equal(row.rows[0].starts_at.toISOString(), "2026-10-20T13:00:00.000Z");
    assert.equal(row.rows[0].is_cancelled, true);
    assert.deepEqual(await listCalendarItems(owner, days, NOW), []);
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2026-10-23T10:00" }, { fetchImpl: graph([]), now: NOW }), {
      code: "conflict",
    });
  });

  it("keeps a meeting longer than 8 hours at its length when only the start changes", async () => {
    const eventId = await invite();
    await getAdminPool().query("update crm.calendar_events set ends_at = starts_at + interval '9 hours' where id = $1", [eventId]);
    const calls: Call[] = [];
    const moved = await rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T09:00" }, { fetchImpl: graph(calls), now: NOW });
    assert.equal(moved.startsAt, "2026-10-22T08:00:00.000Z");
    assert.equal(moved.endsAt, "2026-10-22T17:00:00.000Z");
    assert.deepEqual(patches(calls)[0].body, {
      start: { dateTime: "2026-10-22T09:00:00", timeZone: "GMT Standard Time" },
      end: { dateTime: "2026-10-22T18:00:00", timeZone: "GMT Standard Time" },
    });
    await rejects(
      () => rescheduleInvite(owner, { eventId, startLocal: "2026-10-23T09:00", durationMinutes: 540 }, { fetchImpl: graph([]), now: NOW }),
      { field: "durationMinutes", message: /between 5 minutes and 8 hours/ },
    );
  });

  it("points a real all-day event to Outlook rather than asking for a duration", async () => {
    const eventId = await invite();
    await getAdminPool().query(
      `update crm.calendar_events
       set is_all_day = true, starts_at = '2026-10-23T00:00:00Z', ends_at = '2026-10-24T00:00:00Z'
       where id = $1`,
      [eventId],
    );
    const calls: Call[] = [];
    await rejects(() => rescheduleInvite(owner, { eventId, startLocal: "2026-10-22T10:00" }, { fetchImpl: graph(calls), now: NOW }), {
      code: "invalid_input",
      message: "Move all-day events in Outlook.",
    });
    assert.equal(calls.length, 0);
  });

  it("names the meeting, both times and the guests on the assistant's card", async () => {
    const eventId = await invite();
    const args = { eventId, startLocal: "2026-10-22T10:00", message: "New slot" };
    const card = describeAction("move_meeting", args, await recordNames(owner, [args]));
    assert.equal(card.title, "Move meeting: Eclipse × Jane Doe");
    assert.equal(card.lines.length, 4);
    assert.match(card.lines[0], /^From: .*20 Oct.*14:00 for 30 minutes$/);
    assert.match(card.lines[1], /^To: .*22 Oct.*10:00 for 30 minutes$/);
    assert.equal(card.lines[2], "Guests: Jane Doe");
    assert.equal(card.lines[3], "Message to guests: New slot");
  });
});

describe("answering invites", () => {
  let owner: UserActor;
  let connectionId: string;
  let jane: string;
  const days = { start: new Date("2026-10-19T00:00:00Z"), end: new Date("2026-10-24T00:00:00Z") };

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

  function invitation(extra: Partial<GraphEvent> = {}): GraphEvent {
    return {
      id: "inv-1",
      iCalUId: "ical-inv-1",
      subject: "Acme review",
      start: utc("2026-10-21T10:00:00.000Z"),
      end: utc("2026-10-21T11:00:00.000Z"),
      isAllDay: false,
      isCancelled: false,
      organizer: { emailAddress: { name: "Jane Doe", address: "jane@acme-invites.test" } },
      attendees: [
        { type: "required", status: { response: "none" }, emailAddress: { name: "Founder", address: MAILBOX } },
        { type: "required", status: { response: "accepted" }, emailAddress: { name: "Bob Stone", address: "bob@acme-invites.test" } },
      ],
      showAs: "tentative",
      responseStatus: { response: "notResponded" },
      ...extra,
    };
  }

  async function invited(extra: Partial<GraphEvent> = {}) {
    const sync = await syncCalendar(owner, { fetchImpl: graph([], { events: () => [invitation(extra)] }), force: true });
    assert.equal(sync.error, undefined);
    const row = await getAdminPool().query<{ id: string }>(
      "select id from crm.calendar_events where provider_event_id = $1 and user_id = $2",
      [extra.id ?? "inv-1", owner.userId],
    );
    return row.rows[0].id;
  }

  async function stored(eventId: string) {
    const row = await getAdminPool().query<{
      response_status: string | null;
      show_as: string | null;
      is_cancelled: boolean;
      attendees: { email: string; response: string | null }[];
    }>("select response_status, show_as, is_cancelled, attendees from crm.calendar_events where id = $1", [eventId]);
    return row.rows[0];
  }

  async function responses() {
    const rows = await getAdminPool().query<{ title: string; body: string; contact_id: string; metadata: Record<string, unknown> }>(
      "select title, body, contact_id, metadata from crm.activities where metadata->>'kind' = 'response' order by created_at",
    );
    return rows.rows;
  }

  it("fills the user's response from Graph when the calendar syncs", async () => {
    const calls: Call[] = [];
    await syncCalendar(owner, { fetchImpl: graph(calls, { events: () => [invitation()] }), force: true });
    const view = calls.find((call) => call.url.includes("/calendarView"));
    assert.match(new URL(view!.url).searchParams.get("$select") ?? "", /responseStatus/);
    const row = await getAdminPool().query<{ id: string; response_status: string | null }>(
      "select id, response_status from crm.calendar_events where provider_event_id = 'inv-1'",
    );
    assert.equal(row.rows[0].response_status, "notResponded");
    const [item] = await listCalendarItems(owner, days, NOW);
    assert.equal(item.myResponse, "notResponded");
    assert.equal(item.organisedByMe, false);
    assert.equal(item.canRespond, true);
    assert.equal(item.canCancel, false);

    await invited({ responseStatus: { response: "TentativelyAccepted" } });
    assert.equal((await stored(row.rows[0].id)).response_status, "tentativelyAccepted");
    await invited({ responseStatus: { response: "somethingNew" } });
    assert.equal((await stored(row.rows[0].id)).response_status, null);
  });

  it("accepts with a note, stores the response and logs it on the organiser", async () => {
    const eventId = await invited();
    const calls: Call[] = [];
    const result = await respondToInvite(
      owner,
      { eventId, response: "accept", note: "  See you there.  " },
      { fetchImpl: graph(calls), now: NOW },
    );
    const [post] = posts(calls);
    assert.equal(posts(calls).length, 1);
    assert.equal(post.url, "https://graph.microsoft.com/v1.0/me/events/inv-1/accept");
    assert.deepEqual(post.body, { sendResponse: true, comment: "See you there." });
    assert.equal(result.responseStatus, "accepted");
    assert.equal(result.organizerTold, true);
    assert.deepEqual(result.organizer, { name: "Jane Doe", email: "jane@acme-invites.test" });
    assert.equal(result.loggedOn, 1);
    assert.equal(result.warning, null);
    const row = await stored(eventId);
    assert.equal(row.response_status, "accepted");
    assert.equal(row.show_as, "busy");
    assert.deepEqual(
      row.attendees.map((person) => [person.email, person.response]),
      [
        [MAILBOX, "accepted"],
        ["bob@acme-invites.test", "accepted"],
      ],
    );
    const logged = await responses();
    assert.equal(logged.length, 1);
    assert.equal(logged[0].title, "Accepted Acme review");
    assert.equal(logged[0].contact_id, jane);
    assert.equal(logged[0].body, "Wed, 21 Oct 2026, 11:00 to 12:00 London time\n\nNote to the organiser: See you there.");
    assert.equal(logged[0].metadata.response, "accepted");
    const [item] = await listCalendarItems(owner, days, NOW);
    assert.equal(item.myResponse, "accepted");
    assert.equal(item.canRespond, true);
  });

  it("says maybe without telling the organiser, then declines", async () => {
    const eventId = await invited({ showAs: "busy" });
    const calls: Call[] = [];
    const maybe = await respondToInvite(
      owner,
      { eventId, response: "tentative", sendResponse: false },
      { fetchImpl: graph(calls), now: NOW },
    );
    assert.equal(posts(calls)[0].url, "https://graph.microsoft.com/v1.0/me/events/inv-1/tentativelyAccept");
    assert.deepEqual(posts(calls)[0].body, { sendResponse: false });
    assert.equal(maybe.organizerTold, false);
    assert.equal(maybe.loggedOn, 0);
    const after = await stored(eventId);
    assert.deepEqual([after.response_status, after.show_as], ["tentativelyAccepted", "tentative"]);
    assert.equal((await responses()).length, 0);

    const declined = await respondToInvite(owner, { eventId, response: "Decline" }, { fetchImpl: graph(calls), now: NOW });
    assert.equal(posts(calls)[1].url, "https://graph.microsoft.com/v1.0/me/events/inv-1/decline");
    assert.deepEqual(posts(calls)[1].body, { sendResponse: true });
    assert.equal(declined.responseStatus, "declined");
    assert.equal((await stored(eventId)).response_status, "declined");
    const logged = await responses();
    assert.deepEqual(
      logged.map((entry) => [entry.title, entry.body, entry.contact_id]),
      [["Declined Acme review", "Wed, 21 Oct 2026, 11:00 to 12:00 London time", jane]],
    );
  });

  it("suggests a new time with maybe or decline, and checks it first", async () => {
    const eventId = await invited();
    const calls: Call[] = [];
    const result = await respondToInvite(
      owner,
      { eventId, response: "decline", note: "Clash", proposedStartLocal: "2026-10-22T15:00" },
      { fetchImpl: graph(calls), now: NOW },
    );
    assert.deepEqual(posts(calls)[0].body, {
      sendResponse: true,
      comment: "Clash",
      proposedNewTime: {
        start: { dateTime: "2026-10-22T15:00:00", timeZone: "GMT Standard Time" },
        end: { dateTime: "2026-10-22T16:00:00", timeZone: "GMT Standard Time" },
      },
    });
    assert.equal(result.proposedStartsAt, "2026-10-22T14:00:00.000Z");
    assert.equal(result.proposedEndsAt, "2026-10-22T15:00:00.000Z");
    const [logged] = await responses();
    assert.equal(
      logged.body,
      "Wed, 21 Oct 2026, 11:00 to 12:00 London time\nSuggested instead: Thu, 22 Oct 2026, 15:00 to 16:00 London time\n\nNote to the organiser: Clash",
    );

    await respondToInvite(
      owner,
      { eventId, response: "tentative", proposedStartLocal: "2026-10-22T15:00", proposedDurationMinutes: 30 },
      { fetchImpl: graph(calls), now: NOW },
    );
    assert.deepEqual((posts(calls)[1].body as { proposedNewTime: { end: unknown } }).proposedNewTime.end, {
      dateTime: "2026-10-22T15:30:00",
      timeZone: "GMT Standard Time",
    });

    const refused: Call[] = [];
    const answer = (input: Record<string, unknown>) =>
      respondToInvite(owner, { eventId, ...input }, { fetchImpl: graph(refused), now: NOW });
    await rejects(() => answer({ response: "accept", proposedStartLocal: "2026-10-22T15:00" }), {
      code: "invalid_input",
      field: "proposedStartLocal",
    });
    await rejects(() => answer({ response: "decline", note: "Hi", sendResponse: false }), {
      code: "invalid_input",
      field: "note",
    });
    await rejects(() => answer({ response: "decline", proposedStartLocal: "2026-10-21T11:00" }), {
      message: /already is/,
      field: "proposedStartLocal",
    });
    await rejects(() => answer({ response: "decline", proposedStartLocal: "2026-10-01T11:00" }), {
      message: "Pick a start time in the future.",
      field: "proposedStartLocal",
    });
    await rejects(
      () => answer({ response: "decline", proposedStartLocal: "2026-10-22T15:00", proposedDurationMinutes: 600 }),
      { field: "proposedDurationMinutes" },
    );
    await rejects(() => answer({ response: "maybe" }), { field: "response" });
    await rejects(() => answer({ response: "accept", sendResponse: "yes" }), { field: "sendResponse" });
    assert.equal(refused.length, 0);

    await rejects(
      () =>
        respondToInvite(owner, { eventId, response: "tentative", proposedStartLocal: "2026-10-22T15:00" }, {
          fetchImpl: graph([], {
            respond: () =>
              json({ error: { code: "ErrorInvalidRequest", message: "The meeting organizer doesn't allow new time proposals." } }, 400),
          }),
          now: NOW,
        }),
      { code: "invalid_input", message: /isn't taking new time proposals/ },
    );
  });

  it("refuses meetings the user organised", async () => {
    const own = await createInvite(owner, baseInput(), { fetchImpl: graph([]), now: NOW });
    const calls: Call[] = [];
    await rejects(() => respondToInvite(owner, { eventId: own.eventId, response: "accept" }, { fetchImpl: graph(calls), now: NOW }), {
      code: "forbidden",
      message: RESPOND_ORGANISER,
    });
    const organised = await invited({
      id: "inv-2",
      organizer: { emailAddress: { name: "Founder", address: MAILBOX } },
      responseStatus: { response: "organizer" },
    });
    await rejects(() => respondToInvite(owner, { eventId: organised, response: "decline" }, { fetchImpl: graph(calls), now: NOW }), {
      code: "forbidden",
      message: RESPOND_ORGANISER,
    });
    assert.equal(calls.length, 0);
    const items = await listCalendarItems(owner, days, NOW);
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.equal(item.organisedByMe, true);
      assert.equal(item.canRespond, false);
    }
  });

  it("refuses meetings that have started or are cancelled", async () => {
    const eventId = await invited();
    const calls: Call[] = [];
    const started = Date.UTC(2026, 9, 21, 10, 5);
    await rejects(() => respondToInvite(owner, { eventId, response: "accept" }, { fetchImpl: graph(calls), now: started }), {
      code: "invalid_input",
      message: /already started/,
    });
    const [item] = await listCalendarItems(owner, days, started);
    assert.equal(item.canRespond, false);
    await getAdminPool().query("update crm.calendar_events set is_cancelled = true where id = $1", [eventId]);
    await rejects(() => respondToInvite(owner, { eventId, response: "accept" }, { fetchImpl: graph(calls), now: NOW }), {
      code: "conflict",
    });
    await rejects(() => respondToInvite(owner, { eventId: "nope", response: "accept" }, { fetchImpl: graph(calls), now: NOW }), {
      code: "not_found",
    });
    assert.equal(calls.length, 0);
  });

  it("takes the meeting off the calendar when Outlook no longer has it", async () => {
    const eventId = await invited();
    await rejects(
      () =>
        respondToInvite(owner, { eventId, response: "accept" }, {
          fetchImpl: graph([], {
            respond: () => json({ error: { code: "ErrorItemNotFound", message: "The specified object was not found." } }, 404),
          }),
          now: NOW,
        }),
      { code: "gone", message: MEETING_GONE },
    );
    const row = await stored(eventId);
    assert.equal(row.is_cancelled, true);
    assert.equal(row.response_status, "notResponded");
    assert.equal((await responses()).length, 0);
  });

  it("needs the connected mailbox with write access", async () => {
    const eventId = await invited();
    const calls: Call[] = [];
    await withActor(owner, (db) => storeGrantedScopes(db, owner, connectionId, READ_SCOPES));
    await rejects(() => respondToInvite(owner, { eventId, response: "accept" }, { fetchImpl: graph(calls), now: NOW }), {
      code: "scope_missing",
    });
    await getAdminPool().query("update crm.mailbox_connections set status = 'disconnected' where id = $1", [connectionId]);
    await rejects(() => respondToInvite(owner, { eventId, response: "accept" }, { fetchImpl: graph(calls), now: NOW }), {
      code: "not_connected",
      message: RESPOND_NOT_CONNECTED,
    });
    const [item] = await listCalendarItems(owner, days, NOW);
    assert.equal(item.canRespond, false);
    assert.equal(posts(calls).length, 0);
  });

  it("shows the meeting, organiser, response, note and who is told on the assistant's card", async () => {
    const eventId = await invited();
    const args = { eventId, response: "decline", note: "Clash", proposedStartLocal: "2026-10-22T15:00" };
    const card = describeAction("respond_to_meeting", args, await recordNames(owner, [args]));
    assert.equal(card.title, "Answer invite: Acme review");
    assert.equal(card.lines.length, 6);
    assert.match(card.lines[0], /^When: .*21 Oct.*11:00$/);
    assert.equal(card.lines[1], "Organiser: Jane Doe (jane@acme-invites.test)");
    assert.equal(card.lines[2], "Response: Decline");
    assert.match(card.lines[3], /^Suggested time: .*22 Oct.*15:00 for 60 minutes$/);
    assert.equal(card.lines[4], "Note to the organiser: Clash");
    assert.equal(card.lines[5], "Outlook tells the organiser when you approve.");

    const quiet = { eventId, response: "tentative", tellOrganiser: false };
    const quietCard = describeAction("respond_to_meeting", quiet, await recordNames(owner, [quiet]));
    assert.deepEqual(quietCard.lines.slice(2), ["Response: Maybe (tentative)", "The organiser isn't told."]);
    const missing = describeAction("respond_to_meeting", { eventId: "6f1c1c55-8d0c-4a43-9a3e-3f3b8ad1e0c1", response: "accept" });
    assert.equal(missing.title, "Answer invite: a meeting Orbit can't find");
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
