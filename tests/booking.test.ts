import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { BOOKING_UNAVAILABLE, bookingSubject, bookSlot, clientIp, listSlots, SLOT_TAKEN } from "@/lib/booking/book";
import {
  checkSlugAvailable,
  getBookingPage,
  loadBookingImage,
  loadBookingPage,
  publicView,
  removeBookingImage,
  saveBookingImage,
  saveBookingPage,
  type BookingPageInput,
} from "@/lib/booking/pages";
import {
  checkSlug,
  checkVideoUrl,
  checkWeeklyHours,
  DEFAULT_WEEKLY_HOURS,
  imageType,
  RESERVED_SLUGS,
  suggestSlug,
  type WeeklyHours,
} from "@/lib/booking/rules";
import {
  bookableMonths,
  generateSlots,
  groupSlots,
  isOpenSlot,
  monthWindow,
  shiftMonth,
  type SlotRules,
} from "@/lib/booking/slots";
import { storeGrantedScopes } from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import { saveMeetingLink } from "@/lib/crm/invites";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { GraphEvent } from "@/lib/microsoft/calendar";
import { parseDateTime } from "@/lib/time";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const NOW = Date.UTC(2026, 9, 15, 9, 0);
const MONDAY_2PM = "2026-10-19T13:00:00.000Z";
const WRITE_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read offline_access";
const MAILBOX = "mark@orbit-booking.test";
const MINUTE = 60_000;

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const WEBP = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]);

function rules(overrides: Partial<SlotRules> = {}): SlotRules {
  return {
    weeklyHours: DEFAULT_WEEKLY_HOURS,
    durationMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 30,
    timeZone: "Europe/London",
    ...overrides,
  };
}

function iso(values: number[]) {
  return values.map((value) => new Date(value).toISOString());
}

function at(value: string) {
  return Date.parse(value);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function londonInstant(value: { dateTime: string; timeZone: string }) {
  const zone = value.timeZone === "UTC" ? "UTC" : "Europe/London";
  return parseDateTime(value.dateTime, zone)!.toISOString();
}

function graph(
  calls: Call[],
  options: { events?: () => GraphEvent[]; view?: () => Response; create?: () => Response; delay?: number } = {},
) {
  let created = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const parsed = new URL(url);
    if (parsed.hostname === "login.microsoftonline.com") {
      return json({ access_token: "fresh-token", expires_in: 3600, scope: WRITE_SCOPES });
    }
    if (parsed.pathname.includes("/calendarView")) {
      return options.view?.() ?? json({ value: options.events?.() ?? [] });
    }
    if (init?.method === "POST" && parsed.pathname.endsWith("/events")) {
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
      if (options.create) return options.create();
      created += 1;
      const draft = body as {
        subject: string;
        start: { dateTime: string; timeZone: string };
        end: { dateTime: string; timeZone: string };
        attendees: { emailAddress: { address: string; name?: string } }[];
      };
      const startsAt = londonInstant(draft.start);
      const endsAt = londonInstant(draft.end);
      return json(
        {
          id: `evt-${created}`,
          iCalUId: `ical-${created}`,
          subject: draft.subject,
          start: { dateTime: startsAt.replace("Z", ""), timeZone: "UTC" },
          end: { dateTime: endsAt.replace("Z", ""), timeZone: "UTC" },
          isAllDay: false,
          isCancelled: false,
          location: { displayName: "https://whereby.com/mark" },
          organizer: { emailAddress: { name: "Mark Ridgeon", address: MAILBOX } },
          attendees: draft.attendees.map((attendee) => ({
            type: "required",
            status: { response: "none" },
            emailAddress: attendee.emailAddress,
          })),
          showAs: "busy",
        } satisfies GraphEvent,
        201,
      );
    }
    if (init?.method === "POST" && parsed.pathname === "/v1.0/me/sendMail") return new Response(null, { status: 202 });
    return json({ error: { code: "NotFound", message: "Unexpected call" } }, 404);
  }) as typeof fetch;
}

function posts(calls: Call[]) {
  return calls.filter((call) => call.method === "POST" && new URL(call.url).hostname === "graph.microsoft.com" && call.url.endsWith("/events"));
}

function alerts(calls: Call[]) {
  return calls.filter((call) => call.method === "POST" && call.url === "https://graph.microsoft.com/v1.0/me/sendMail");
}

async function connect(actor: UserActor) {
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
  await withActor(actor, (db) => storeGrantedScopes(db, actor, id, WRITE_SCOPES));
  await getAdminPool().query(
    `insert into crm.calendars (
       workspace_id, user_id, connection_id, provider_calendar_id, name, color,
       is_default, is_visible, use_for_crm, can_edit
     ) values ($1, $2, $3, 'cal-main', 'Calendar', '#4f9be8', true, true, true, true)`,
    [actor.workspaceId, actor.userId, id],
  );
  return id;
}

function pageInput(overrides: BookingPageInput = {}): BookingPageInput {
  return {
    slug: "mark",
    enabled: true,
    title: null,
    intro: "Pick a time that suits you.",
    durationMinutes: 30,
    bufferMinutes: 10,
    minNoticeMinutes: 240,
    horizonDays: 21,
    weeklyHours: DEFAULT_WEEKLY_HOURS,
    videoUrl: "",
    ...overrides,
  };
}

async function rejects(run: () => Promise<unknown>, check: { code?: string; status?: number; message?: string | RegExp; field?: string }) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof CrmError, `expected CrmError, got ${String(error)}`);
    if (check.code) assert.equal(error.code, check.code);
    if (check.status) assert.equal(error.status, check.status);
    if (typeof check.message === "string") assert.equal(error.message, check.message);
    if (check.message instanceof RegExp) assert.match(error.message, check.message);
    if (check.field) assert.equal(error.details?.field, check.field);
    return true;
  });
}

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
});

after(async () => {
  await getPool().end();
});

describe("booking slots", () => {
  it("lays out weekday hours in London time and skips weekends", () => {
    const week = generateSlots(rules(), { from: at("2026-10-17T00:00:00Z"), to: at("2026-10-20T00:00:00Z"), now: NOW, busy: [] });
    assert.equal(week.length, 17);
    assert.equal(new Date(week[0]).toISOString(), "2026-10-19T08:00:00.000Z");
    assert.equal(new Date(week.at(-1)!).toISOString(), "2026-10-19T16:00:00.000Z");
    const long = generateSlots(rules({ durationMinutes: 45 }), {
      from: at("2026-10-19T00:00:00Z"),
      to: at("2026-10-20T00:00:00Z"),
      now: NOW,
      busy: [],
    });
    assert.equal(long.length, 16);
    assert.equal(new Date(long.at(-1)!).toISOString(), "2026-10-19T15:30:00.000Z");
    const split: WeeklyHours = { ...DEFAULT_WEEKLY_HOURS, mon: [{ start: "09:00", end: "10:00" }, { start: "16:00", end: "17:00" }] };
    assert.deepEqual(
      iso(generateSlots(rules({ weeklyHours: split }), { from: at("2026-10-19T00:00:00Z"), to: at("2026-10-20T00:00:00Z"), now: NOW, busy: [] })),
      ["2026-10-19T08:00:00.000Z", "2026-10-19T08:30:00.000Z", "2026-10-19T15:00:00.000Z", "2026-10-19T15:30:00.000Z"],
    );
  });

  it("keeps a buffer before and after busy events", () => {
    const busy = [{ start: at("2026-10-19T10:00:00Z"), end: at("2026-10-19T11:00:00Z") }];
    const day = { from: at("2026-10-19T08:00:00Z"), to: at("2026-10-19T13:00:00Z"), now: NOW, busy };
    assert.deepEqual(iso(generateSlots(rules({ bufferMinutes: 10 }), day)), [
      "2026-10-19T08:00:00.000Z",
      "2026-10-19T08:30:00.000Z",
      "2026-10-19T09:00:00.000Z",
      "2026-10-19T11:30:00.000Z",
      "2026-10-19T12:00:00.000Z",
      "2026-10-19T12:30:00.000Z",
    ]);
    assert.deepEqual(iso(generateSlots(rules({ bufferMinutes: 0 }), day)), [
      "2026-10-19T08:00:00.000Z",
      "2026-10-19T08:30:00.000Z",
      "2026-10-19T09:00:00.000Z",
      "2026-10-19T09:30:00.000Z",
      "2026-10-19T11:00:00.000Z",
      "2026-10-19T11:30:00.000Z",
      "2026-10-19T12:00:00.000Z",
      "2026-10-19T12:30:00.000Z",
    ]);
    const overnight = [{ start: at("2026-10-18T20:00:00Z"), end: at("2026-10-19T09:15:00Z") }];
    assert.equal(
      iso(generateSlots(rules(), { from: at("2026-10-19T00:00:00Z"), to: at("2026-10-20T00:00:00Z"), now: NOW, busy: overnight }))[0],
      "2026-10-19T09:30:00.000Z",
    );
  });

  it("respects minimum notice and the booking horizon", () => {
    const now = at("2026-10-19T08:20:00Z");
    const notice = generateSlots(rules({ minNoticeMinutes: 240 }), { from: at("2026-10-19T00:00:00Z"), to: at("2026-10-20T00:00:00Z"), now, busy: [] });
    assert.equal(new Date(notice[0]).toISOString(), "2026-10-19T12:30:00.000Z");
    const sunday = at("2026-10-18T11:00:00Z");
    const horizon = generateSlots(rules({ horizonDays: 1 }), { from: sunday, to: at("2026-11-30T00:00:00Z"), now: sunday, busy: [] });
    assert.equal(horizon.length, 17);
    assert.ok(horizon.every((slot) => new Date(slot).toISOString().startsWith("2026-10-19")));
    const months = bookableMonths(rules({ horizonDays: 21 }), NOW, "Europe/London");
    assert.deepEqual(months, { first: "2026-10", last: "2026-11" });
    assert.deepEqual(bookableMonths(rules({ horizonDays: 5 }), NOW, "Europe/London"), { first: "2026-10", last: "2026-10" });
  });

  it("stays correct across the clock changes", () => {
    const after = generateSlots(rules(), { from: at("2026-10-26T00:00:00Z"), to: at("2026-10-27T00:00:00Z"), now: NOW, busy: [] });
    assert.equal(new Date(after[0]).toISOString(), "2026-10-26T09:00:00.000Z");
    assert.equal(new Date(after.at(-1)!).toISOString(), "2026-10-26T17:00:00.000Z");
    const night: WeeklyHours = { ...DEFAULT_WEEKLY_HOURS, sun: [{ start: "00:00", end: "04:00" }] };
    const spring = generateSlots(rules({ weeklyHours: night }), {
      from: at("2027-03-27T12:00:00Z"),
      to: at("2027-03-28T12:00:00Z"),
      now: at("2027-03-20T00:00:00Z"),
      busy: [],
    });
    assert.deepEqual(iso(spring), [
      "2027-03-28T00:00:00.000Z",
      "2027-03-28T00:30:00.000Z",
      "2027-03-28T01:00:00.000Z",
      "2027-03-28T01:30:00.000Z",
      "2027-03-28T02:00:00.000Z",
      "2027-03-28T02:30:00.000Z",
    ]);
    const autumn = generateSlots(rules({ weeklyHours: night }), {
      from: at("2026-10-24T12:00:00Z"),
      to: at("2026-10-25T12:00:00Z"),
      now: NOW,
      busy: [],
    });
    assert.equal(new Date(autumn[0]).toISOString(), "2026-10-24T23:00:00.000Z");
    assert.equal(new Date(autumn.at(-1)!).toISOString(), "2026-10-25T03:30:00.000Z");
    assert.equal(new Set(autumn).size, autumn.length);
    assert.equal(new Date(monthWindow("2026-11", "Europe/London").from).toISOString(), "2026-11-01T00:00:00.000Z");
    assert.equal(new Date(monthWindow("2026-10", "Europe/London").from).toISOString(), "2026-09-30T23:00:00.000Z");
    assert.equal(shiftMonth("2026-12", 1), "2027-01");
    assert.equal(shiftMonth("2027-01", -1), "2026-12");
  });

  it("groups by the visitor's own date and validates single slots", () => {
    const late: WeeklyHours = { ...DEFAULT_WEEKLY_HOURS, mon: [{ start: "22:30", end: "23:30" }] };
    const slots = generateSlots(rules({ weeklyHours: late }), { from: at("2026-10-19T00:00:00Z"), to: at("2026-10-20T00:00:00Z"), now: NOW, busy: [] });
    assert.deepEqual(Object.keys(groupSlots(slots, "Europe/London")), ["2026-10-19"]);
    assert.deepEqual(groupSlots(slots, "Asia/Tokyo"), {
      "2026-10-20": ["2026-10-19T21:30:00.000Z", "2026-10-19T22:00:00.000Z"],
    });
    assert.equal(isOpenSlot(rules(), at(MONDAY_2PM), NOW, []), true);
    assert.equal(isOpenSlot(rules(), at("2026-10-19T13:10:00.000Z"), NOW, []), false);
    assert.equal(isOpenSlot(rules(), at("2026-10-17T13:00:00.000Z"), NOW, []), false);
    assert.equal(isOpenSlot(rules(), at(MONDAY_2PM), NOW, [{ start: at(MONDAY_2PM), end: at(MONDAY_2PM) + 30 * MINUTE }]), false);
    assert.equal(isOpenSlot(rules(), NaN, NOW, []), false);
  });
});

describe("booking page rules", () => {
  it("validates slugs and blocks reserved words", () => {
    assert.deepEqual(checkSlug("  Mark-Ridgeon "), { ok: true, value: "mark-ridgeon" });
    assert.equal(checkSlug("ab").ok, false);
    assert.equal(checkSlug("a".repeat(41)).ok, false);
    assert.equal(checkSlug("a".repeat(40)).ok, true);
    for (const bad of ["-mark", "mark-", "ma--rk", "mark_r", "märk", "mark r", "mark/x"]) {
      assert.equal(checkSlug(bad).ok, false, bad);
    }
    for (const reserved of ["admin", "api", "settings", "login", "book"]) {
      const result = checkSlug(reserved);
      assert.equal(result.ok, false);
      assert.match(!result.ok ? result.error : "", /reserved/);
    }
    assert.equal(suggestSlug("Mark Ridgeon"), "mark");
    assert.equal(suggestSlug("Zoë"), "zoe");
    assert.equal(suggestSlug("Al"), "meet");
    assert.equal(suggestSlug("Admin Person"), "meet");
  });

  it("keeps the database reserved list in step with the app", async () => {
    const result = await getAdminPool().query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'booking_pages_slug_reserved'",
    );
    const words = new Set([...result.rows[0].def.matchAll(/'([a-z]+)'::text/g)].map((match) => match[1]));
    assert.deepEqual([...words].sort(), [...RESERVED_SLUGS].sort());
  });

  it("checks weekly hours, video links and image types", () => {
    assert.equal(checkWeeklyHours(DEFAULT_WEEKLY_HOURS).ok, true);
    assert.equal(checkWeeklyHours({ mon: [{ start: "09:00", end: "24:00" }] }).ok, true);
    assert.equal(checkWeeklyHours({ mon: [{ start: "10:00", end: "09:00" }] }).ok, false);
    assert.equal(checkWeeklyHours({ mon: [{ start: "9:00", end: "17:00" }] }).ok, false);
    assert.equal(checkWeeklyHours({ funday: [] }).ok, false);
    assert.equal(
      checkWeeklyHours({ mon: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }).ok,
      false,
    );
    assert.deepEqual(checkVideoUrl(" https://cdn.example.com/loop.mp4 "), { ok: true, value: "https://cdn.example.com/loop.mp4" });
    assert.deepEqual(checkVideoUrl(""), { ok: true, value: null });
    assert.equal(checkVideoUrl("http://cdn.example.com/loop.mp4").ok, false);
    assert.equal(checkVideoUrl("javascript:alert(1)").ok, false);
    assert.equal(checkVideoUrl(`https://cdn.example.com/${"a".repeat(1000)}`).ok, false);
    assert.equal(imageType(PNG), "image/png");
    assert.equal(imageType(JPEG), "image/jpeg");
    assert.equal(imageType(WEBP), "image/webp");
    assert.equal(imageType(new TextEncoder().encode("<svg onload=alert(1)>")), null);
    assert.equal(bookingSubject("Mark Ridgeon", "Jane Doe"), "Mark × Jane Doe");
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" })), "198.51.100.7");
    assert.equal(clientIp(new Headers()), "unknown");
  });
});

describe("booking page settings and public access", () => {
  let owner: UserActor;
  let other: UserActor;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser("mark@orbit-booking.test", "Mark Ridgeon");
    other = await createUser("other@orbit-booking.test", "Other Person");
  });

  it("saves the page, defaults the title and rejects taken or reserved links", async () => {
    const fresh = await getBookingPage(owner);
    assert.equal(fresh.exists, false);
    assert.equal(fresh.slug, "mark");
    assert.equal(fresh.defaultTitle, "Book a call with Mark");
    const saved = await saveBookingPage(owner, pageInput({ enabled: false }));
    assert.equal(saved.exists, true);
    assert.equal(saved.enabled, false);
    assert.deepEqual(saved.weeklyHours, DEFAULT_WEEKLY_HOURS);
    await rejects(() => saveBookingPage(other, pageInput()), { code: "conflict", field: "slug", message: /taken/ });
    await rejects(() => saveBookingPage(other, pageInput({ slug: "settings" })), { field: "slug", message: /reserved/ });
    await rejects(() => saveBookingPage(other, pageInput({ slug: "other", durationMinutes: 25 })), { field: "durationMinutes" });
    await rejects(() => saveBookingPage(other, pageInput({ slug: "other", bufferMinutes: 61 })), { field: "bufferMinutes" });
    await rejects(() => saveBookingPage(other, pageInput({ slug: "other", horizonDays: 91 })), { field: "horizonDays" });
    await rejects(() => saveBookingPage(other, pageInput({ slug: "other", intro: "x".repeat(501) })), { field: "intro" });
    await rejects(() => saveBookingPage(other, pageInput({ slug: "other", videoUrl: "http://x.test/a.mp4" })), { field: "videoUrl" });
    await rejects(
      () => saveBookingPage(other, pageInput({ slug: "other", weeklyHours: { ...DEFAULT_WEEKLY_HOURS, mon: [], tue: [], wed: [], thu: [], fri: [] } })),
      { field: "weeklyHours", message: /at least one day/ },
    );
    assert.deepEqual(await checkSlugAvailable(other, "Mark"), { slug: "mark", available: false, error: "That link is taken. Pick another." });
    assert.deepEqual(await checkSlugAvailable(owner, "mark"), { slug: "mark", available: true, error: null });
    assert.equal((await checkSlugAvailable(other, "api")).available, false);
    assert.equal((await checkSlugAvailable(other, "other-person")).available, true);
    const rows = await queryAsUser<{ id: string }>(other.userId, "select id from crm.booking_pages");
    assert.equal(rows.length, 0);
    await assert.rejects(() =>
      queryAsUser(other.userId, "update crm.booking_pages set enabled = true where slug = 'mark' returning id").then((updated) => {
        if (updated.length === 0) throw new Error("blocked");
      }),
    );
  });

  it("exposes only public fields, and only while the page is on", async () => {
    await saveMeetingLink(owner, "https://whereby.com/mark");
    await saveBookingPage(owner, pageInput({ enabled: false }));
    assert.equal(await loadBookingPage("mark"), null);
    await rejects(() => listSlots("mark", {}, { ip: freshIp(), now: NOW }), { code: "not_found", status: 404 });
    await rejects(
      () => bookSlot("mark", { start: MONDAY_2PM, name: "Jane", email: "jane@acme.test" }, { ip: freshIp(), now: NOW }),
      { code: "not_found", status: 404 },
    );

    await saveBookingPage(owner, pageInput());
    await saveBookingImage(owner, "avatar", PNG);
    const result = await getPool().query("select * from private.booking_page_public($1)", ["MARK"]);
    assert.deepEqual(Object.keys(result.rows[0]).sort(), [
      "background_video_url",
      "buffer_minutes",
      "duration_minutes",
      "has_avatar",
      "has_poster",
      "horizon_days",
      "intro",
      "meeting_kind",
      "min_notice_minutes",
      "owner_name",
      "page_id",
      "slug",
      "time_zone",
      "title",
      "user_id",
      "version",
      "weekly_hours",
    ]);
    const serialized = JSON.stringify(result.rows[0]);
    assert.doesNotMatch(serialized, /whereby\.com|mark@orbit-booking|workspace/i);
    const page = await loadBookingPage("mark");
    assert.ok(page);
    const view = publicView(page);
    assert.deepEqual(Object.keys(view).sort(), [
      "avatarUrl",
      "durationMinutes",
      "intro",
      "meetingKind",
      "ownerName",
      "posterUrl",
      "slug",
      "timeZone",
      "title",
      "videoUrl",
    ]);
    assert.equal(view.title, "Book a call with Mark");
    assert.equal(view.ownerName, "Mark Ridgeon");
    assert.equal(view.meetingKind, "whereby");
    assert.match(view.avatarUrl ?? "", /^\/api\/book\/mark\/image\/avatar\?v=/);
    assert.equal(view.posterUrl, null);
    const avatar = await loadBookingImage("mark", "avatar");
    assert.equal(avatar?.mime, "image/png");
    assert.equal(await loadBookingImage("mark", "poster"), null);

    await assert.rejects(() => queryAsUser(other.userId, "select * from private.booking_page_public('mark')"), /permission denied/);
    await assert.rejects(
      () => queryAsUser(other.userId, "select * from private.booking_busy($1, now(), now() + interval '1 day')", [owner.userId]),
      /permission denied/,
    );
  });

  it("stores avatar images after checking their bytes", async () => {
    await rejects(() => saveBookingImage(owner, "avatar", PNG), { code: "not_found", message: /Save your booking page first/ });
    await saveBookingPage(owner, pageInput());
    await rejects(() => saveBookingImage(owner, "avatar", new TextEncoder().encode("<svg/>")), { message: /JPEG, PNG or WebP/ });
    await rejects(() => saveBookingImage(owner, "avatar", new Uint8Array(1024 * 1024 + 1).fill(0xff)), { message: /1 MB/ });
    await saveBookingImage(owner, "avatar", JPEG);
    assert.equal((await getBookingPage(owner)).hasAvatar, true);
    await removeBookingImage(owner, "avatar");
    assert.equal((await getBookingPage(owner)).hasAvatar, false);
    await saveBookingImage(owner, "poster", WEBP);
    assert.equal((await getBookingPage(owner)).hasPoster, true);
  });

  it("lists slots by month in the visitor's zone and hides busy time from every calendar", async () => {
    await saveBookingPage(owner, pageInput());
    const connectionId = await connect(owner);
    const second = await getAdminPool().query<{ id: string }>(
      `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color)
       values ($1, $2, $3, 'cal-side', 'Side', '#22aa66') returning id`,
      [owner.workspaceId, owner.userId, connectionId],
    );
    const insert = (calendarId: string, id: string, start: string, end: string, extra: { showAs?: string; cancelled?: boolean } = {}) =>
      getAdminPool().query(
        `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject,
           starts_at, ends_at, is_cancelled, show_as)
         values ($1, $2, $3, $4, $5, 'Busy', $6, $7, $8, $9)`,
        [owner.workspaceId, calendarId, connectionId, owner.userId, id, start, end, extra.cancelled ?? false, extra.showAs ?? "busy"],
      );
    await insert(second.rows[0].id, "side-1", "2026-10-19T09:00:00Z", "2026-10-19T10:00:00Z");
    await insert(second.rows[0].id, "side-2", "2026-10-19T14:00:00Z", "2026-10-19T15:00:00Z", { showAs: "free" });
    await insert(second.rows[0].id, "side-3", "2026-10-19T15:00:00Z", "2026-10-19T16:00:00Z", { cancelled: true });

    const october = await listSlots("mark", { month: "2026-10", timeZone: "Europe/London" }, { ip: freshIp(), now: NOW });
    assert.equal(october.month, "2026-10");
    assert.equal(october.first, "2026-10");
    assert.equal(october.last, "2026-11");
    assert.equal(october.days["2026-10-15"][0], "2026-10-15T13:00:00.000Z");
    assert.equal(october.days["2026-10-17"], undefined);
    const monday = october.days["2026-10-19"];
    assert.ok(!monday.includes("2026-10-19T08:30:00.000Z"));
    assert.ok(!monday.includes("2026-10-19T09:30:00.000Z"));
    assert.ok(monday.includes("2026-10-19T08:00:00.000Z"));
    assert.ok(monday.includes("2026-10-19T10:30:00.000Z"));
    assert.ok(monday.includes("2026-10-19T14:00:00.000Z"));
    assert.ok(monday.includes("2026-10-19T15:00:00.000Z"));

    const tokyo = await listSlots("mark", { month: "2026-10", timeZone: "Asia/Tokyo" }, { ip: freshIp(), now: NOW });
    assert.equal(tokyo.timeZone, "Asia/Tokyo");
    assert.ok(tokyo.days["2026-10-20"].includes("2026-10-19T16:00:00.000Z"));
    const fallback = await listSlots("mark", { month: "nope", timeZone: "Mars/Base" }, { ip: freshIp(), now: NOW });
    assert.equal(fallback.timeZone, "Europe/London");
    assert.equal(fallback.month, "2026-10");
    const outside = await listSlots("mark", { month: "2027-01" }, { ip: freshIp(), now: NOW });
    assert.deepEqual(outside.days, {});
  });

  it("rate limits slot lookups per IP", async () => {
    await saveBookingPage(owner, pageInput());
    const ip = freshIp();
    for (let index = 0; index < 10; index += 1) await listSlots("mark", { month: "2026-10" }, { ip, now: NOW });
    await rejects(() => listSlots("mark", { month: "2026-10" }, { ip, now: NOW }), { code: "rate_limited", status: 429 });
    await listSlots("mark", { month: "2026-10" }, { ip: freshIp(), now: NOW });
  });
});

describe("booking a call", () => {
  let owner: UserActor;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser(MAILBOX, "Mark Ridgeon");
    await connect(owner);
    await saveMeetingLink(owner, "https://whereby.com/mark");
    await saveBookingPage(owner, pageInput());
  });

  function input(overrides: Record<string, unknown> = {}) {
    return {
      start: MONDAY_2PM,
      name: "Jane Doe",
      email: "Jane@Acme-Booking.test",
      note: "Keen to talk <pricing> & terms",
      website: "",
      timeZone: "America/New_York",
      ...overrides,
    };
  }

  it("creates the Outlook meeting, the contact, the activity and the saved event", async () => {
    process.env.SITE_URL = "https://orbit.test";
    const calls: Call[] = [];
    const booking = await bookSlot("mark", input(), { ip: freshIp(), now: NOW, fetchImpl: graph(calls) });
    assert.deepEqual(booking, {
      subject: "Mark × Jane Doe",
      title: "Book a call with Mark",
      ownerName: "Mark Ridgeon",
      name: "Jane Doe",
      email: "jane@acme-booking.test",
      startsAt: MONDAY_2PM,
      endsAt: "2026-10-19T13:30:00.000Z",
      durationMinutes: 30,
      timeZone: "America/New_York",
      pageTimeZone: "Europe/London",
      meetingKind: "whereby",
    });
    const view = calls.find((call) => call.url.includes("/calendarView"));
    assert.ok(view);
    assert.match(view.url, /\/me\/calendars\/cal-main\/calendarView\?startDateTime=2026-10-19T12%3A49%3A00\.000Z/);
    const [post] = posts(calls);
    assert.equal(posts(calls).length, 1);
    assert.ok(calls.indexOf(view) < calls.indexOf(post));
    assert.equal(post.url, "https://graph.microsoft.com/v1.0/me/calendars/cal-main/events");
    const body = post.body as Record<string, unknown>;
    assert.equal(body.subject, "Mark × Jane Doe");
    assert.deepEqual(body.start, { dateTime: "2026-10-19T14:00:00", timeZone: "GMT Standard Time" });
    assert.deepEqual(body.end, { dateTime: "2026-10-19T14:30:00", timeZone: "GMT Standard Time" });
    assert.deepEqual(body.location, { displayName: "https://whereby.com/mark" });
    assert.deepEqual(body.attendees, [
      { emailAddress: { address: "jane@acme-booking.test", name: "Jane Doe" }, type: "required" },
    ]);
    assert.deepEqual(body.body, {
      contentType: "HTML",
      content:
        "<div><p>Note from Jane Doe:<br>Keen to talk &lt;pricing&gt; &amp; terms</p>" +
        '<p>Join: <a href="https://whereby.com/mark">https://whereby.com/mark</a></p></div>',
    });

    const admin = getAdminPool();
    const contact = await admin.query<{ id: string; first_name: string; last_name: string; company: string; source: string }>(
      `select c.id, c.first_name, c.last_name, co.name as company, c.source from crm.contacts c
       join crm.companies co on co.id = c.company_id where c.normalized_email = 'jane@acme-booking.test'`,
    );
    assert.equal(contact.rows.length, 1);
    assert.equal(contact.rows[0].first_name, "Jane");
    assert.equal(contact.rows[0].last_name, "Doe");
    assert.equal(contact.rows[0].company, "Acme Booking");
    const event = await admin.query<{ id: string; created_by_orbit: boolean; contact_ids: string[]; subject: string }>(
      "select id, created_by_orbit, contact_ids, subject from crm.calendar_events where provider_event_id = 'evt-1'",
    );
    assert.equal(event.rows[0].created_by_orbit, true);
    assert.equal(event.rows[0].subject, "Mark × Jane Doe");
    assert.deepEqual(event.rows[0].contact_ids, [contact.rows[0].id]);
    const activity = await admin.query<{ type: string; title: string; body: string; metadata: Record<string, unknown>; actor_user_id: string }>(
      "select type, title, body, metadata, actor_user_id from crm.activities where contact_id = $1",
      [contact.rows[0].id],
    );
    assert.equal(activity.rows.length, 1);
    assert.equal(activity.rows[0].type, "meeting");
    assert.equal(activity.rows[0].title, "Booked via your booking page");
    assert.equal(activity.rows[0].actor_user_id, owner.userId);
    assert.match(activity.rows[0].body, /Mon, 19 Oct 2026, 14:00 to 14:30 London time/);
    assert.match(activity.rows[0].body, /Join: https:\/\/whereby\.com\/mark/);
    assert.match(activity.rows[0].body, /Keen to talk <pricing> & terms/);
    assert.equal(activity.rows[0].metadata.source, "booking");
    assert.equal(activity.rows[0].metadata.eventId, event.rows[0].id);

    const [alert] = alerts(calls);
    assert.equal(alerts(calls).length, 1);
    const message = (alert.body as { message: { subject: string; body: { content: string }; toRecipients: { emailAddress: { address: string } }[] } }).message;
    assert.equal(message.toRecipients[0].emailAddress.address, MAILBOX);
    assert.match(message.subject, /^New booking: Jane Doe, Mon, 19 Oct 2026, 14:00/);
    assert.match(message.body.content, /Jane Doe \(jane@acme-booking\.test\) booked .+ through your booking page\./);
    assert.match(message.body.content, /Join: https:\/\/whereby\.com\/mark/);
    assert.match(message.body.content, /Note from Jane Doe:\nKeen to talk <pricing> & terms/);
    assert.match(message.body.content, new RegExp(`https://orbit\\.test/contacts/${contact.rows[0].id}`));
    const bell = await admin.query<{ title: string; href: string; source: string }>(
      "select title, href, source from crm.notifications where user_id = $1 and source = 'booking'",
      [owner.userId],
    );
    assert.equal(bell.rows.length, 1);
    assert.match(bell.rows[0].title, /^Jane Doe booked /);
    assert.equal(bell.rows[0].href, `/contacts/${contact.rows[0].id}`);
    delete process.env.SITE_URL;

    const after = await listSlots("mark", { month: "2026-10" }, { ip: freshIp(), now: NOW });
    assert.ok(!after.days["2026-10-19"].includes(MONDAY_2PM));
    assert.ok(!after.days["2026-10-19"].includes("2026-10-19T13:30:00.000Z"));
    assert.ok(!after.days["2026-10-19"].includes("2026-10-19T12:30:00.000Z"));
  });

  it("reuses an existing contact and never turns your own address into one", async () => {
    await bookSlot("mark", input(), { ip: freshIp(), now: NOW, fetchImpl: graph([]) });
    await bookSlot("mark", input({ start: "2026-10-19T14:00:00.000Z", name: "Jane D" }), {
      ip: freshIp(),
      now: NOW,
      fetchImpl: graph([]),
    });
    const contacts = await getAdminPool().query("select id from crm.contacts where normalized_email = 'jane@acme-booking.test'");
    assert.equal(contacts.rows.length, 1);
    const activities = await getAdminPool().query("select id from crm.activities where contact_id = $1", [contacts.rows[0].id]);
    assert.equal(activities.rows.length, 2);
    await rejects(
      () => bookSlot("mark", input({ start: "2026-10-20T13:00:00.000Z", email: MAILBOX }), { ip: freshIp(), now: NOW, fetchImpl: graph([]) }),
      { field: "email", message: /organiser/ },
    );
    const colleague = await bookSlot("mark", input({ start: "2026-10-20T13:00:00.000Z", email: "pat@orbit-booking.test", name: "Pat" }), {
      ip: freshIp(),
      now: NOW,
      fetchImpl: graph([]),
    });
    assert.equal(colleague.email, "pat@orbit-booking.test");
    const internal = await getAdminPool().query("select id from crm.contacts where normalized_email = 'pat@orbit-booking.test'");
    assert.equal(internal.rows.length, 0);
  });

  it("lets only one of two simultaneous bookings for the same slot through", async () => {
    const calls: Call[] = [];
    const fetchImpl = graph(calls, { delay: 50 });
    const results = await Promise.allSettled([
      bookSlot("mark", input(), { ip: freshIp(), now: NOW, fetchImpl }),
      bookSlot("mark", input({ email: "bob@other-booking.test", name: "Bob" }), { ip: freshIp(), now: NOW, fetchImpl }),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    const error = (lost[0] as PromiseRejectedResult).reason;
    assert.ok(error instanceof CrmError);
    assert.equal(error.code, "conflict");
    assert.equal(error.status, 409);
    assert.equal(error.message, SLOT_TAKEN);
    assert.equal(posts(calls).length, 1);
    const events = await getAdminPool().query("select id from crm.calendar_events where starts_at = $1", [MONDAY_2PM]);
    assert.equal(events.rows.length, 1);
  });

  it("checks the live Outlook calendar, and falls back to stored data when Graph fails", async () => {
    const calls: Call[] = [];
    const clash: GraphEvent = {
      id: "outlook-only",
      subject: "Dentist",
      start: { dateTime: "2026-10-19T13:15:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-19T13:45:00.0000000", timeZone: "UTC" },
      showAs: "busy",
    };
    await rejects(() => bookSlot("mark", input(), { ip: freshIp(), now: NOW, fetchImpl: graph(calls, { events: () => [clash] }) }), {
      code: "conflict",
      message: SLOT_TAKEN,
    });
    assert.equal(posts(calls).length, 0);
    const free = await bookSlot("mark", input(), {
      ip: freshIp(),
      now: NOW,
      fetchImpl: graph([], { events: () => [{ ...clash, showAs: "free" }] }),
    });
    assert.equal(free.startsAt, MONDAY_2PM);
    const failing: Call[] = [];
    const fallback = await bookSlot("mark", input({ start: "2026-10-20T13:00:00.000Z" }), {
      ip: freshIp(),
      now: NOW,
      fetchImpl: graph(failing, { view: () => json({ error: { code: "ServiceUnavailable", message: "down" } }, 503) }),
    });
    assert.equal(fallback.startsAt, "2026-10-20T13:00:00.000Z");
    assert.equal(posts(failing).length, 1);
  });

  it("rejects slots that aren't offered, bad input and the honeypot", async () => {
    const calls: Call[] = [];
    const context = () => ({ ip: freshIp(), now: NOW, fetchImpl: graph(calls) });
    await rejects(() => bookSlot("mark", input({ start: "2026-10-19T13:10:00.000Z" }), context()), { code: "conflict" });
    await rejects(() => bookSlot("mark", input({ start: "2026-10-17T13:00:00.000Z" }), context()), { code: "conflict" });
    await rejects(() => bookSlot("mark", input({ start: "2026-10-15T10:00:00.000Z" }), context()), { code: "conflict" });
    await rejects(() => bookSlot("mark", input({ start: "2026-12-21T13:00:00.000Z" }), context()), { code: "conflict" });
    await rejects(() => bookSlot("mark", input({ start: "soon" }), context()), { field: "start" });
    await rejects(() => bookSlot("mark", input({ name: "  " }), context()), { field: "name" });
    await rejects(() => bookSlot("mark", input({ name: "x".repeat(121) }), context()), { field: "name" });
    await rejects(() => bookSlot("mark", input({ email: "jane" }), context()), { field: "email" });
    await rejects(() => bookSlot("mark", input({ note: "x".repeat(1001) }), context()), { field: "note" });
    await rejects(() => bookSlot("mark", input({ website: "https://spam.test" }), context()), { code: "invalid_input" });
    assert.equal(posts(calls).length, 0);
  });

  it("rate limits booking attempts per IP and bookings per email", async () => {
    const ip = freshIp();
    for (let index = 0; index < 5; index += 1) {
      await rejects(() => bookSlot("mark", input({ name: "" }), { ip, now: NOW, fetchImpl: graph([]) }), { field: "name" });
    }
    await rejects(() => bookSlot("mark", input(), { ip, now: NOW, fetchImpl: graph([]) }), { code: "rate_limited", status: 429 });
    const starts = ["2026-10-19T13:00:00.000Z", "2026-10-19T14:00:00.000Z", "2026-10-19T15:00:00.000Z"];
    for (const start of starts) {
      await bookSlot("mark", input({ start }), { ip: freshIp(), now: NOW, fetchImpl: graph([]) });
    }
    await rejects(
      () => bookSlot("mark", input({ start: "2026-10-20T13:00:00.000Z", email: "JANE@acme-booking.test" }), {
        ip: freshIp(),
        now: NOW,
        fetchImpl: graph([]),
      }),
      { code: "rate_limited", message: /today's booking limit/ },
    );
  });

  it("shows a generic error to the public and the real reason in Settings", async () => {
    await rejects(
      () =>
        bookSlot("mark", input(), {
          ip: freshIp(),
          now: NOW,
          fetchImpl: graph([], { create: () => json({ error: { code: "ErrorInternalServerError", message: "nope" } }, 500) }),
        }),
      { code: "unavailable", status: 503, message: BOOKING_UNAVAILABLE },
    );
    assert.match((await getBookingPage(owner)).lastError ?? "", /Microsoft couldn't create the meeting/);

    await getAdminPool().query("update crm.integration_state set granted_scopes = $1", [
      "https://graph.microsoft.com/Calendars.Read offline_access",
    ]);
    const calls: Call[] = [];
    await rejects(() => bookSlot("mark", input(), { ip: freshIp(), now: NOW, fetchImpl: graph(calls) }), {
      code: "unavailable",
      status: 503,
      message: BOOKING_UNAVAILABLE,
    });
    assert.equal(posts(calls).length, 0);
    const page = await getBookingPage(owner);
    assert.match(page.lastError ?? "", /Reconnect Microsoft/);
    assert.ok(page.lastErrorAt);

    await getAdminPool().query("delete from crm.mailbox_connections");
    await rejects(() => bookSlot("mark", input(), { ip: freshIp(), now: NOW, fetchImpl: graph([]) }), { code: "unavailable" });
    assert.match((await getBookingPage(owner)).lastError ?? "", /isn't connected/);
  });

  it("clears the Settings error after a booking goes through", async () => {
    await getAdminPool().query("update crm.booking_pages set last_error = 'old', last_error_at = now()");
    await bookSlot("mark", input(), { ip: freshIp(), now: NOW, fetchImpl: graph([]) });
    const page = await getBookingPage(owner);
    assert.equal(page.lastError, null);
    assert.equal(page.lastErrorAt, null);
  });
});

describe("booking proxy", () => {
  it("lets the public booking page through without a session", async () => {
    const page = await proxy(new NextRequest("http://localhost/book/mark"));
    assert.equal(page.headers.get("location"), null);
    assert.equal(page.headers.get("x-middleware-next"), "1");
    const api = await proxy(new NextRequest("http://localhost/api/book/mark/slots?month=2026-10"));
    assert.equal(api.headers.get("location"), null);
    const home = await proxy(new NextRequest("http://localhost/"));
    assert.match(home.headers.get("location") ?? "", /\/login$/);
    const lookalike = await proxy(new NextRequest("http://localhost/bookings"));
    assert.match(lookalike.headers.get("location") ?? "", /\/login$/);
  });
});
