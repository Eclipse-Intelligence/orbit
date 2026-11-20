export const MAX_REMINDER_LINK = 500;

const ORBIT_PATH = /^\/[A-Za-z0-9][^\p{C}\p{Z}\\]*$/u;

export function isReminderLink(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_REMINDER_LINK && ORBIT_PATH.test(value);
}
