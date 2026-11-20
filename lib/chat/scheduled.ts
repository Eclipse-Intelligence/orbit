import type { ChatScheduledItem } from "@/lib/chat/types";
import { appTimeZone, zonedParts, zonedTimeToDate } from "@/lib/time";

const SEND_LATER_HOUR = 9;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type SendLaterChoice = { id: "hour" | "tomorrow" | "monday"; label: string; detail: string; at: string };

function clock(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
}

function dayDetail(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone })
    .formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => part.value)
    .join(" ");
}

function morningAfter(nowMs: number, days: number, timeZone: string) {
  const today = zonedParts(new Date(nowMs), timeZone);
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day) + days * DAY_MS);
  return zonedTimeToDate({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: SEND_LATER_HOUR, minute: 0, second: 0 }, timeZone);
}

export function daysToMonday(nowMs: number, timeZone = appTimeZone()) {
  const today = zonedParts(new Date(nowMs), timeZone);
  const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  return (8 - weekday) % 7 || 7;
}

export function sendLaterChoices(nowMs: number, timeZone = appTimeZone()): SendLaterChoice[] {
  const tomorrow = morningAfter(nowMs, 1, timeZone);
  const hour = new Date(nowMs + HOUR_MS);
  const choices: SendLaterChoice[] = [
    { id: "hour", label: "In 1 hour", detail: clock(hour, timeZone), at: hour.toISOString() },
    { id: "tomorrow", label: `Tomorrow at ${clock(tomorrow, timeZone)}`, detail: dayDetail(tomorrow, timeZone), at: tomorrow.toISOString() },
  ];
  const days = daysToMonday(nowMs, timeZone);
  if (days > 1) {
    const monday = morningAfter(nowMs, days, timeZone);
    choices.push({ id: "monday", label: `Monday at ${clock(monday, timeZone)}`, detail: dayDetail(monday, timeZone), at: monday.toISOString() });
  }
  return choices;
}

export function scheduledWhen(sendAt: string | Date, nowMs: number, timeZone = appTimeZone(), options: { sentence?: boolean } = {}) {
  const date = new Date(sendAt);
  const wall = zonedParts(date, timeZone);
  const today = zonedParts(new Date(nowMs), timeZone);
  const gap = Math.round((Date.UTC(wall.year, wall.month - 1, wall.day) - Date.UTC(today.year, today.month - 1, today.day)) / DAY_MS);
  const time = clock(date, timeZone);
  if (gap === 0) return `${options.sentence ? "today" : "Today"} at ${time}`;
  if (gap === 1) return `${options.sentence ? "tomorrow" : "Tomorrow"} at ${time}`;
  const near = gap > 0 && gap < 7;
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: near ? "long" : "short",
    ...(near ? {} : { day: "numeric", month: "short" }),
    ...(near || wall.year === today.year ? {} : { year: "numeric" }),
    timeZone,
  }).formatToParts(date);
  const day = parts
    .filter((part) => part.type !== "literal")
    .map((part) => part.value)
    .join(" ");
  return `${day} at ${time}`;
}

export function scheduledHere(items: ChatScheduledItem[], conversationId: string, parentId: string | null) {
  return items.filter((item) => item.conversation.id === conversationId && item.parentId === parentId);
}

export function scheduledPlace(item: Pick<ChatScheduledItem, "conversation" | "parentId">) {
  const { kind, name } = item.conversation;
  const place = name === null ? "A conversation you've left" : kind === "room" ? `#${name}` : name;
  return item.parentId ? `Reply in ${place}` : place;
}
