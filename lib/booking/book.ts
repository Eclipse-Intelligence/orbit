import { createHmac, randomUUID } from "node:crypto";
import { appSecret } from "@/lib/auth/config";
import { CrmError } from "@/lib/crm/errors";
import { openInviteSender, sendInvite } from "@/lib/crm/invites";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import { openClient, query } from "@/lib/db/pool";
import { fetchCalendarView } from "@/lib/microsoft/calendar";
import {
  loadBookingOwner,
  loadBookingPage,
  loadBusy,
  recordBookingError,
  type LoadedBookingPage,
  type MeetingKind,
} from "@/lib/booking/pages";
import { BOOKING_NAME_MAX, BOOKING_NOTE_MAX, bookingPath, firstName } from "@/lib/booking/rules";
import {
  bookableMonths,
  generateSlots,
  groupSlots,
  isOpenSlot,
  monthWindow,
  parseMonth,
  type BusyInterval,
} from "@/lib/booking/slots";
import { isTimeZone } from "@/lib/time";

const MINUTE = 60_000;
const DAY = 86_400_000;
const LOCK_WAIT_MS = 25_000;

export const BOOKING_LIMITS = {
  slotsPerMinute: 10,
  attemptsPerHour: 5,
  bookingsPerEmailPerDay: 3,
};

export const SLOT_TAKEN = "That time was just taken — pick another.";
export const BOOKING_UNAVAILABLE = "Booking is temporarily unavailable. Please try again later.";
export const PAGE_MISSING = "This booking page isn't available.";

export type BookingContext = { ip: string; now?: number; fetchImpl?: typeof fetch };

export type BookingInput = {
  start?: unknown;
  name?: unknown;
  email?: unknown;
  note?: unknown;
  website?: unknown;
  timeZone?: unknown;
};

export type SlotMonth = {
  month: string;
  timeZone: string;
  first: string;
  last: string;
  days: Record<string, string[]>;
};

export type BookingConfirmation = {
  subject: string;
  title: string;
  ownerName: string;
  name: string;
  email: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  timeZone: string;
  pageTimeZone: string;
  meetingKind: MeetingKind;
};

function digest(value: string) {
  return createHmac("sha256", appSecret()).update(value).digest("base64url").slice(0, 32);
}

async function consume(key: string, limit: number, windowSeconds: number, message: string) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [
    key,
    limit,
    windowSeconds,
  ]);
  if (!result.rows[0]?.allowed) throw new CrmError("rate_limited", message, 429);
}

function invalid(message: string, field: string) {
  return new CrmError("invalid_input", message, 400, { field });
}

function missing() {
  return new CrmError("not_found", PAGE_MISSING, 404);
}

function visitorZone(value: unknown, fallback: string) {
  return typeof value === "string" && value.length <= 64 && isTimeZone(value) ? value : fallback;
}

export async function listSlots(
  slug: string,
  params: { month?: string | null; timeZone?: string | null },
  context: BookingContext,
): Promise<SlotMonth> {
  await consume(
    `booking:slots:${digest(context.ip)}`,
    BOOKING_LIMITS.slotsPerMinute,
    60,
    "Too many requests. Wait a moment and try again.",
  );
  const page = await loadBookingPage(slug);
  if (!page) throw missing();
  const now = context.now ?? Date.now();
  const timeZone = visitorZone(params.timeZone, page.timeZone);
  const months = bookableMonths(page.rules, now, timeZone);
  const month = parseMonth(params.month) ?? months.first;
  const empty = { month, timeZone, first: months.first, last: months.last, days: {} };
  if (month < months.first || month > months.last) return empty;
  const window = monthWindow(month, timeZone);
  const busy = await loadBusy(page.userId, window.from - DAY, window.to + DAY);
  const slots = generateSlots(page.rules, { from: window.from, to: window.to, now, busy });
  return { ...empty, days: groupSlots(slots, timeZone) };
}

function cleanName(value: unknown) {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!name) throw invalid("Enter your name.", "name");
  if (name.length > BOOKING_NAME_MAX) throw invalid(`Keep your name under ${BOOKING_NAME_MAX + 1} characters.`, "name");
  return name;
}

function cleanEmail(value: unknown) {
  const email = canonicalEmail(typeof value === "string" ? value : "");
  if (!email) throw invalid("Enter a valid email address.", "email");
  return email;
}

function cleanNote(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid("The note must be text.", "note");
  const note = value.replace(/\r\n?/g, "\n").trim();
  if (note.length > BOOKING_NOTE_MAX) throw invalid(`Keep the note under ${BOOKING_NOTE_MAX + 1} characters.`, "note");
  return note || null;
}

function cleanStart(value: unknown) {
  const time = typeof value === "string" && value.length <= 40 ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw invalid("Pick a time.", "start");
  return time;
}

export function bookingSubject(ownerName: string, bookerName: string) {
  return `${firstName(ownerName) ?? ownerName} × ${bookerName}`;
}

async function withBookingLock<T>(userId: string, run: () => Promise<T>) {
  const key = `booking:${userId}`;
  let client: Awaited<ReturnType<typeof openClient>>;
  try {
    client = await openClient();
    await client.query(`set statement_timeout = ${LOCK_WAIT_MS}`);
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
  } catch (error) {
    console.error("Booking lock failed", error);
    throw new CrmError("unavailable", BOOKING_UNAVAILABLE, 503);
  }
  try {
    return await run();
  } finally {
    await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function liveBusy(
  page: LoadedBookingPage,
  sender: Awaited<ReturnType<typeof openInviteSender>>,
  start: number,
  end: number,
  fetchImpl: typeof fetch,
): Promise<BusyInterval[]> {
  const buffer = page.rules.bufferMinutes * MINUTE;
  try {
    const view = await fetchCalendarView(
      sender.token.accessToken,
      { start: new Date(start - buffer - MINUTE), end: new Date(end + buffer + MINUTE) },
      { calendarId: sender.calendarId, fetchImpl, pageLimit: 2 },
    );
    return view.events
      .filter((event) => !event.isCancelled && event.showAs?.toLowerCase() !== "free")
      .map((event) => ({ start: Date.parse(event.startsAt), end: Date.parse(event.endsAt) }));
  } catch (error) {
    console.warn("Booking live calendar check failed; using stored calendar", error instanceof Error ? error.message : error);
    return [];
  }
}

function unavailable(error: unknown) {
  if (error instanceof CrmError) {
    if (error.code === "not_connected") return "Microsoft isn't connected, so the booking page can't create meetings. Connect Microsoft in Inbox.";
    if (error.code === "scope_missing") return "Microsoft hasn't allowed Orbit to create meetings. Reconnect Microsoft in Inbox.";
    return `Microsoft couldn't create the meeting: ${error.message}`;
  }
  return "Orbit couldn't create the meeting.";
}

export async function bookSlot(slug: string, input: BookingInput, context: BookingContext): Promise<BookingConfirmation> {
  await consume(
    `booking:attempts:${digest(context.ip)}`,
    BOOKING_LIMITS.attemptsPerHour,
    3600,
    "Too many booking attempts. Try again in an hour.",
  );
  if (typeof input.website === "string" && input.website.trim()) {
    throw new CrmError("invalid_input", "We couldn't book that time. Refresh the page and try again.", 400);
  }
  const start = cleanStart(input.start);
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  const note = cleanNote(input.note);
  const page = await loadBookingPage(slug);
  if (!page) throw missing();
  const now = context.now ?? Date.now();
  const end = start + page.rules.durationMinutes * MINUTE;
  const busyWindow = { from: start - DAY, to: end + DAY };
  if (!isOpenSlot(page.rules, start, now, await loadBusy(page.userId, busyWindow.from, busyWindow.to))) {
    throw new CrmError("conflict", SLOT_TAKEN, 409, { field: "start" });
  }
  await consume(
    `booking:email:${digest(email)}`,
    BOOKING_LIMITS.bookingsPerEmailPerDay,
    86_400,
    "This email address has reached today's booking limit.",
  );
  const owner = await loadBookingOwner(slug);
  if (!owner) throw missing();
  const fetchImpl = context.fetchImpl ?? fetch;
  const result = await withBookingLock(page.userId, async () => {
    const busy = await loadBusy(page.userId, busyWindow.from, busyWindow.to);
    if (!isOpenSlot(page.rules, start, now, busy)) throw new CrmError("conflict", SLOT_TAKEN, 409, { field: "start" });
    const sender = await openOwnerSender(owner, fetchImpl);
    if (sender.own.has(email)) {
      throw invalid("That's the organiser's address. Use your own email.", "email");
    }
    const live = await liveBusy(page, sender, start, end, fetchImpl);
    if (live.length > 0 && !isOpenSlot(page.rules, start, now, [...busy, ...live])) {
      throw new CrmError("conflict", SLOT_TAKEN, 409, { field: "start" });
    }
    try {
      return await sendInvite(owner, sender, {
        subject: bookingSubject(page.ownerName, name),
        start: new Date(start),
        end: new Date(end),
        timeZone: page.timeZone,
        guests: [{ email, name }],
        notes: note ? `Note from ${name}:\n${note}` : null,
        link: sender.meetingLink,
        transactionId: randomUUID(),
        createContacts: true,
        fetchImpl,
        provenance: { operation: "booking_page", source: "booking" },
        activity: (contact, details) => ({
          title: "Booked via your booking page",
          body: [
            details.when,
            details.link ? `Join: ${details.link}` : null,
            note ? `\nNote from ${name}:\n${note}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          metadata: {
            source: "booking",
            kind: "booking",
            eventId: details.eventId,
            providerEventId: details.providerEventId,
            startsAt: details.startsAt,
            page: bookingPath(page.slug),
          },
        }),
      });
    } catch (error) {
      throw await failed(owner, error);
    }
  });
  if (result.warning) console.error("Booking saved with a warning", result.warning);
  await recordBookingError(owner, null).catch(() => undefined);
  return {
    subject: result.subject,
    title: page.title,
    ownerName: page.ownerName,
    name,
    email,
    startsAt: result.startsAt,
    endsAt: result.endsAt,
    durationMinutes: page.durationMinutes,
    timeZone: visitorZone(input.timeZone, page.timeZone),
    pageTimeZone: page.timeZone,
    meetingKind: page.meetingKind,
  };
}

async function failed(owner: UserActor, error: unknown) {
  console.error("Booking failed", error instanceof Error ? error.message : error);
  await recordBookingError(owner, unavailable(error)).catch(() => undefined);
  return new CrmError("unavailable", BOOKING_UNAVAILABLE, 503);
}

async function openOwnerSender(owner: UserActor, fetchImpl: typeof fetch) {
  try {
    return await openInviteSender(owner, { fetchImpl });
  } catch (error) {
    throw await failed(owner, error);
  }
}

export function clientIp(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip")?.trim() || "unknown";
  return ip.slice(0, 64);
}
