import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { bookSlot } from "@/lib/booking/book";
import { getBookingPage, getBookingSetup, saveBookingPage } from "@/lib/booking/pages";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/booking/rules";
import { storeGrantedScopes, syncCalendar } from "@/lib/crm/calendar";
import { disconnectCalendarAccount } from "@/lib/crm/calendar-accounts";
import { listCalendarGroups, listCalendarItems } from "@/lib/crm/calendars";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import { chooseHoldProblem, domainScore, listHoldCalendars, setHoldCalendar } from "@/lib/crm/invite-senders";
import {
  bookingSenderGone,
  cancelInvite,
  createInvite,
  getInviteSetup,
  rescheduleInvite,
  respondToInvite,
  saveMeetingLink,
} from "@/lib/crm/invites";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { buildItip, buildItipMime, readItipReply } from "@/lib/ical/itip";
import { parseIcs } from "@/lib/ical/parse";
import { removeIdentity } from "@/lib/mail/identities";
import { applyInviteReplies, readInviteReplies } from "@/lib/mail/invite-replies";
import { listAddressHomes, setAddressHome } from "@/lib/mail/routing";
import type { GraphEvent } from "@/lib/microsoft/calendar";
import { createUser, resetDatabase } from "./helpers";

const NOW = Date.UTC(2026, 9, 15, 9, 0);
const WRITE_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Send offline_access";
const READ_SCOPES = "https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Mail.Send offline_access";
const MAIN = "mark@geteclipse.co";
const CONSULTING = "mark@markridgeon.com";
const ZEUS = "mark@zeusvoice.com";
const NEO = "mark@ridgeon.me";
const JANE = "jane@acme-senders.test";

type Call = { url: string; method: string; auth: string; body: unknown };
type Sent = { from: string; to: string[]; raw: string };

function json(body: unknown, status = 200) {
  return new Response(status === 202 || status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function utc(iso: string) {
  return { dateTime: iso.replace("Z", "").replace(/\.\d{3}$/, ".0000000"), timeZone: "UTC" };
}

function graph(
  calls: Call[],
  options: { scope?: (refresh: string) => string; events?: () => GraphEvent[]; calendars?: () => unknown[]; patchStatus?: number } = {},
) {
  let created = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    } else if (body instanceof URLSearchParams) body = Object.fromEntries(body.entries());
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization") ?? "", body });
    if (parsed.hostname === "login.microsoftonline.com") {
      const refresh = String((body as Record<string, string>).refresh_token ?? "");
      return json({ access_token: `token-for-${refresh}`, expires_in: 3600, scope: options.scope?.(refresh) ?? WRITE_SCOPES });
    }
    if (init?.method === "DELETE") return json(null, 204);
    if (parsed.pathname.endsWith("/cancel") || parsed.pathname.endsWith("/sendMail")) return json(null, 202);
    if (/\/(accept|tentativelyAccept|decline)$/.test(parsed.pathname)) return json(null, 202);
    if (init?.method === "POST" && parsed.pathname.endsWith("/events")) {
      created += 1;
      const draft = body as { subject: string; attendees: { emailAddress: { address: string; name?: string } }[] };
      return json(
        {
          id: `evt-${created}`,
          iCalUId: `ical-${created}`,
          subject: draft.subject,
          start: utc("2026-10-20T13:00:00.000Z"),
          end: utc("2026-10-20T13:30:00.000Z"),
          organizer: { emailAddress: { address: "graph@organiser.test" } },
          attendees: draft.attendees.map((attendee) => ({ type: "required", status: { response: "none" }, emailAddress: attendee.emailAddress })),
          showAs: "busy",
          responseStatus: { response: "organizer" },
        },
        201,
      );
    }
    if (init?.method === "PATCH" && options.patchStatus) {
      return json({ error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } }, options.patchStatus);
    }
    if (init?.method === "PATCH") {
      const patch = body as Record<string, unknown>;
      return json({ id: parsed.pathname.split("/").pop(), start: patch.start, end: patch.end, attendees: [] });
    }
    if (parsed.pathname.endsWith("/me/calendars")) return json({ value: options.calendars?.() ?? [] });
    if (parsed.pathname.includes("/calendarView")) return json({ value: options.events?.() ?? [] });
    return json({ error: { code: "NotFound", message: "Unexpected call" } }, 404);
  }) as typeof fetch;
}

function graphWrites(calls: Call[]) {
  return calls.filter((call) => new URL(call.url).hostname === "graph.microsoft.com" && call.method !== "GET");
}

function smtp(sent: Sent[], fail?: string) {
  return async (_identity: unknown, message: Sent) => {
    if (fail) throw new Error(fail);
    sent.push(message);
  };
}

const quiet = async () => undefined;

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

function calendarPart(raw: string) {
  const match = /Content-Type: text\/calendar; charset=utf-8; method=(\w+)\r?\n(?:Content-Transfer-Encoding: (\S+)\r?\n)?\r?\n([\s\S]*?)\r?\n--/i.exec(raw);
  assert.ok(match, "the email carries a text/calendar part");
  const [, method, encoding, body] = match;
  const text =
    encoding?.toLowerCase() === "base64"
      ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
      : encoding?.toLowerCase() === "quoted-printable"
        ? body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        : body;
  return { method, text: text.replace(/\r?\n[ \t]/g, "") };
}

function replyFor(uid: string, partstat: string, options: { organizer?: string | null; attendee?: string; sequence?: number | null } = {}) {
  const organizer = options.organizer === undefined ? NEO : options.organizer;
  return [
    "BEGIN:VCALENDAR",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    options.sequence === null ? null : `SEQUENCE:${options.sequence ?? 0}`,
    organizer ? `ORGANIZER:mailto:${organizer}` : null,
    `ATTENDEE;PARTSTAT=${partstat}:mailto:${options.attendee ?? JANE}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    title: "Strategy call",
    startLocal: "2026-10-20T14:00",
    durationMinutes: 30,
    attendees: [{ email: JANE, name: "Jane Doe" }],
    notes: "Agenda; pricing, terms",
    includeMeetingLink: true,
    ...overrides,
  };
}

before(async () => {
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("iCalendar invites", () => {
  const event = {
    method: "REQUEST" as const,
    uid: "orbit-abc@ridgeon.me",
    sequence: 0,
    organizer: { email: NEO, name: "Mark Ridgeon" },
    guests: [{ email: JANE, name: "Doe, Jane" }],
    subject: "Strategy; pricing, terms and a long title that needs folding over more than one line",
    start: new Date("2026-10-20T13:00:00.000Z"),
    end: new Date("2026-10-20T13:30:00.000Z"),
    notes: "Line one\nLine two",
    link: "https://whereby.com/mark",
    stamp: new Date(NOW),
  };

  it("builds a valid REQUEST with UID, SEQUENCE, ORGANIZER and ATTENDEE", () => {
    const text = buildItip(event);
    assert.ok(text.split("\r\n").every((line) => Buffer.byteLength(line, "utf8") <= 75));
    const [calendar] = parseIcs(text);
    assert.equal(calendar.name, "VCALENDAR");
    const property = (component: typeof calendar, name: string) => component.properties.find((item) => item.name === name);
    assert.equal(property(calendar, "METHOD")?.value, "REQUEST");
    assert.equal(property(calendar, "VERSION")?.value, "2.0");
    const vevent = calendar.components[0];
    assert.equal(vevent.name, "VEVENT");
    assert.equal(property(vevent, "UID")?.value, "orbit-abc@ridgeon.me");
    assert.equal(property(vevent, "SEQUENCE")?.value, "0");
    assert.equal(property(vevent, "DTSTART")?.value, "20261020T130000Z");
    assert.equal(property(vevent, "DTEND")?.value, "20261020T133000Z");
    assert.equal(property(vevent, "DTSTAMP")?.value, "20261015T090000Z");
    assert.equal(property(vevent, "SUMMARY")?.value, "Strategy\\; pricing\\, terms and a long title that needs folding over more than one line");
    assert.equal(property(vevent, "DESCRIPTION")?.value, "Line one\\nLine two\\n\\nJoin: https://whereby.com/mark");
    assert.equal(property(vevent, "ORGANIZER")?.value, `mailto:${NEO}`);
    assert.deepEqual(property(vevent, "ORGANIZER")?.params.CN, ["Mark Ridgeon"]);
    const attendee = property(vevent, "ATTENDEE")!;
    assert.equal(attendee.value, `mailto:${JANE}`);
    assert.deepEqual(attendee.params.CN, ["Doe, Jane"]);
    assert.deepEqual(attendee.params.PARTSTAT, ["NEEDS-ACTION"]);
    assert.deepEqual(attendee.params.RSVP, ["TRUE"]);
    assert.equal(property(vevent, "STATUS")?.value, "CONFIRMED");
  });

  it("builds a CANCEL and an email with plain text, HTML and the calendar part", async () => {
    const cancel = buildItip({ ...event, method: "CANCEL", sequence: 2 });
    assert.match(cancel, /METHOD:CANCEL/);
    assert.match(cancel, /SEQUENCE:2/);
    assert.match(cancel, /STATUS:CANCELLED/);
    const raw = await buildItipMime(event, { kind: "invite", when: "Tue 20 Oct 2026, 14:00 to 14:30 London time" });
    assert.match(raw, /^From: "?Mark Ridgeon"? <mark@ridgeon\.me>/m);
    assert.match(raw, /^Subject: Invitation: Strategy/m);
    assert.match(raw, /Content-Type: text\/plain/);
    assert.match(raw, /Content-Type: text\/html/);
    assert.match(raw, /invite\.ics/);
    const part = calendarPart(raw);
    assert.equal(part.method, "REQUEST");
    assert.match(part.text, /UID:orbit-abc@ridgeon\.me/);
  });

  it("reads REPLY responses and ignores other methods", () => {
    const reply = [
      "BEGIN:VCALENDAR",
      "METHOD:REPLY",
      "BEGIN:VEVENT",
      "UID:orbit-abc@ridgeon.me",
      "SEQUENCE:1",
      `ATTENDEE;PARTSTAT=ACCEPTED;CN=Jane:mailto:${JANE.toUpperCase()}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    assert.deepEqual(readItipReply(reply), { uid: "orbit-abc@ridgeon.me", sequence: 1, organizer: null, responses: [{ email: JANE, response: "accepted" }] });
    assert.equal(readItipReply(reply.replace("SEQUENCE:1\r\n", ""))?.sequence, null);
    assert.equal(readItipReply(reply.replace("SEQUENCE:1", `ORGANIZER:mailto:${NEO.toUpperCase()}`))?.organizer, NEO);
    assert.equal(readItipReply(buildItip(event)), null);
    assert.equal(readItipReply("not a calendar"), null);
  });

  it("matches a hold calendar by domain", () => {
    assert.ok(domainScore(NEO, CONSULTING) > domainScore(NEO, ZEUS));
    assert.equal(domainScore(NEO, ZEUS), 0);
    assert.equal(domainScore(NEO, MAIN), 0);
    assert.equal(domainScore("a@same.test", "b@same.test"), 1000);
  });
});

describe("choosing who sends an invite", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;
  let connectionId: string;
  let consultingId: string;
  let zeusId: string;
  let identityId: string;
  let consultingCalendar: string;
  let mainCalendar: string;

  async function account(email: string, refresh: string, providerCalendarId: string, write: boolean | null = true) {
    const admin = getAdminPool();
    const row = await admin.query<{ id: string }>(
      `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, access_token, access_token_expires_at, can_send, calendar_write)
       values ($1, $2, 'microsoft', $3, 'connected', $4, $5, $6, true, $7) returning id`,
      [eclipse.workspaceId, eclipse.userId, email, encryptSecret(refresh), encryptSecret(`cached-${refresh}`), new Date(Date.now() + 3_600_000).toISOString(), write],
    );
    const calendar = await admin.query<{ id: string }>(
      `insert into crm.calendars (workspace_id, user_id, account_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
       values ($1, $2, $3, $4, 'Calendar', '#4f9be8', true, true, false, true) returning id`,
      [eclipse.workspaceId, eclipse.userId, row.rows[0].id, providerCalendarId],
    );
    return { id: row.rows[0].id, calendarId: calendar.rows[0].id };
  }

  beforeEach(async () => {
    await resetDatabase();
    const admin = getAdminPool();
    eclipse = await createUser(MAIN, "Mark Ridgeon");
    await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [eclipse.workspaceId]);
    eclipse = { ...eclipse, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon", brandStart: "blank" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    await saveMailbox(eclipse, {
      email: MAIN,
      refreshToken: "main-refresh",
      accessToken: "main-access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    connectionId = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [eclipse.userId])).rows[0].id;
    await withActor(eclipse, (db) => storeGrantedScopes(db, eclipse, connectionId, WRITE_SCOPES));
    mainCalendar = (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
         values ($1, $2, $3, 'cal-main', 'Calendar', '#4f9be8', true, true, true, true) returning id`,
        [eclipse.workspaceId, eclipse.userId, connectionId],
      )
    ).rows[0].id;
    const consulting = await account(CONSULTING, "mr-refresh", "cal-mr");
    consultingId = consulting.id;
    consultingCalendar = consulting.calendarId;
    zeusId = (await account(ZEUS, "zv-refresh", "cal-zv")).id;
    const source = await admin.query<{ id: string }>(
      "insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id",
      [eclipse.workspaceId, eclipse.userId, connectionId, MAIN],
    );
    identityId = (
      await admin.query<{ id: string }>(
        `insert into crm.send_identities (workspace_id, user_id, source_id, email, display_name, smtp_host, smtp_port, username, password_cipher)
         values ($1, $2, $3, $4, 'Mark Ridgeon', 'smtp0001.neo.space', 465, $4, $5) returning id`,
        [eclipse.workspaceId, eclipse.userId, source.rows[0].id, NEO, encryptSecret("neo-password")],
      )
    ).rows[0].id;
    await saveMeetingLink(eclipse, "https://whereby.com/mark");
    for (const actor of [eclipse, ridgeon]) {
      await createContact(actor, { firstName: "Jane", lastName: "Doe", email: JANE });
    }
  });

  it("lists every address that can send and defaults to the main mailbox", async () => {
    const setup = await getInviteSetup(eclipse);
    assert.deepEqual(
      setup.senders.map((sender) => [sender.address, sender.kind, sender.primary, sender.problem]),
      [
        [MAIN, "microsoft", true, null],
        [CONSULTING, "microsoft", false, null],
        [ZEUS, "microsoft", false, null],
        [NEO, "smtp", false, null],
      ],
    );
    assert.equal(setup.defaultFrom, MAIN);
    assert.equal((await getInviteSetup(ridgeon)).defaultFrom, MAIN);
    assert.ok(setup.ownEmails.includes(NEO));
  });

  it("sends from a calendar account with that account's token and calendar", async () => {
    const calls: Call[] = [];
    const result = await createInvite(ridgeon, invite({ from: CONSULTING }), { fetchImpl: graph(calls), now: NOW });
    assert.equal(result.from, CONSULTING);
    assert.equal(result.warning, null);
    assert.equal(result.loggedOn, 1);
    const writes = graphWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, "https://graph.microsoft.com/v1.0/me/calendars/cal-mr/events");
    assert.equal(writes[0].auth, "Bearer cached-mr-refresh");
    assert.ok(!calls.some((call) => call.auth.includes("main")));
    const saved = await getAdminPool().query<{ account_id: string | null; connection_id: string | null; calendar_id: string; contact_ids: string[]; organizer: { email: string } }>(
      "select account_id, connection_id, calendar_id, contact_ids, organizer from crm.calendar_events where id = $1",
      [result.eventId],
    );
    assert.equal(saved.rows[0].account_id, consultingId);
    assert.equal(saved.rows[0].connection_id, null);
    assert.equal(saved.rows[0].calendar_id, consultingCalendar);
    assert.equal(saved.rows[0].contact_ids.length, 1);
    const write = await getAdminPool().query<{ calendar_write: boolean | null }>("select calendar_write from crm.calendar_accounts where id = $1", [consultingId]);
    assert.equal(write.rows[0].calendar_write, true);
    const activity = await getAdminPool().query<{ metadata: { from: string } }>(
      "select metadata from crm.activities where workspace_id = $1 and type = 'meeting'",
      [ridgeon.workspaceId],
    );
    assert.equal(activity.rows[0].metadata.from, CONSULTING);
  });

  it("remembers the last address per workspace, and an address's home workspace wins", async () => {
    await createInvite(ridgeon, invite({ from: ZEUS }), { fetchImpl: graph([]), now: NOW });
    assert.equal((await getInviteSetup(ridgeon)).defaultFrom, ZEUS);
    assert.equal((await getInviteSetup(eclipse)).defaultFrom, MAIN);
    await setAddressHome(eclipse, NEO, ridgeon.workspaceId);
    assert.equal((await getInviteSetup(ridgeon)).defaultFrom, NEO);
    assert.equal((await getInviteSetup(eclipse)).defaultFrom, MAIN);
    const calls: Call[] = [];
    const sent: Sent[] = [];
    const result = await createInvite(ridgeon, invite(), { fetchImpl: graph(calls), now: NOW, smtp: smtp(sent), saveSent: quiet });
    assert.equal(result.from, NEO);
    assert.equal(sent.length, 1);
  });

  it("emails an iTIP invite from an SMTP address and holds the time without attendees", async () => {
    const calls: Call[] = [];
    const sent: Sent[] = [];
    const saved: string[] = [];
    const result = await createInvite(ridgeon, invite({ from: NEO }), {
      fetchImpl: graph(calls),
      now: NOW,
      smtp: smtp(sent),
      saveSent: async (_identity, raw) => {
        saved.push(raw);
      },
    });
    assert.equal(result.from, NEO);
    const writes = graphWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, "https://graph.microsoft.com/v1.0/me/calendars/cal-mr/events");
    assert.equal(writes[0].auth, "Bearer cached-mr-refresh");
    const hold = writes[0].body as { attendees: unknown[]; showAs: string; responseRequested: boolean; subject: string };
    assert.deepEqual(hold.attendees, []);
    assert.equal(hold.showAs, "busy");
    assert.equal(hold.responseRequested, false);
    assert.equal(hold.subject, "Strategy call");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, NEO);
    assert.deepEqual(sent[0].to, [JANE]);
    assert.equal(saved.length, 1);
    const part = calendarPart(sent[0].raw);
    assert.equal(part.method, "REQUEST");
    assert.match(part.text, /METHOD:REQUEST/);
    assert.match(part.text, /UID:orbit-[0-9a-f-]+@ridgeon\.me/);
    assert.match(part.text, /SEQUENCE:0/);
    assert.match(part.text, /ORGANIZER;CN=Mark Ridgeon:mailto:mark@ridgeon\.me/);
    assert.match(part.text, /ATTENDEE;CN=Jane Doe;.*PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:jane@acme-senders\.test/);
    assert.match(part.text, /DTSTART:20261020T130000Z/);
    assert.match(part.text, /LOCATION:https:\/\/whereby\.com\/mark/);
    assert.match(sent[0].raw, /Mark Ridgeon invited you to Strategy call\./);
    const row = await getAdminPool().query<{
      invite_identity_id: string;
      invite_uid: string;
      invite_sequence: number;
      organizer: { email: string };
      attendees: { email: string; response: string }[];
      account_id: string;
      created_by_orbit: boolean;
    }>("select * from crm.calendar_events where id = $1", [result.eventId]);
    assert.equal(row.rows[0].invite_identity_id, identityId);
    assert.equal(row.rows[0].invite_sequence, 0);
    assert.equal(row.rows[0].organizer.email, NEO);
    assert.deepEqual(row.rows[0].attendees.map((person) => [person.email, person.response]), [[JANE, "none"]]);
    assert.equal(row.rows[0].account_id, consultingId);
    const items = await listCalendarItems(ridgeon, { start: new Date("2026-10-20T00:00:00Z"), end: new Date("2026-10-21T00:00:00Z") }, NOW);
    const item = items.find((entry) => entry.id === result.eventId)!;
    assert.equal(item.organisedByMe, true);
    assert.equal(item.canCancel, true);
    assert.equal(item.attendees[0].email, JANE);

    const syncCalls: Call[] = [];
    await syncCalendar(eclipse, {
      fetchImpl: graph(syncCalls, {
        calendars: () => [{ id: "cal-mr", name: "Calendar", isDefaultCalendar: true, canEdit: true }],
        events: () => [
          {
            id: result.providerEventId,
            subject: "Strategy call",
            start: utc("2026-10-20T13:00:00.000Z"),
            end: utc("2026-10-20T13:30:00.000Z"),
            organizer: { emailAddress: { address: CONSULTING } },
            attendees: [],
            showAs: "busy",
            responseStatus: { response: "organizer" },
          },
        ],
      }),
      force: true,
      now: NOW,
      accountId: consultingId,
    });
    const synced = await getAdminPool().query<{ attendees: { email: string }[]; organizer: { email: string } }>(
      "select attendees, organizer from crm.calendar_events where id = $1",
      [result.eventId],
    );
    assert.equal(synced.rows[0].organizer.email, NEO);
    assert.equal(synced.rows[0].attendees[0].email, JANE);

    const reply = replyFor(row.rows[0].invite_uid, "ACCEPTED");
    assert.equal(await applyInviteReplies(eclipse, { id: identityId, email: NEO }, [{ text: "junk", senders: [JANE] }, { text: reply, senders: [JANE] }]), 1);
    const answered = await getAdminPool().query<{ attendees: { email: string; response: string }[] }>(
      "select attendees from crm.calendar_events where id = $1",
      [result.eventId],
    );
    assert.equal(answered.rows[0].attendees[0].response, "accepted");
    const declined = reply.replace("ACCEPTED", "DECLINED");
    const cursors: unknown[] = [];
    const reader = async (identity: { email: string }, options: { since: Date; cursor: unknown }) => {
      assert.equal(identity.email, NEO);
      assert.ok(options.since.getTime() <= Date.now());
      cursors.push(options.cursor);
      return { messages: cursors.length === 1 ? [{ text: declined, senders: [JANE] }] : [], cursor: { uidValidity: "77", lastUid: 40 + cursors.length } };
    };
    assert.equal(await readInviteReplies(eclipse, { now: NOW, reader }), 1);
    assert.equal(await readInviteReplies(eclipse, { now: NOW, reader }), 0);
    assert.deepEqual(cursors, [null, { uidValidity: "77", lastUid: 41 }]);
    const cursor = await getAdminPool().query<{ reply_uid_validity: string; reply_last_uid: string }>(
      "select reply_uid_validity, reply_last_uid from crm.send_identities where id = $1",
      [identityId],
    );
    assert.deepEqual(cursor.rows[0], { reply_uid_validity: "77", reply_last_uid: "42" });
  });

  it("moves and cancels an SMTP invite with a higher SEQUENCE and updates the hold", async () => {
    const created = await createInvite(ridgeon, invite({ from: NEO }), { fetchImpl: graph([]), now: NOW, smtp: smtp([]), saveSent: quiet });
    const calls: Call[] = [];
    const sent: Sent[] = [];
    const moved = await rescheduleInvite(
      ridgeon,
      { eventId: created.eventId, startLocal: "2026-10-21T10:00", message: "Clash" },
      { fetchImpl: graph(calls), now: NOW, smtp: smtp(sent), saveSent: quiet },
    );
    assert.equal(moved.startsAt, "2026-10-21T09:00:00.000Z");
    const patch = graphWrites(calls)[0];
    assert.equal(patch.method, "PATCH");
    assert.equal(patch.url, `https://graph.microsoft.com/v1.0/me/events/${created.providerEventId}`);
    assert.equal(patch.auth, "Bearer cached-mr-refresh");
    assert.equal((patch.body as { body?: unknown }).body, undefined);
    const update = calendarPart(sent[0].raw);
    assert.equal(update.method, "REQUEST");
    assert.match(update.text, /SEQUENCE:1/);
    assert.match(update.text, /DTSTART:20261021T090000Z/);
    assert.match(update.text, /DESCRIPTION:Agenda\\; pricing\\, terms/);
    assert.match(sent[0].raw, /Subject: Updated invitation: Strategy call/);
    assert.match(sent[0].raw, /Clash/);

    const cancelCalls: Call[] = [];
    const cancelSent: Sent[] = [];
    const cancelled = await cancelInvite(ridgeon, created.eventId!, "Sorry", {
      fetchImpl: graph(cancelCalls),
      now: NOW,
      smtp: smtp(cancelSent),
      saveSent: quiet,
    });
    assert.equal(cancelled.warning, null);
    const removal = graphWrites(cancelCalls)[0];
    assert.equal(removal.method, "DELETE");
    assert.equal(removal.auth, "Bearer cached-mr-refresh");
    const cancel = calendarPart(cancelSent[0].raw);
    assert.equal(cancel.method, "CANCEL");
    assert.match(cancel.text, /SEQUENCE:2/);
    assert.match(cancel.text, /STATUS:CANCELLED/);
    const row = await getAdminPool().query<{ is_cancelled: boolean; invite_sequence: number }>(
      "select is_cancelled, invite_sequence from crm.calendar_events where id = $1",
      [created.eventId],
    );
    assert.deepEqual(row.rows[0], { is_cancelled: true, invite_sequence: 2 });
  });

  it("moves, cancels and answers Microsoft meetings with the organising account, not the main one", async () => {
    const created = await createInvite(ridgeon, invite({ from: CONSULTING }), { fetchImpl: graph([]), now: NOW });
    const calls: Call[] = [];
    await rescheduleInvite(ridgeon, { eventId: created.eventId, startLocal: "2026-10-21T10:00" }, { fetchImpl: graph(calls), now: NOW });
    await cancelInvite(ridgeon, created.eventId!, "", { fetchImpl: graph(calls), now: NOW });
    const writes = graphWrites(calls);
    assert.deepEqual(writes.map((call) => [call.method, call.auth]), [
      ["PATCH", "Bearer cached-mr-refresh"],
      ["POST", "Bearer cached-mr-refresh"],
    ]);
    assert.match(writes[1].url, /\/cancel$/);

    const invited = await getAdminPool().query<{ id: string }>(
      `insert into crm.calendar_events (workspace_id, calendar_id, account_id, user_id, provider_event_id, subject, starts_at, ends_at, organizer, attendees, response_status)
       values ($1, $2, $3, $4, 'their-evt', 'Their meeting', '2026-10-22T10:00:00Z', '2026-10-22T10:30:00Z', $5::jsonb, $6::jsonb, 'none') returning id`,
      [
        eclipse.workspaceId,
        consultingCalendar,
        consultingId,
        eclipse.userId,
        JSON.stringify({ email: JANE, name: "Jane" }),
        JSON.stringify([{ email: CONSULTING, name: "Mark", response: "none" }]),
      ],
    );
    const answerCalls: Call[] = [];
    await respondToInvite(ridgeon, { eventId: invited.rows[0].id, response: "accept" }, { fetchImpl: graph(answerCalls), now: NOW });
    const answer = graphWrites(answerCalls)[0];
    assert.match(answer.url, /\/me\/events\/their-evt\/accept$/);
    assert.equal(answer.auth, "Bearer cached-mr-refresh");
  });

  it("never falls back to another address when the chosen one fails", async () => {
    const calls: Call[] = [];
    await rejects(
      () => createInvite(ridgeon, invite({ from: NEO }), { fetchImpl: graph(calls), now: NOW, smtp: smtp([], "535 authentication failed"), saveSent: quiet }),
      { code: "upstream_error", field: "from", message: /mark@ridgeon\.me couldn't send the invite: 535/ },
    );
    assert.deepEqual(graphWrites(calls).map((call) => call.method), ["POST", "DELETE"]);
    assert.ok(graphWrites(calls).every((call) => call.auth === "Bearer cached-mr-refresh"));
    const lastError = await getAdminPool().query<{ last_error: string }>("select last_error from crm.send_identities where id = $1", [identityId]);
    assert.match(lastError.rows[0].last_error, /535/);

    await getAdminPool().query("update crm.calendar_accounts set access_token_expires_at = now() - interval '1 hour' where id = $1", [consultingId]);
    const readOnly: Call[] = [];
    await rejects(
      () => createInvite(ridgeon, invite({ from: CONSULTING }), {
        fetchImpl: graph(readOnly, { scope: (refresh) => (refresh === "mr-refresh" ? READ_SCOPES : WRITE_SCOPES) }),
        now: NOW,
      }),
      { code: "scope_missing", field: "from", message: `Allow invites for ${CONSULTING} in Settings › Calendars first.` },
    );
    assert.equal(graphWrites(readOnly).length, 0);
    const downgraded = await getAdminPool().query<{ calendar_write: boolean | null }>("select calendar_write from crm.calendar_accounts where id = $1", [consultingId]);
    assert.equal(downgraded.rows[0].calendar_write, false);
    const setup = await getInviteSetup(ridgeon);
    const consulting = setup.senders.find((sender) => sender.address === CONSULTING)!;
    assert.equal(consulting.problem, `Allow invites for ${CONSULTING} in Settings › Calendars first.`);
    assert.match(consulting.fixHref!, /purpose=send_account/);

    await getAdminPool().query("update crm.calendar_accounts set status = 'disconnected', refresh_token = null where id = $1", [zeusId]);
    await rejects(() => createInvite(ridgeon, invite({ from: ZEUS }), { fetchImpl: graph([]), now: NOW }), {
      field: "from",
      message: `Reconnect ${ZEUS} in Settings › Calendars to send invites from it.`,
    });
    await rejects(() => createInvite(ridgeon, invite({ from: "someone@else.test" }), { fetchImpl: graph([]), now: NOW }), {
      code: "not_found",
      field: "from",
    });
    const events = await getAdminPool().query("select 1 from crm.calendar_events");
    assert.equal(events.rowCount, 0);
  });

  it("holds SMTP invites in the calendar the person picks", async () => {
    const holds = await listHoldCalendars(eclipse);
    assert.deepEqual(holds.map((hold) => hold.address).sort(), [CONSULTING, MAIN, ZEUS].sort());
    await setHoldCalendar(eclipse, identityId, mainCalendar);
    const calls: Call[] = [];
    await createInvite(ridgeon, invite({ from: NEO }), { fetchImpl: graph(calls), now: NOW, smtp: smtp([]), saveSent: quiet });
    const [hold] = graphWrites(calls);
    assert.equal(hold.url, "https://graph.microsoft.com/v1.0/me/calendars/cal-main/events");
    assert.equal(hold.auth, "Bearer main-access");
    await rejects(() => setHoldCalendar(eclipse, identityId, "6f1c1c55-8d0c-4a43-9a3e-3f3b8ad1e0c1"), { field: "holdCalendarId" });
  });

  it("sends booking page invites from the page's address, defaulting to the main mailbox", async () => {
    const page = {
      slug: "mark",
      enabled: true,
      title: null,
      intro: null,
      durationMinutes: 30,
      bufferMinutes: 0,
      minNoticeMinutes: 0,
      horizonDays: 21,
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      videoUrl: "",
    };
    await createInvite(ridgeon, invite({ from: ZEUS }), { fetchImpl: graph([]), now: NOW });
    await saveBookingPage(eclipse, page);
    assert.equal((await getBookingPage(eclipse)).inviteSender, null);
    const mainCalls: Call[] = [];
    await bookSlot("mark", { start: "2026-10-19T13:00:00.000Z", name: "Ann", email: "ann@booker.test" }, { ip: "203.0.113.90", now: NOW, fetchImpl: graph(mainCalls) });
    const mainPost = graphWrites(mainCalls).find((call) => call.method === "POST")!;
    assert.equal(mainPost.url, "https://graph.microsoft.com/v1.0/me/calendars/cal-main/events");
    assert.equal(mainPost.auth, "Bearer main-access");

    await saveBookingPage(eclipse, { ...page, inviteSender: CONSULTING.toUpperCase() });
    assert.equal((await getBookingPage(eclipse)).inviteSender, CONSULTING);
    const calls: Call[] = [];
    await bookSlot("mark", { start: "2026-10-19T14:00:00.000Z", name: "Bea", email: "bea@booker.test" }, { ip: "203.0.113.91", now: NOW, fetchImpl: graph(calls) });
    const post = graphWrites(calls).find((call) => call.method === "POST")!;
    assert.equal(post.url, "https://graph.microsoft.com/v1.0/me/calendars/cal-mr/events");
    assert.equal(post.auth, "Bearer cached-mr-refresh");
    await rejects(() => saveBookingPage(eclipse, { ...page, inviteSender: "nobody@else.test" }), { field: "inviteSender" });
    await saveBookingPage(eclipse, { ...page, inviteSender: MAIN });
    assert.equal((await getBookingPage(eclipse)).inviteSender, null);
  });

  it("lets the assistant pick From and shows it on the approval card", async () => {
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const args = invite({ from: CONSULTING, startLocal: `${soon}T14:00` });
    const card = describeAction("create_meeting_invite", args, await recordNames(ridgeon, [args], ["create_meeting_invite"]));
    assert.equal(card.lines[0], `From: ${CONSULTING}`);
    await setAddressHome(eclipse, NEO, ridgeon.workspaceId);
    const plain = invite();
    const defaultCard = describeAction("create_meeting_invite", plain, await recordNames(ridgeon, [plain], ["create_meeting_invite"]));
    assert.equal(defaultCard.lines[0], `From: ${NEO}`);
    const calls: Call[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = graph(calls);
    try {
      const output = (await runTool(ridgeon, "create_meeting_invite", args)) as { invite?: { from: string }; error?: string };
      assert.equal(output.error, undefined);
      assert.equal(output.invite?.from, CONSULTING);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(graphWrites(calls)[0].auth, "Bearer cached-mr-refresh");
  });

  const bookingPage = {
    slug: "mark",
    enabled: true,
    title: null,
    intro: null,
    durationMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 21,
    weeklyHours: DEFAULT_WEEKLY_HOURS,
    videoUrl: "",
  };

  async function eventRow(id: string) {
    const row = await getAdminPool().query<{
      provider_event_id: string;
      invite_hold_missing: boolean;
      invite_sequence: number;
      is_cancelled: boolean;
      starts_at: Date;
    }>("select provider_event_id, invite_hold_missing, invite_sequence, is_cancelled, starts_at from crm.calendar_events where id = $1", [id]);
    return row.rows[0];
  }

  it("defaults From to an address homed here even when the home is its own workspace", async () => {
    await getAdminPool().query("update crm.calendar_accounts set workspace_id = $2 where id = $1", [consultingId, ridgeon.workspaceId]);
    const homes = await listAddressHomes(eclipse);
    assert.equal(homes.find((home) => home.address === CONSULTING)?.workspaceId, ridgeon.workspaceId);
    await setAddressHome(eclipse, CONSULTING, ridgeon.workspaceId);
    const rows = await getAdminPool().query("select 1 from crm.mail_address_homes where address = $1", [CONSULTING]);
    assert.equal(rows.rowCount, 0);
    await createInvite(ridgeon, invite({ from: ZEUS }), { fetchImpl: graph([]), now: NOW });
    assert.equal((await getInviteSetup(ridgeon)).defaultFrom, CONSULTING);
    assert.equal((await getInviteSetup(eclipse)).defaultFrom, MAIN);
    await setAddressHome(eclipse, ZEUS, ridgeon.workspaceId);
    assert.equal((await getInviteSetup(ridgeon)).defaultFrom, ZEUS);
  });

  it("treats an account whose calendar access isn't known yet as needing Allow invites until a sync learns it", async () => {
    await getAdminPool().query(
      "update crm.calendar_accounts set calendar_write = null, access_token_expires_at = now() - interval '1 hour' where id = $1",
      [consultingId],
    );
    const setup = await getInviteSetup(ridgeon);
    const consulting = setup.senders.find((sender) => sender.address === CONSULTING)!;
    assert.equal(consulting.problem, `Allow invites for ${CONSULTING} in Settings › Calendars first.`);
    assert.match(consulting.fixHref!, /purpose=send_account&hint=mark%40markridgeon\.com/);
    const neo = setup.senders.find((sender) => sender.address === NEO)!;
    assert.equal(neo.problem, `Allow invites for ${CONSULTING} in Settings › Calendars first.`);
    const calls: Call[] = [];
    await rejects(() => createInvite(ridgeon, invite({ from: CONSULTING }), { fetchImpl: graph(calls), now: NOW }), {
      field: "from",
      message: `Allow invites for ${CONSULTING} in Settings › Calendars first.`,
    });
    assert.equal(graphWrites(calls).length, 0);
    const groups = await listCalendarGroups(eclipse);
    assert.equal(groups.find((group) => group.id === consultingId)?.canInvite, false);

    await syncCalendar(eclipse, {
      fetchImpl: graph([], { calendars: () => [{ id: "cal-mr", name: "Calendar", isDefaultCalendar: true, canEdit: true }] }),
      force: true,
      now: NOW,
      accountId: consultingId,
    });
    const learned = await getAdminPool().query<{ calendar_write: boolean | null }>("select calendar_write from crm.calendar_accounts where id = $1", [consultingId]);
    assert.equal(learned.rows[0].calendar_write, true);
    assert.equal((await getInviteSetup(ridgeon)).senders.find((sender) => sender.address === CONSULTING)?.problem, null);
    assert.equal((await listCalendarGroups(eclipse)).find((group) => group.id === consultingId)?.canInvite, true);

    await getAdminPool().query("update crm.calendar_accounts set calendar_write = false where id = $1", [consultingId]);
    const created = await getAdminPool().query<{ id: string }>(
      `insert into crm.calendar_events (workspace_id, calendar_id, account_id, user_id, provider_event_id, subject, starts_at, ends_at, organizer, attendees, created_by_orbit)
       values ($1, $2, $3, $4, 'mine', 'Mine', '2026-10-22T10:00:00Z', '2026-10-22T10:30:00Z', $5::jsonb, $6::jsonb, true) returning id`,
      [eclipse.workspaceId, consultingCalendar, consultingId, eclipse.userId, JSON.stringify({ email: CONSULTING }), JSON.stringify([{ email: JANE, response: "none" }])],
    );
    const items = await listCalendarItems(eclipse, { start: new Date("2026-10-22T00:00:00Z"), end: new Date("2026-10-23T00:00:00Z") }, NOW);
    assert.equal(items.find((item) => item.id === created.rows[0].id)?.canCancel, false);
  });

  it("asks for a hold calendar instead of using the main one when no domain matches", async () => {
    await getAdminPool().query("update crm.send_identities set email = 'mark@unrelated.org' where id = $1", [identityId]);
    const sender = (await getInviteSetup(ridgeon)).senders.find((item) => item.address === "mark@unrelated.org")!;
    assert.equal(sender.problem, chooseHoldProblem("mark@unrelated.org"));
    assert.equal(sender.fixHref, "/settings/email-templates#sending-addresses");
    await setHoldCalendar(eclipse, identityId, mainCalendar);
    assert.equal((await getInviteSetup(ridgeon)).senders.find((item) => item.address === "mark@unrelated.org")?.problem, null);
  });

  it("keeps an SMTP invite when its hold disappears, and still tells guests when it's moved or cancelled", async () => {
    const created = await createInvite(ridgeon, invite({ from: NEO }), { fetchImpl: graph([]), now: NOW, smtp: smtp([]), saveSent: quiet });
    await syncCalendar(eclipse, {
      fetchImpl: graph([], { calendars: () => [{ id: "cal-mr", name: "Calendar", isDefaultCalendar: true, canEdit: true }], events: () => [] }),
      force: true,
      now: NOW,
      accountId: consultingId,
    });
    const kept = await eventRow(created.eventId!);
    assert.equal(kept.invite_hold_missing, true);

    const calls: Call[] = [];
    const sent: Sent[] = [];
    await rescheduleInvite(ridgeon, { eventId: created.eventId, startLocal: "2026-10-21T10:00" }, { fetchImpl: graph(calls), now: NOW, smtp: smtp(sent), saveSent: quiet });
    assert.deepEqual(graphWrites(calls).map((call) => call.method), ["POST"]);
    assert.deepEqual((graphWrites(calls)[0].body as { attendees: unknown[] }).attendees, []);
    assert.equal(sent.length, 1);
    assert.match(calendarPart(sent[0].raw).text, /SEQUENCE:1/);
    const moved = await eventRow(created.eventId!);
    assert.equal(moved.invite_hold_missing, false);
    assert.equal(moved.provider_event_id, "evt-1");
    assert.equal(moved.invite_sequence, 1);
    assert.equal(moved.is_cancelled, false);

    await getAdminPool().query("update crm.calendar_events set invite_hold_missing = true where id = $1", [created.eventId]);
    const cancelCalls: Call[] = [];
    const cancelSent: Sent[] = [];
    const cancelled = await cancelInvite(ridgeon, created.eventId!, "", { fetchImpl: graph(cancelCalls), now: NOW, smtp: smtp(cancelSent), saveSent: quiet });
    assert.equal(cancelled.warning, null);
    assert.equal(graphWrites(cancelCalls).length, 0);
    assert.equal(calendarPart(cancelSent[0].raw).method, "CANCEL");
    assert.equal((await eventRow(created.eventId!)).is_cancelled, true);
  });

  it("recreates a deleted hold when moving an SMTP invite instead of cancelling it", async () => {
    const created = await createInvite(ridgeon, invite({ from: NEO }), { fetchImpl: graph([]), now: NOW, smtp: smtp([]), saveSent: quiet });
    const calls: Call[] = [];
    const sent: Sent[] = [];
    const moved = await rescheduleInvite(
      ridgeon,
      { eventId: created.eventId, startLocal: "2026-10-21T10:00" },
      { fetchImpl: graph(calls, { patchStatus: 404 }), now: NOW, smtp: smtp(sent), saveSent: quiet },
    );
    assert.equal(moved.startsAt, "2026-10-21T09:00:00.000Z");
    assert.deepEqual(graphWrites(calls).map((call) => call.method), ["PATCH", "POST"]);
    assert.equal(sent.length, 1);
    const row = await eventRow(created.eventId!);
    assert.equal(row.is_cancelled, false);
    assert.equal(row.provider_event_id, "evt-1");
    assert.equal(row.starts_at.toISOString(), "2026-10-21T09:00:00.000Z");
  });

  it("only bumps SEQUENCE when the update is sent", async () => {
    const created = await createInvite(ridgeon, invite({ from: NEO }), { fetchImpl: graph([]), now: NOW, smtp: smtp([]), saveSent: quiet });
    await rejects(
      () => rescheduleInvite(ridgeon, { eventId: created.eventId, startLocal: "2026-10-21T10:00" }, { fetchImpl: graph([]), now: NOW, smtp: smtp([], "421 try later"), saveSent: quiet }),
      { code: "upstream_error", field: "from" },
    );
    assert.equal((await eventRow(created.eventId!)).invite_sequence, 0);
    const sent: Sent[] = [];
    await cancelInvite(ridgeon, created.eventId!, "", { fetchImpl: graph([]), now: NOW, smtp: smtp(sent), saveSent: quiet });
    assert.match(calendarPart(sent[0].raw).text, /SEQUENCE:1/);
    assert.equal((await eventRow(created.eventId!)).invite_sequence, 1);
  });

  it("ignores replies that don't come from the guest or aren't for this organiser", async () => {
    const created = await createInvite(ridgeon, invite({ from: NEO }), { fetchImpl: graph([]), now: NOW, smtp: smtp([]), saveSent: quiet });
    const uid = (await getAdminPool().query<{ invite_uid: string }>("select invite_uid from crm.calendar_events where id = $1", [created.eventId])).rows[0].invite_uid;
    const identity = { id: identityId, email: NEO };
    const response = async () =>
      (await getAdminPool().query<{ attendees: { response: string }[] }>("select attendees from crm.calendar_events where id = $1", [created.eventId])).rows[0]
        .attendees[0].response;
    assert.equal(await applyInviteReplies(eclipse, identity, [{ text: replyFor(uid, "DECLINED"), senders: ["mallory@evil.test"] }]), 0);
    assert.equal(await applyInviteReplies(eclipse, identity, [{ text: replyFor(uid, "DECLINED", { organizer: "someone@else.test" }), senders: [JANE] }]), 0);
    assert.equal(await applyInviteReplies(eclipse, identity, [{ text: replyFor(uid, "DECLINED", { organizer: null }), senders: [JANE] }]), 0);
    assert.equal(
      await applyInviteReplies(eclipse, identity, [{ text: replyFor(uid, "DECLINED", { attendee: "mallory@evil.test" }), senders: ["mallory@evil.test"] }]),
      0,
    );
    assert.equal(await response(), "none");
    await getAdminPool().query("update crm.calendar_events set invite_sequence = 3 where id = $1", [created.eventId]);
    assert.equal(await applyInviteReplies(eclipse, identity, [{ text: replyFor(uid, "ACCEPTED", { sequence: 1 }), senders: [JANE] }]), 0);
    assert.equal(await applyInviteReplies(eclipse, identity, [{ text: replyFor(uid, "ACCEPTED", { sequence: null }), senders: [JANE] }]), 1);
    assert.equal(await response(), "accepted");
  });

  it("won't remove an address with upcoming invites, and forgets it once removed", async () => {
    const created = await createInvite(ridgeon, invite({ from: NEO }), { fetchImpl: graph([]), now: NOW, smtp: smtp([]), saveSent: quiet });
    await saveBookingPage(eclipse, { ...bookingPage, inviteSender: NEO });
    await rejects(() => removeIdentity(eclipse, identityId, NOW), {
      code: "conflict",
      message: `Cancel the upcoming meeting sent from ${NEO} first, so its guests hear about it.`,
    });
    await cancelInvite(ridgeon, created.eventId!, "", { fetchImpl: graph([]), now: NOW, smtp: smtp([]), saveSent: quiet });
    await removeIdentity(eclipse, identityId, NOW);
    assert.equal((await getBookingPage(eclipse)).inviteSender, null);
    const choices = await getAdminPool().query("select 1 from crm.invite_sender_choices where address = $1", [NEO]);
    assert.equal(choices.rowCount, 0);
    const orphan = await getAdminPool().query<{ invite_identity_id: string | null }>("select invite_identity_id from crm.calendar_events where id = $1", [created.eventId]);
    assert.equal(orphan.rows[0].invite_identity_id, null);
    await getAdminPool().query("update crm.calendar_events set is_cancelled = false where id = $1", [created.eventId]);
    await rejects(() => cancelInvite(ridgeon, created.eventId!, "", { fetchImpl: graph([]), now: NOW }), {
      message: /address that sent this invite was removed/,
    });
  });

  it("forgets a disconnected account as the booking page's sender", async () => {
    await saveBookingPage(eclipse, { ...bookingPage, inviteSender: ZEUS });
    await createInvite(ridgeon, invite({ from: ZEUS }), { fetchImpl: graph([]), now: NOW });
    await disconnectCalendarAccount(eclipse, zeusId);
    assert.equal((await getBookingPage(eclipse)).inviteSender, null);
    const choices = await getAdminPool().query("select 1 from crm.invite_sender_choices where address = $1", [ZEUS]);
    assert.equal(choices.rowCount, 0);
  });

  it("defaults booking invites to the address homed in the page's workspace", async () => {
    await saveBookingPage(ridgeon, bookingPage);
    assert.equal((await getBookingSetup(ridgeon)).defaultSender, MAIN);
    await setAddressHome(eclipse, CONSULTING, ridgeon.workspaceId);
    const setup = await getBookingSetup(eclipse);
    assert.equal(setup.defaultSender, CONSULTING);
    await saveBookingPage(eclipse, { ...bookingPage, inviteSender: CONSULTING });
    assert.equal((await getBookingPage(eclipse)).inviteSender, null);
    await saveBookingPage(eclipse, { ...bookingPage, inviteSender: MAIN });
    assert.equal((await getBookingPage(eclipse)).inviteSender, MAIN);
    await saveBookingPage(eclipse, { ...bookingPage, inviteSender: CONSULTING });
    const calls: Call[] = [];
    await bookSlot("mark", { start: "2026-10-19T13:00:00.000Z", name: "Ann", email: "ann@booker.test" }, { ip: "203.0.113.92", now: NOW, fetchImpl: graph(calls) });
    const post = graphWrites(calls).find((call) => call.method === "POST")!;
    assert.equal(post.url, "https://graph.microsoft.com/v1.0/me/calendars/cal-mr/events");
  });

  it("explains a booking whose invite address can't send any more", async () => {
    await saveBookingPage(eclipse, bookingPage);
    await getAdminPool().query("update crm.booking_pages set invite_sender = 'gone@nowhere.test' where user_id = $1", [eclipse.userId]);
    await rejects(
      () => bookSlot("mark", { start: "2026-10-19T13:00:00.000Z", name: "Ann", email: "ann@booker.test" }, { ip: "203.0.113.93", now: NOW, fetchImpl: graph([]) }),
      { code: "unavailable" },
    );
    assert.equal((await getBookingPage(eclipse)).lastError, bookingSenderGone("gone@nowhere.test"));
    await getAdminPool().query("update crm.booking_pages set invite_sender = $2 where user_id = $1", [eclipse.userId, ZEUS]);
    await getAdminPool().query("update crm.calendar_accounts set calendar_write = false where id = $1", [zeusId]);
    await rejects(
      () => bookSlot("mark", { start: "2026-10-19T14:00:00.000Z", name: "Bea", email: "bea@booker.test" }, { ip: "203.0.113.94", now: NOW, fetchImpl: graph([]) }),
      { code: "unavailable" },
    );
    assert.equal((await getBookingPage(eclipse)).lastError, `Allow invites for ${ZEUS} in Settings › Calendars first.`);
  });

  it("lists invite senders and the default in get_settings", async () => {
    await setAddressHome(eclipse, NEO, ridgeon.workspaceId);
    const output = (await runTool(ridgeon, "get_settings", {})) as {
      inviteSenders?: { address: string; kind: string; main: boolean; problem: string | null }[];
      defaultInviteFrom?: string | null;
    };
    assert.deepEqual(output.inviteSenders?.map((sender) => [sender.address, sender.kind, sender.main]), [
      [MAIN, "microsoft", true],
      [CONSULTING, "microsoft", false],
      [ZEUS, "microsoft", false],
      [NEO, "smtp", false],
    ]);
    assert.equal(output.defaultInviteFrom, NEO);
  });
});
