import { getBookingPage } from "@/lib/booking/pages";
import { bookingPath } from "@/lib/booking/rules";
import { generateSlots, type BusyInterval, type SlotRules } from "@/lib/booking/slots";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { mailOrigin } from "@/lib/mail/origin";
import { zonedParts } from "@/lib/time";

export const TIMES_MARK = "[[times]]";

const DAY_MS = 86_400_000;
const LOOK_AHEAD_DAYS = 14;
const MIN_NOTICE_MINUTES = 240;
const OFFERED = 3;

async function ownBusy(actor: UserActor, from: number, to: number): Promise<BusyInterval[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ starts_at: Date; ends_at: Date }>(
      `select e.starts_at, e.ends_at from crm.calendar_events e
       join crm.calendars c on c.id = e.calendar_id and c.user_id = e.user_id
       where e.user_id = $1 and not e.is_cancelled and coalesce(lower(e.show_as), 'busy') <> 'free'
         and e.starts_at < $3 and e.ends_at > $2
       order by e.starts_at limit 2000`,
      [actor.userId, new Date(from).toISOString(), new Date(to).toISOString()],
    );
    return result.rows.map((row) => ({ start: new Date(row.starts_at).getTime(), end: new Date(row.ends_at).getTime() }));
  });
}

type SchedulingSetup = { rules: SlotRules; link: string | null };

async function schedulingSetup(actor: UserActor): Promise<SchedulingSetup> {
  const page = await getBookingPage(actor);
  const origin = mailOrigin();
  return {
    rules: {
      weeklyHours: page.weeklyHours,
      durationMinutes: page.durationMinutes,
      bufferMinutes: page.bufferMinutes,
      minNoticeMinutes: Math.max(page.minNoticeMinutes, MIN_NOTICE_MINUTES),
      horizonDays: Math.max(page.horizonDays, LOOK_AHEAD_DAYS),
      timeZone: page.timeZone,
    },
    link: page.exists && page.enabled && origin ? `${origin}${bookingPath(page.slug)}` : null,
  };
}

function dayOf(instant: number, timeZone: string) {
  const parts = zonedParts(new Date(instant), timeZone);
  return { key: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour };
}

export function pickTimes(rules: SlotRules, busy: BusyInterval[], now: number, count = OFFERED) {
  const slots = generateSlots(rules, { from: now, to: now + LOOK_AHEAD_DAYS * DAY_MS, now, busy });
  const byDay = new Map<string, number[]>();
  for (const slot of slots) {
    const { key } = dayOf(slot, rules.timeZone);
    byDay.set(key, [...(byDay.get(key) ?? []), slot]);
  }
  const picked: number[] = [];
  for (const daySlots of byDay.values()) {
    if (picked.length >= count) break;
    const comfortable = daySlots.filter((slot) => {
      const hour = dayOf(slot, rules.timeZone).hour;
      return hour >= 10 && hour < 16;
    });
    const pool = comfortable.length ? comfortable : daySlots;
    const position = [0, 0.5, 1][picked.length % 3];
    picked.push(pool[Math.round((pool.length - 1) * position)]);
  }
  return picked.sort((a, b) => a - b);
}

export function timesStillFree(rules: SlotRules, slots: number[], busy: BusyInterval[], now: number) {
  const duration = rules.durationMinutes * 60_000;
  const buffer = rules.bufferMinutes * 60_000;
  return slots.every(
    (slot) => slot > now + 60 * 60_000 && !busy.some((interval) => interval.start - buffer < slot + duration && interval.end + buffer > slot),
  );
}

function zoneName(timeZone: string) {
  return timeZone === "Europe/London" ? "UK time" : `${timeZone.split("/").pop()?.replace(/_/g, " ")} time`;
}

function timesText(slots: number[], rules: SlotRules, link: string | null) {
  const when = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: rules.timeZone,
  });
  const lines = slots.map((slot) => when.format(new Date(slot)).replace(/ at /, ", "));
  const offer = lines.length
    ? `${lines.join("\n")}\n(${zoneName(rules.timeZone)}, ${rules.durationMinutes} minutes)`
    : "[suggest some times]";
  return link ? `${offer}\n\nOr pick any time that suits you here: ${link}` : offer;
}

export function renderTimes(template: string, slots: number[], rules: SlotRules, link: string | null) {
  return template.replace(TIMES_MARK, timesText(slots, rules, link));
}

export async function offerTimes(actor: UserActor, template: string, now = Date.now()) {
  const setup = await schedulingSetup(actor);
  const busy = await ownBusy(actor, now, now + (LOOK_AHEAD_DAYS + 1) * DAY_MS);
  const slots = pickTimes(setup.rules, busy, now);
  return { body: renderTimes(template, slots, setup.rules, setup.link), slots };
}

export async function refreshTimes(actor: UserActor, template: string, offered: number[], now = Date.now()) {
  const setup = await schedulingSetup(actor);
  const busy = await ownBusy(actor, now, now + (LOOK_AHEAD_DAYS + 1) * DAY_MS);
  if (offered.length && timesStillFree(setup.rules, offered, busy, now)) return null;
  const slots = pickTimes(setup.rules, busy, now);
  return { body: renderTimes(template, slots, setup.rules, setup.link), slots };
}
