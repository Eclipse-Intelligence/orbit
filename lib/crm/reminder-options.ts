export const REMINDER_OPTIONS = [
  { minutes: 0, label: "At the due time", short: "At due time" },
  { minutes: 5, label: "5 minutes before", short: "5 min before" },
  { minutes: 10, label: "10 minutes before", short: "10 min before" },
  { minutes: 15, label: "15 minutes before", short: "15 min before" },
  { minutes: 30, label: "30 minutes before", short: "30 min before" },
  { minutes: 60, label: "1 hour before", short: "1 hour before" },
  { minutes: 120, label: "2 hours before", short: "2 hours before" },
  { minutes: 1440, label: "24 hours before", short: "24 hours before" },
  { minutes: 2880, label: "2 days before", short: "2 days before" },
  { minutes: 10080, label: "1 week before", short: "1 week before" },
] as const;

export const REMINDER_MINUTES: readonly number[] = REMINDER_OPTIONS.map((option) => option.minutes);

export const REMINDER_LOOKAHEAD_MS = 20 * 60 * 1000;

export function isReminderMinutes(value: unknown): value is number {
  return typeof value === "number" && REMINDER_MINUTES.includes(value);
}

export function reminderLabel(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined) return null;
  return REMINDER_OPTIONS.find((option) => option.minutes === minutes)?.label ?? `${minutes} minutes before`;
}

export function reminderFireAt(dueAt: string, minutes: number) {
  return new Date(dueAt).getTime() - minutes * 60 * 1000;
}

export function reminderHeadline(dueAt: string, now = Date.now()) {
  const minutes = Math.round((new Date(dueAt).getTime() - now) / 60000);
  if (minutes <= 0) return "Task due now";
  if (minutes < 60) return `Task due in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Task due in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `Task due in ${days} days`;
}
