import { addWorkingDays, dayKeyAt, nextWorkingDay, nonWorkingReason, shiftDay, wallClockAt, weekday } from "@/lib/crm/working-days";
import { laterDetail, laterOptions } from "@/lib/mail/later";
import { appTimeZone, zonedParts } from "@/lib/time";

export type SnoozeChoice = { id: string; label: string; detail: string; at: string };

export type SnoozeDue = string | null | { dueAt: string | null; dueHasTime?: boolean | null };

function timing(due: SnoozeDue, timeZone: string) {
  if (due === null || typeof due === "string") {
    const wall = due ? zonedParts(new Date(due), timeZone) : null;
    return { dueAt: due, timed: Boolean(wall && (wall.hour !== 0 || wall.minute !== 0)) };
  }
  return { dueAt: due.dueAt, timed: Boolean(due.dueAt && due.dueHasTime) };
}

const DAY_ONLY = new Map<string, Intl.DateTimeFormat>();

function dayDetail(at: Date, nowMs: number, timeZone: string) {
  const sameWeek = at.getTime() - nowMs < 6 * 86_400_000;
  const key = `${timeZone}|${sameWeek}`;
  let format = DAY_ONLY.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", sameWeek ? { weekday: "short", timeZone } : { weekday: "short", day: "numeric", month: "short", timeZone });
    DAY_ONLY.set(key, format);
  }
  return format.format(at);
}

export function onWorkingDay(at: Date, timeZone = appTimeZone()) {
  const key = dayKeyAt(at, timeZone);
  if (!nonWorkingReason(key)) return at;
  const wall = zonedParts(at, timeZone);
  return new Date(wallClockAt(nextWorkingDay(key), wall.hour, wall.minute, timeZone));
}

export function snoozeDetail(at: Date | string, timed: boolean, nowMs: number, timeZone = appTimeZone()) {
  const date = new Date(at);
  return timed ? laterDetail(date, nowMs, timeZone) : dayDetail(date, nowMs, timeZone);
}

export function taskSnoozeChoices(due: SnoozeDue, now: Date, timeZone = appTimeZone()): SnoozeChoice[] {
  const { dueAt, timed } = timing(due, timeZone);
  const wall = dueAt && timed ? zonedParts(new Date(dueAt), timeZone) : null;
  const hour = wall ? wall.hour : 9;
  const minute = wall ? wall.minute : 0;
  const today = dayKeyAt(now, timeZone);
  const next = addWorkingDays(today, 1);
  const monday = shiftDay(today, (8 - weekday(today)) % 7 || 7);
  const nextWeek = nextWorkingDay(monday);
  const choices: { id: string; label: string; at: Date }[] = [
    {
      id: "tomorrow",
      label: next === shiftDay(today, 1) ? "Tomorrow" : "Next working day",
      at: new Date(wallClockAt(next, hour, minute, timeZone)),
    },
  ];
  if (nextWeek !== next) choices.push({ id: "next-week", label: "Next week", at: new Date(wallClockAt(nextWeek, hour, minute, timeZone)) });
  return choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    detail: snoozeDetail(choice.at, timed, now.getTime(), timeZone),
    at: choice.at.toISOString(),
  }));
}

export function taskRemindChoices(due: SnoozeDue, now: Date, timeZone = appTimeZone()): SnoozeChoice[] {
  const { timed } = timing(due, timeZone);
  const later = timed ? laterOptions(now.getTime(), timeZone).filter((option) => option.id === "later") : [];
  return [...later, ...taskSnoozeChoices(due, now, timeZone)];
}
