import { dateKey, shiftDateKey, weekday } from "@/lib/calendar-view";
import { canonicalEmail } from "@/lib/crm/normalize";
import { appTimeZone, zonedParts } from "@/lib/time";

const INVITE_TITLE_PREFIX = "Eclipse";
export const INVITE_DURATIONS = [15, 30, 45, 60, 90] as const;
export const INVITE_DEFAULT_DURATION = 30;
export const INVITE_GUESTS_MAX = 50;
export const INVITE_TITLE_MAX = 200;
export const INVITE_NOTES_MAX = 4000;
export const INVITE_COMMENT_MAX = 1000;
export const MEETING_LINK_MAX = 500;
const SLOT_MINUTES = 15;
const WORK_START = 9 * 60;
const LAST_START = 17 * 60 + 30;

type MeetingLinkCheck = { ok: true; link: string | null } | { ok: false; error: string };

export function checkMeetingLink(value: string): MeetingLinkCheck {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, link: null };
  if (trimmed.length > MEETING_LINK_MAX) {
    return { ok: false, error: `Keep the link under ${MEETING_LINK_MAX} characters.` };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter the full link, starting with https://." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Use a secure link that starts with https://." };
  if (url.username || url.password) return { ok: false, error: "Remove the sign-in details from the link." };
  if (!url.hostname.includes(".")) return { ok: false, error: "Enter the full link, starting with https://." };
  if (url.href.length > MEETING_LINK_MAX) {
    return { ok: false, error: `Keep the link under ${MEETING_LINK_MAX} characters.` };
  }
  return { ok: true, link: url.href };
}

export function guestEmail(value: string) {
  return canonicalEmail(value);
}

export function inviteTitle(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed ? `${INVITE_TITLE_PREFIX} × ${trimmed}` : "";
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function timeLabel(minutes: number) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export const TIME_OPTIONS = Array.from({ length: (24 * 60) / SLOT_MINUTES }, (_, index) =>
  timeLabel(index * SLOT_MINUTES),
);

export function snapTime(minutes: number) {
  const clamped = Math.min(Math.max(Math.floor(minutes), 0), 24 * 60 - SLOT_MINUTES);
  return timeLabel(Math.floor(clamped / SLOT_MINUTES) * SLOT_MINUTES);
}

function isWeekday(key: string) {
  return weekday(key) < 5;
}

function nextWeekday(key: string) {
  let next = shiftDateKey(key, 1);
  while (!isWeekday(next)) next = shiftDateKey(next, 1);
  return next;
}

export function defaultInviteSlot(now = Date.now(), timeZone = appTimeZone()) {
  const today = dateKey(now, timeZone);
  const parts = zonedParts(new Date(now), timeZone);
  const next = Math.floor((parts.hour * 60 + parts.minute) / 30) * 30 + 30;
  if (isWeekday(today) && next <= LAST_START) {
    return { date: today, time: timeLabel(Math.max(next, WORK_START)) };
  }
  return { date: nextWeekday(today), time: timeLabel(WORK_START) };
}
