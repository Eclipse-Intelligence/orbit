import type { Task } from "@/lib/crm/types";

export const MAIL_SUGGESTION_NOTE = "Suggested after an email arrived.";

export function canMarkSpam(task: Pick<Task, "description" | "mailThread" | "archivedAt" | "completedAt">) {
  return Boolean(task.mailThread?.readable && !task.archivedAt && !task.completedAt && task.description?.startsWith(MAIL_SUGGESTION_NOTE));
}
