import { addWorkingDays, dayKeyAt, nextWorkingDay, nonWorkingReason, shiftDay, wallClockAt, weekday } from "@/lib/crm/working-days";
import { laterDetail } from "@/lib/mail/later";
import { appTimeZone, zonedParts } from "@/lib/time";

export type SnoozeChoice = { id: string; label: string; detail: string; at: string };

export function onWorkingDay(at: Date, timeZone = appTimeZone()) {
  const key = dayKeyAt(at, timeZone);
  if (!nonWorkingReason(key)) return at;
  const wall = zonedParts(at, timeZone);
  return new Date(wallClockAt(nextWorkingDay(key), wall.hour, wall.minute, timeZone));
}

export function taskSnoozeChoices(dueAt: string | null, now: Date, timeZone = appTimeZone()): SnoozeChoice[] {
  const wall = dueAt ? zonedParts(new Date(dueAt), timeZone) : null;
  const midnight = !wall || (wall.hour === 0 && wall.minute === 0);
  const hour = midnight ? 9 : wall.hour;
  const minute = midnight ? 0 : wall.minute;
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
    detail: laterDetail(choice.at, now.getTime(), timeZone),
    at: choice.at.toISOString(),
  }));
}
