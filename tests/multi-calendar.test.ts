import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  allDayKeys,
  calendarRange,
  dateKey,
  daySpan,
  packColumns,
  parseDateKey,
  parseMode,
  rangeDays,
  shiftDateKey,
  wallMinutes,
  weekStartKey,
} from "@/lib/calendar-view";
import { getMeetings, listPeopleMet, syncCalendar } from "@/lib/crm/calendar";
import {
  connectCalendarAccount,
  disconnectCalendarAccount,
  SAME_AS_PRIMARY,
} from "@/lib/crm/calendar-accounts";
import {
  createContactFromEvent,
  listCalendarGroups,
  listCalendarItems,
  setCalendarForCrm,
  setCalendarVisible,
} from "@/lib/crm/calendars";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { backgroundTargets } from "@/lib/crm/conversations";
import { saveMailbox } from "@/lib/crm/inbox";
import { DEFAULT_STEPS } from "@/lib/crm/scheduler";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { calendarColor, toCalendarInfo, type GraphEvent } from "@/lib/microsoft/calendar";
import {
  CALENDAR_ACCOUNT_SCOPES,
  consentProblem,
  microsoftAuthorizationUrl,
  ORGANISATION_BLOCKED,
  readMicrosoftState,
  SIGN_IN_CANCELLED,
  signMicrosoftState,
} from "@/lib/microsoft/oauth";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TENANT = "11111111-2222-3333-4444-555555555555";

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

function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
}

function event(id: string, startsAt: number, people: string[] = [], extra: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id,
    iCalUId: `ical-${id}`,
    subject: `Meeting ${id}`,
    start: utc(startsAt),
    end: utc(startsAt + HOUR),
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    organizer: { emailAddress: { name: "Organiser", address: "boss@orbit-multi.test" } },
    attendees: people.map((email) => ({
      type: "required",
      status: { response: "accepted" },
      emailAddress: { name: email.split("@")[0], address: email },
    })),
    ...extra,
  };
}

type Mailbox = {
  calendars: Record<string, unknown>[];
  events: Record<string, GraphEvent[]>;
  denied?: string[];
};

function graph(mailboxes: Record<string, Mailbox>, calls: Call[], delayMs = 0) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const token = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(
      "Bearer ",
      "",
    );
    const mailbox = mailboxes[token];
    if (!mailbox) return json({ error: { code: "InvalidAuthenticationToken", message: "bad token" } }, 401);
    const parsed = new URL(url);
    if (parsed.pathname === "/v1.0/me/calendars") return json({ value: mailbox.calendars });
    const match = /^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/.exec(parsed.pathname);
    if (!match) throw new Error(`unexpected ${url}`);
    const calendarId = decodeURIComponent(match[1]);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (mailbox.denied?.includes(calendarId)) {
      return json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403);
    }
    return json({ value: mailbox.events[calendarId] ?? [] });
  }) as typeof fetch;
}

function oauthStub(calls: Call[], identity: { mail: string | null; upn: string; name: string }, tokenStatus = 200) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/oauth2/v2.0/token")) {
      if (tokenStatus !== 200) {
        return json(
          {
            error: "unauthorized_client",
            error_description:
              "AADSTS700016: Application with identifier 'test-client' was not found in the directory 'Partner Ltd'.",
          },
          tokenStatus,
        );
      }
      return json({
        access_token: "acct-access",
        refresh_token: "acct-refresh",
        expires_in: 3600,
        scope: "https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read",
        id_token: idToken({ tid: TENANT }),
      });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      return json({ mail: identity.mail, userPrincipalName: identity.upn, displayName: identity.name });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

async function calendarRows(userId: string) {
  const result = await getAdminPool().query<{
    id: string;
    provider_calendar_id: string;
    name: string;
    color: string;
    is_default: boolean;
    is_visible: boolean;
    use_for_crm: boolean;
    account_id: string | null;
    connection_id: string | null;
    last_error: string | null;
  }>(
    `select id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm,
            account_id, connection_id, last_error
     from crm.calendars where user_id = $1 order by provider_calendar_id`,
    [userId],
  );
  return new Map(result.rows.map((row) => [row.provider_calendar_id, row]));
}

async function eventsFor(userId: string) {
  const result = await getAdminPool().query<{
    id: string;
    provider_event_id: string;
    calendar_id: string;
    account_id: string | null;
    connection_id: string | null;
    contact_ids: string[];
    show_as: string | null;
  }>(
    `select id, provider_event_id, calendar_id, account_id, connection_id, contact_ids, show_as
     from crm.calendar_events where user_id = $1 order by provider_event_id`,
    [userId],
  );
  return new Map(result.rows.map((row) => [row.provider_event_id, row]));
}

async function resetGates() {
  await getAdminPool().query("update crm.integration_state set last_attempt_at = null where source = 'calendar'");
  await getAdminPool().query("update crm.calendar_accounts set last_attempt_at = null");
}

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
  delete process.env.MICROSOFT_TENANT;
});

after(async () => {
  await getPool().end();
});

describe("calendar view helpers", () => {
  it("parses dates and views", () => {
    assert.equal(parseDateKey("2026-10-14"), "2026-10-14");
    assert.equal(parseDateKey("2026-02-30"), null);
    assert.equal(parseDateKey("14/10/2026"), null);
    assert.equal(parseMode("week"), "week");
    assert.equal(parseMode("month"), null);
    assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
    assert.equal(weekStartKey("2026-10-18"), "2026-10-12");
    assert.equal(weekStartKey("2026-10-19"), "2026-10-19");
    assert.deepEqual(rangeDays("2026-10-14", "day"), ["2026-10-14"]);
    assert.equal(rangeDays("2026-10-14", "week")[6], "2026-10-18");
  });

  it("builds London ranges across both DST changes", () => {
    const autumn = calendarRange("2026-10-25", "week", "Europe/London");
    assert.equal(autumn.days[0], "2026-10-19");
    assert.equal(autumn.start.toISOString(), "2026-10-18T23:00:00.000Z");
    assert.equal(autumn.end.toISOString(), "2026-10-26T00:00:00.000Z");
    assert.equal(autumn.end.getTime() - autumn.start.getTime(), 7 * DAY + HOUR);

    const longDay = calendarRange("2026-10-25", "day", "Europe/London");
    assert.equal(longDay.end.getTime() - longDay.start.getTime(), 25 * HOUR);

    const spring = calendarRange("2026-03-29", "day", "Europe/London");
    assert.equal(spring.start.toISOString(), "2026-03-29T00:00:00.000Z");
    assert.equal(spring.end.toISOString(), "2026-03-29T23:00:00.000Z");

    const springWeek = calendarRange("2026-03-25", "week", "Europe/London");
    assert.equal(springWeek.start.toISOString(), "2026-03-23T00:00:00.000Z");
    assert.equal(springWeek.end.toISOString(), "2026-03-29T23:00:00.000Z");

    assert.equal(dateKey("2026-10-18T23:30:00.000Z", "Europe/London"), "2026-10-19");
    assert.equal(dateKey("2026-12-18T23:30:00.000Z", "Europe/London"), "2026-12-18");
    assert.equal(wallMinutes("2026-03-29T01:30:00.000Z", "Europe/London"), 150);
  });

  it("clips events to a day and keeps all-day events on their dates", () => {
    assert.deepEqual(daySpan("2026-10-14T08:00:00.000Z", "2026-10-14T09:30:00.000Z", "2026-10-14", "Europe/London"), {
      top: 540,
      bottom: 630,
    });
    assert.deepEqual(daySpan("2026-10-13T22:00:00.000Z", "2026-10-14T01:00:00.000Z", "2026-10-14", "Europe/London"), {
      top: 0,
      bottom: 120,
    });
    assert.deepEqual(daySpan("2026-10-14T22:00:00.000Z", "2026-10-15T01:00:00.000Z", "2026-10-14", "Europe/London"), {
      top: 1380,
      bottom: 1440,
    });
    assert.equal(daySpan("2026-10-15T09:00:00.000Z", "2026-10-15T10:00:00.000Z", "2026-10-14", "Europe/London"), null);
    assert.deepEqual(daySpan("2026-10-25T00:30:00.000Z", "2026-10-25T02:00:00.000Z", "2026-10-25", "Europe/London"), {
      top: 90,
      bottom: 120,
    });
    assert.deepEqual(allDayKeys("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z", "Europe/London"), [
      "2026-10-14",
    ]);
    assert.deepEqual(allDayKeys("2026-10-24T00:00:00.000Z", "2026-10-27T00:00:00.000Z", "Europe/London"), [
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ]);
    assert.deepEqual(allDayKeys("2026-10-13T23:00:00.000Z", "2026-10-14T23:00:00.000Z", "Europe/London"), [
      "2026-10-14",
    ]);
  });

  it("packs overlapping events into side-by-side columns", () => {
    const slots = packColumns([
      { id: "a", top: 540, bottom: 600 },
      { id: "b", top: 570, bottom: 630 },
      { id: "c", top: 600, bottom: 660 },
      { id: "d", top: 720, bottom: 780 },
      { id: "e", top: 540, bottom: 560 },
    ]);
    assert.deepEqual(Object.fromEntries(slots), {
      a: { column: 0, columns: 2 },
      e: { column: 1, columns: 2 },
      b: { column: 1, columns: 2 },
      c: { column: 0, columns: 2 },
      d: { column: 0, columns: 1 },
    });
    const three = packColumns([
      { id: "late", top: 560, bottom: 640 },
      { id: "first", top: 540, bottom: 600 },
      { id: "middle", top: 550, bottom: 620 },
      { id: "after", top: 630, bottom: 650 },
    ]);
    assert.deepEqual(Object.fromEntries(three), {
      first: { column: 0, columns: 3 },
      middle: { column: 1, columns: 3 },
      late: { column: 2, columns: 3 },
      after: { column: 0, columns: 3 },
    });
    const touching = packColumns([
      { id: "x", top: 60, bottom: 120 },
      { id: "y", top: 120, bottom: 180 },
    ]);
    assert.deepEqual(Object.fromEntries(touching), { x: { column: 0, columns: 1 }, y: { column: 0, columns: 1 } });
    const tiny = packColumns(
      [
        { id: "p", top: 600, bottom: 600 },
        { id: "q", top: 605, bottom: 640 },
      ],
      15,
    );
    assert.equal(tiny.get("p")?.columns, 2);
    assert.equal(tiny.get("q")?.column, 1);
    assert.equal(packColumns([]).size, 0);
  });

  it("maps Graph calendar colours with a palette fallback", () => {
    assert.equal(calendarColor({ hexColor: "#A1B2C3", color: "lightRed" }), "#a1b2c3");
    assert.equal(calendarColor({ hexColor: "#abc" }), "#aabbcc");
    assert.equal(calendarColor({ hexColor: "", color: "lightGreen" }), "#5fb760");
    assert.equal(calendarColor({ hexColor: "", color: "auto" }, 1), "#5fb760");
    assert.equal(calendarColor({ hexColor: "", color: "auto" }, 9), "#5fb760");
    const info = toCalendarInfo({
      id: "x",
      name: "  Team  ",
      hexColor: "",
      color: "auto",
      isDefaultCalendar: false,
      canEdit: false,
      owner: { name: "Ada", address: "Ada@Partner.test" },
    });
    assert.deepEqual(info, {
      providerCalendarId: "x",
      name: "Team",
      color: "#4f9be8",
      colorExplicit: false,
      isDefault: false,
      canEdit: false,
      ownerEmail: "ada@partner.test",
    });
    assert.equal(toCalendarInfo({ id: "" }), null);
  });
});

describe("extra calendar account oauth", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("founder@orbit-multi.test", "Founder");
    await saveMailbox(owner, {
      email: "founder@orbit-multi.test",
      refreshToken: "main-refresh",
      accessToken: "main-access",
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
  });

  it("signs the purpose into the state and asks for calendar-only scopes", () => {
    const state = signMicrosoftState("user-1", "workspace-1", 1_000, "calendar_account");
    assert.deepEqual(readMicrosoftState(state, 1_000), {
      userId: "user-1",
      workspaceId: "workspace-1",
      purpose: "calendar_account",
    });
    const legacy = signMicrosoftState("user-1", "workspace-1", 1_000);
    assert.equal(readMicrosoftState(legacy, 1_000)?.purpose, "mailbox");
    const url = microsoftAuthorizationUrl("https://orbit.test", state, {
      purpose: "calendar_account",
      loginHint: "me@partner.test",
    });
    assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
    assert.equal(url.searchParams.get("scope"), CALENDAR_ACCOUNT_SCOPES);
    assert.equal(url.searchParams.get("scope"), "openid offline_access User.Read Calendars.Read");
    assert.equal(url.searchParams.get("prompt"), "select_account");
    assert.equal(url.searchParams.get("login_hint"), "me@partner.test");
    assert.equal(url.searchParams.get("redirect_uri"), "https://orbit.test/api/microsoft/callback");
    const mailbox = microsoftAuthorizationUrl("https://orbit.test", legacy);
    assert.match(mailbox.searchParams.get("scope") ?? "", /Mail\.Send/);
    assert.equal(mailbox.searchParams.has("login_hint"), false);
  });

  it("explains organisation blocks and cancelled sign-ins", () => {
    for (const message of [
      "AADSTS50020: User account 'me@partner.test' from identity provider 'live.com' does not exist in tenant 'Orbit'",
      "AADSTS700016: Application with identifier 'x' was not found in the directory 'Partner'.",
      "AADSTS65001: The user or administrator has not consented to use the application",
      "AADSTS90094: Admin consent is required.",
      "AADSTS50194: Application 'x' is not configured as a multi-tenant application.",
      "consent_required",
      "The client does not exist or is not enabled for consumers.",
    ]) {
      assert.equal(consentProblem(message), ORGANISATION_BLOCKED, message);
    }
    assert.equal(consentProblem("access_denied AADSTS65004: User declined to consent"), SIGN_IN_CANCELLED);
    assert.equal(consentProblem("AADSTS70008: The provided authorization code has expired"), null);
    assert.match(ORGANISATION_BLOCKED, /Supported account types/);
  });

  it("stores an extra account with encrypted tokens, tenant and display name", async () => {
    const calls: Call[] = [];
    const saved = await connectCalendarAccount(
      owner,
      { origin: "https://orbit.test", code: "code-1" },
      oauthStub(calls, { mail: null, upn: "Me@Partner.test", name: "Me at Partner" }),
    );
    assert.equal(saved.email, "me@partner.test");
    assert.equal(saved.scopeMissing, false);
    const body = new URLSearchParams(String(calls[0].init?.body));
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("scope"), CALENDAR_ACCOUNT_SCOPES);
    assert.equal(body.get("redirect_uri"), "https://orbit.test/api/microsoft/callback");
    assert.match(calls[1].url, /\$select=mail,userPrincipalName,displayName/);
    const row = await getAdminPool().query<{
      email: string;
      display_name: string;
      tenant_id: string;
      refresh_token: string;
      status: string;
    }>("select email, display_name, tenant_id, refresh_token, status from crm.calendar_accounts where id = $1", [
      saved.id,
    ]);
    assert.equal(row.rows[0].display_name, "Me at Partner");
    assert.equal(row.rows[0].tenant_id, TENANT);
    assert.notEqual(row.rows[0].refresh_token, "acct-refresh");
    assert.equal(decryptSecret(row.rows[0].refresh_token), "acct-refresh");

    const again = await connectCalendarAccount(
      owner,
      { origin: "https://orbit.test", code: "code-2" },
      oauthStub([], { mail: "me@partner.test", upn: "me@partner.test", name: "Me" }),
    );
    assert.equal(again.id, saved.id);
    const count = await getAdminPool().query<{ total: number }>(
      "select count(*)::int as total from crm.calendar_accounts where user_id = $1",
      [owner.userId],
    );
    assert.equal(count.rows[0].total, 1);
  });

  it("refuses the main account and explains a tenant that blocks Orbit", async () => {
    await assert.rejects(
      connectCalendarAccount(
        owner,
        { origin: "https://orbit.test", code: "code-3" },
        oauthStub([], { mail: "Founder@Orbit-Multi.test", upn: "founder@orbit-multi.test", name: "Founder" }),
      ),
      (error: Error) => error.message === SAME_AS_PRIMARY,
    );
    await assert.rejects(
      connectCalendarAccount(
        owner,
        { origin: "https://orbit.test", code: "code-4" },
        oauthStub([], { mail: "x@blocked.test", upn: "x@blocked.test", name: "X" }, 400),
      ),
      (error: Error) => error.message === ORGANISATION_BLOCKED,
    );
    const emails = await getAdminPool().query<{ email: string }>(
      "select email from crm.calendar_accounts where user_id = $1 order by email",
      [owner.userId],
    );
    assert.deepEqual(
      emails.rows.map((row) => row.email),
      ["me@partner.test"],
    );
  });
});

describe("multi-calendar sync", () => {
  let owner: UserActor;
  let accountId: string;
  let janeId: string;
  let acmeId: string;
  const now = Date.now();
  let mailboxes: Record<string, Mailbox>;

  before(async () => {
    owner = await createUser("lead@orbit-sync.test", "Lead");
    await saveMailbox(owner, {
      email: "lead@orbit-sync.test",
      refreshToken: "main-refresh",
      accessToken: "main-access",
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    accountId = (
      await connectCalendarAccount(
        owner,
        { origin: "https://orbit.test", code: "code" },
        oauthStub([], { mail: "lead@side.test", upn: "lead@side.test", name: "Lead (side)" }),
      )
    ).id;
    acmeId = (await createCompany(owner, { name: "Acme", domain: "acme.com" })).body.company.id;
    janeId = (
      await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.com", companyId: acmeId })
    ).body.contact.id;
    mailboxes = {
      "main-access": {
        calendars: [
          { id: "main-default", name: "Calendar", isDefaultCalendar: true, hexColor: "", color: "auto", canEdit: true },
          { id: "main-birthdays", name: "Birthdays", isDefaultCalendar: false, color: "lightPink", canEdit: false },
        ],
        events: {
          "main-default": [
            event("m1", now + DAY, ["jane@acme.com"]),
            event("shared-meeting", now + 2 * DAY, ["raj@acme.com"], { iCalUId: "ical-shared" }),
          ],
          "main-birthdays": [event("b1", now + 3 * DAY, ["jane@acme.com"], { isAllDay: true, showAs: "free" })],
        },
      },
      "acct-access": {
        calendars: [
          { id: "side-default", name: "Calendar", isDefaultCalendar: true, hexColor: "#00AA55", canEdit: true },
          { id: "side-team", name: "Team", isDefaultCalendar: false, color: "auto", canEdit: false },
          {
            id: "side-shared",
            name: "Boss",
            isDefaultCalendar: false,
            canEdit: false,
            owner: { address: "boss@side.test" },
          },
        ],
        denied: ["side-shared"],
        events: {
          "side-default": [
            event("s1", now + DAY + 30 * 60 * 1000, ["jane@acme.com"], { showAs: "tentative" }),
            event("shared-meeting-copy", now + 2 * DAY, ["raj@acme.com"], { iCalUId: "ical-shared" }),
          ],
          "side-team": [event("t1", now - 2 * DAY, ["pat@newco.io"])],
        },
      },
    };
  });

  beforeEach(resetGates);

  it("lists every account's calendars and syncs each calendar's events", async () => {
    const calls: Call[] = [];
    const result = await syncCalendar(owner, { fetchImpl: graph(mailboxes, calls), now });
    assert.equal(result.ran, true);
    assert.equal(result.error, undefined);
    assert.equal(result.complete, true);
    assert.equal(result.calendars, 4);
    assert.equal(result.saved, 6);

    const calendars = await calendarRows(owner.userId);
    assert.deepEqual([...calendars.keys()], [
      "main-birthdays",
      "main-default",
      "side-default",
      "side-shared",
      "side-team",
    ]);
    assert.equal(calendars.get("main-default")!.use_for_crm, true);
    assert.equal(calendars.get("main-birthdays")!.use_for_crm, false);
    assert.equal(calendars.get("side-default")!.use_for_crm, false);
    assert.equal(calendars.get("side-default")!.account_id, accountId);
    assert.equal(calendars.get("main-default")!.connection_id !== null, true);
    assert.equal(calendars.get("side-default")!.color, "#00aa55");
    assert.equal(calendars.get("main-birthdays")!.color, "#e46aa6");
    assert.match(calendars.get("side-shared")!.last_error ?? "", /didn't let Orbit read/);

    const views = calls.filter((call) => call.url.includes("/calendarView")).map((call) => new URL(call.url));
    assert.equal(views.length, 5);
    for (const view of views) {
      assert.equal(view.searchParams.get("startDateTime"), new Date(now - 30 * DAY).toISOString());
      assert.equal(view.searchParams.get("endDateTime"), new Date(now + 60 * DAY).toISOString());
      assert.match(view.searchParams.get("$select") ?? "", /showAs/);
    }

    const events = await eventsFor(owner.userId);
    assert.equal(events.size, 6);
    assert.equal(events.get("s1")!.account_id, accountId);
    assert.equal(events.get("s1")!.connection_id, null);
    assert.equal(events.get("s1")!.show_as, "tentative");
    assert.equal(events.get("m1")!.calendar_id, calendars.get("main-default")!.id);
    assert.deepEqual(events.get("m1")!.contact_ids, [janeId]);
    assert.deepEqual(events.get("s1")!.contact_ids, []);
    assert.deepEqual(events.get("b1")!.contact_ids, []);

    const groups = await listCalendarGroups(owner);
    assert.deepEqual(
      groups.map((group) => [group.kind, group.email, group.calendars.length]),
      [
        ["primary", "lead@orbit-sync.test", 2],
        ["account", "lead@side.test", 3],
      ],
    );
    assert.equal(groups[1].displayName, "Lead (side)");
    assert.ok(groups[1].lastSyncedAt);
  });

  it("only links CRM calendars, and dedupes the same meeting across calendars", async () => {
    const jane = await getMeetings(owner, { contactId: janeId }, now);
    assert.deepEqual(
      jane.upcoming.map((meeting) => meeting.subject),
      ["Meeting m1"],
    );
    const met = await listPeopleMet(owner, now);
    assert.deepEqual(
      met.map((person) => person.email),
      ["boss@orbit-multi.test", "raj@acme.com"],
    );

    const calendars = await calendarRows(owner.userId);
    await setCalendarForCrm(owner, calendars.get("side-default")!.id, true);
    const events = await eventsFor(owner.userId);
    assert.deepEqual(events.get("s1")!.contact_ids, [janeId]);
    const acme = await getMeetings(owner, { companyId: acmeId }, now);
    assert.deepEqual(
      acme.upcoming.map((meeting) => meeting.subject),
      ["Meeting m1", "Meeting s1", "Meeting shared-meeting"],
    );

    await setCalendarForCrm(owner, calendars.get("side-default")!.id, false);
    assert.deepEqual((await eventsFor(owner.userId)).get("s1")!.contact_ids, []);
  });

  it("hides calendars on the calendar page and stops fetching calendars nobody uses", async () => {
    const calendars = await calendarRows(owner.userId);
    const range = { start: new Date(now - 7 * DAY), end: new Date(now + 7 * DAY) };
    const before = await listCalendarItems(owner, range);
    assert.equal(before.length, 6);
    const s1 = before.find((item) => item.subject === "Meeting s1")!;
    assert.equal(s1.showAs, "tentative");
    assert.equal(s1.attendees[0].contactId, janeId);
    assert.equal(s1.attendees[0].response, "accepted");

    const hidden = await setCalendarVisible(owner, calendars.get("side-team")!.id, false);
    assert.equal(hidden.needsSync, false);
    const after = await listCalendarItems(owner, range);
    assert.equal(after.length, 5);
    assert.ok(!after.some((item) => item.subject === "Meeting t1"));

    const calls: Call[] = [];
    const result = await syncCalendar(owner, { fetchImpl: graph(mailboxes, calls), now });
    assert.equal(result.error, undefined);
    assert.ok(!calls.some((call) => call.url.includes("/side-team/")));
    assert.ok((await eventsFor(owner.userId)).has("t1"));

    await assert.rejects(setCalendarVisible(owner, "not-a-uuid", true), /isn't connected/);
    const stranger = await createUser("stranger@orbit-sync.test", "Stranger");
    await assert.rejects(setCalendarVisible(stranger, calendars.get("side-team")!.id, true), /isn't connected/);

    await getAdminPool().query("update crm.calendars set last_synced_at = null where id = $1", [
      calendars.get("side-team")!.id,
    ]);
    const shown = await setCalendarVisible(owner, calendars.get("side-team")!.id, true);
    assert.equal(shown.needsSync, true);
  });

  it("removes calendars that disappear from the account", async () => {
    const trimmed = {
      ...mailboxes,
      "acct-access": {
        ...mailboxes["acct-access"],
        calendars: mailboxes["acct-access"].calendars.filter((calendar) => calendar.id !== "side-team"),
      },
    };
    await syncCalendar(owner, { fetchImpl: graph(trimmed, []), now });
    const calendars = await calendarRows(owner.userId);
    assert.equal(calendars.has("side-team"), false);
    assert.equal((await eventsFor(owner.userId)).has("t1"), false);
  });

  it("creates a contact from an attendee of any calendar's event", async () => {
    const items = await listCalendarItems(owner, { start: new Date(now - 7 * DAY), end: new Date(now + 7 * DAY) });
    const shared = items.find((item) => item.subject === "Meeting shared-meeting-copy")!;
    const raj = shared.attendees.find((person) => person.email === "raj@acme.com")!;
    assert.equal(raj.contactId, null);
    assert.equal(raj.internal, false);
    assert.equal(shared.organizer?.email, "boss@orbit-multi.test");
    await assert.rejects(createContactFromEvent(owner, shared.id, "nobody@else.io"), /isn't in this meeting/);
    const created = await createContactFromEvent(owner, shared.id, "raj@acme.com");
    assert.equal(created.created, true);
    const refreshed = await listCalendarItems(owner, {
      start: new Date(now - 7 * DAY),
      end: new Date(now + 7 * DAY),
    });
    const again = refreshed.find((item) => item.id === shared.id)!;
    assert.equal(again.attendees.find((person) => person.email === "raj@acme.com")!.contactId, created.contactId);
    const stranger = await createUser("other@orbit-sync.test", "Other");
    await assert.rejects(createContactFromEvent(stranger, shared.id, "raj@acme.com"), /isn't in your calendar/);
  });

  it("resumes calendars it ran out of time for on the next run", async () => {
    await getAdminPool().query("update crm.calendars set last_attempt_at = now() - interval '1 hour' where user_id = $1", [
      owner.userId,
    ]);
    const first: Call[] = [];
    const partial = await syncCalendar(owner, {
      fetchImpl: graph(mailboxes, first, 700),
      now,
      deadline: Date.now() + 5_600,
    });
    assert.equal(partial.complete, false);
    const firstViews = first.filter((call) => call.url.includes("/calendarView"));
    assert.equal(firstViews.length, 1);

    await resetGates();
    const second: Call[] = [];
    await syncCalendar(owner, { fetchImpl: graph(mailboxes, second), now });
    const order = second.filter((call) => call.url.includes("/calendarView")).map((call) => call.url);
    assert.notEqual(order[0], firstViews[0].url);
    assert.ok(order.includes(firstViews[0].url));
  });

  it("keeps calendars and accounts private to the owner", async () => {
    const teammate = await createUser("teammate@orbit-sync.test", "Teammate");
    await getAdminPool().query(
      "insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [owner.workspaceId, teammate.userId],
    );
    for (const table of ["calendar_accounts", "calendars", "calendar_events"]) {
      const theirs = await queryAsUser<{ total: number }>(
        teammate.userId,
        `select count(*)::int as total from crm.${table}`,
      );
      assert.equal(theirs[0].total, 0, table);
      const mine = await queryAsUser<{ total: number }>(owner.userId, `select count(*)::int as total from crm.${table}`);
      assert.ok(mine[0].total > 0, table);
    }
    await assert.rejects(
      queryAsUser(
        teammate.userId,
        `insert into crm.calendars (workspace_id, user_id, account_id, provider_calendar_id, name, color)
         values ($1, $2, $3, 'sneaky', 'Sneaky', '#ffffff')`,
        [owner.workspaceId, teammate.userId, accountId],
      ),
      /row-level security/,
    );
    const removed = await queryAsUser<{ id: string }>(teammate.userId, "delete from crm.calendars returning id");
    assert.equal(removed.length, 0);
    const agent = await getAdminPool().query<{ privilege: boolean }>(
      "select has_table_privilege('crm_agent', 'crm.calendar_accounts', 'select') as privilege",
    );
    assert.equal(agent.rows[0].privilege, false);
    await getAdminPool().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [
      owner.workspaceId,
      teammate.userId,
    ]);
  });

  it("syncs calendar-only users from the scheduler", async () => {
    const solo = await createUser("solo@orbit-solo.test", "Solo");
    await connectCalendarAccount(
      solo,
      { origin: "https://orbit.test", code: "code" },
      oauthStub([], { mail: "solo@elsewhere.test", upn: "solo@elsewhere.test", name: "Solo" }),
    );
    const targets = await backgroundTargets();
    const target = targets.find((item) => item.actor.userId === solo.userId);
    assert.ok(target);
    assert.equal(target.mailbox, false);
    assert.equal(target.calendarAccounts, true);
    const step = DEFAULT_STEPS.find((item) => item.name === "calendar")!;
    assert.equal(step.applies({ ...target, granola: null }), true);
    assert.equal(DEFAULT_STEPS.find((item) => item.name === "mail")!.applies({ ...target, granola: null }), false);
    const result = await syncCalendar(solo, {
      fetchImpl: graph(
        { "acct-access": { calendars: [{ id: "solo-cal", name: "Calendar", isDefaultCalendar: true }], events: {} } },
        [],
      ),
      now,
    });
    assert.equal(result.ran, true);
    assert.equal(result.error, undefined);
  });

  it("adopts the migrated default calendar without losing its events", async () => {
    const legacy = await createUser("legacy@orbit-adopt.test", "Legacy");
    await saveMailbox(legacy, {
      email: "legacy@orbit-adopt.test",
      refreshToken: "legacy-refresh",
      accessToken: "legacy-access",
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const connection = await getAdminPool().query<{ id: string }>(
      "select id from crm.mailbox_connections where user_id = $1",
      [legacy.userId],
    );
    const placeholder = await getAdminPool().query<{ id: string }>(
      `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color,
                                  is_default, use_for_crm, is_visible)
       values ($1, $2, $3, '__default__', 'Calendar', '#4f9be8', true, true, false)
       returning id`,
      [legacy.workspaceId, legacy.userId, connection.rows[0].id],
    );
    const old = await getAdminPool().query<{ id: string }>(
      `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id,
                                        starts_at, ends_at)
       values ($1, $2, $3, $4, 'kept', $5, $6) returning id`,
      [
        legacy.workspaceId,
        placeholder.rows[0].id,
        connection.rows[0].id,
        legacy.userId,
        new Date(now + DAY).toISOString(),
        new Date(now + DAY + HOUR).toISOString(),
      ],
    );
    const result = await syncCalendar(legacy, {
      fetchImpl: graph(
        {
          "legacy-access": {
            calendars: [{ id: "real-default", name: "Calendar", isDefaultCalendar: true }],
            events: { "real-default": [event("kept", now + DAY), event("fresh", now + 2 * DAY)] },
          },
        },
        [],
      ),
      now,
    });
    assert.equal(result.error, undefined);
    const calendars = await calendarRows(legacy.userId);
    assert.deepEqual([...calendars.keys()], ["real-default"]);
    assert.equal(calendars.get("real-default")!.id, placeholder.rows[0].id);
    assert.equal(calendars.get("real-default")!.is_visible, false);
    const events = await eventsFor(legacy.userId);
    assert.equal(events.get("kept")!.id, old.rows[0].id);
    assert.ok(events.has("fresh"));
  });

  it("disconnects an extra account with its calendars and events", async () => {
    await disconnectCalendarAccount(owner, accountId);
    const calendars = await calendarRows(owner.userId);
    assert.deepEqual([...calendars.keys()], ["main-birthdays", "main-default"]);
    const events = await eventsFor(owner.userId);
    assert.ok(![...events.values()].some((row) => row.account_id === accountId));
    await assert.rejects(disconnectCalendarAccount(owner, accountId), /isn't connected/);
  });
});
