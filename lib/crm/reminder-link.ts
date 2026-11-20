import { orbitLink, orbitPath } from "@/lib/chat/task-text";

export const MAX_REMINDER_LINK = 500;
export const REMINDER_LINK_LABEL = "Open message";

const ORBIT_PATH = /^\/[A-Za-z0-9][^\p{C}\p{Z}\\]*$/u;

export function isReminderLink(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_REMINDER_LINK && ORBIT_PATH.test(value);
}

export function reminderLinkMarkdown(link: string) {
  const path = link.replace(/[()[\]<>"]/g, (char) => encodeURIComponent(char).replace(/[()]/g, (paren) => (paren === "(" ? "%28" : "%29")));
  return orbitPath(path) ? orbitLink(REMINDER_LINK_LABEL, path) : null;
}
