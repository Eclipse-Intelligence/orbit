import { createTaskWithClickUp } from "@/lib/crm/clickup";
import { isUuid } from "@/lib/crm/mutate";
import { isReminderMinutes } from "@/lib/crm/reminder-options";
import { deleteReminder } from "@/lib/crm/reminders";
import { isTaskDuration } from "@/lib/crm/task-time";
import type { UserActor } from "@/lib/crm/types";
import { REMINDER_NOT_REMOVED } from "@/lib/reminders-card";
import type { RepeatInput } from "@/lib/task-repeat";

export { REMINDER_NOT_REMOVED };

export type PadTaskInput = {
  title: string;
  dueAt: string | null;
  remindMinutes: number | null;
  companyId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  clickupListId: string | null;
  ownerId?: string | null;
  durationMinutes?: number | null;
  mailThreadKey?: string | null;
  description?: string | null;
  docIds?: string[];
  repeat?: RepeatInput;
  key?: string;
  fromReminderId?: string | null;
};

export type PadTaskResult = { ok: true; warning?: string; reminderError?: string };

function padLink(value: unknown) {
  return typeof value === "string" && isUuid(value) ? value : null;
}

function padLinks(input: { companyId?: unknown; contactId?: unknown; opportunityId?: unknown }) {
  return Object.fromEntries(
    (["companyId", "contactId", "opportunityId"] as const).flatMap((key) => (input[key] === undefined ? [] : [[key, padLink(input[key])]])),
  ) as { companyId?: string | null; contactId?: string | null; opportunityId?: string | null };
}

export async function addPadTask(user: UserActor, input: PadTaskInput, options: { removeReminder?: typeof deleteReminder } = {}): Promise<PadTaskResult> {
  const due = typeof input.dueAt === "string" && input.dueAt ? input.dueAt : null;
  const timed = Boolean(due && due.includes("T"));
  const created = await createTaskWithClickUp(
    user,
    {
      title: typeof input.title === "string" ? input.title : "",
      ...(timed ? { dueAt: due } : { dueDate: due }),
      remindMinutes: due && isReminderMinutes(input.remindMinutes) ? input.remindMinutes : null,
      ...(isTaskDuration(input.durationMinutes) ? { durationMinutes: input.durationMinutes } : {}),
      ...padLinks(input),
      ownerId: typeof input.ownerId === "string" && isUuid(input.ownerId) ? input.ownerId : user.userId,
      ...(typeof input.mailThreadKey === "string" && input.mailThreadKey ? { mailThreadKey: input.mailThreadKey } : {}),
      ...(typeof input.description === "string" && input.description.trim() ? { description: input.description } : {}),
      ...(Array.isArray(input.docIds) && input.docIds.length > 0 ? { docIds: input.docIds } : {}),
      priority: "normal",
      ...(input.repeat && typeof input.repeat === "object" ? { repeat: input.repeat } : {}),
    },
    input.clickupListId || null,
    { provenance: { operation: "create_task", source: "web" }, ...(typeof input.key === "string" && isUuid(input.key) ? { idempotencyKey: input.key } : {}) },
  );
  const result: PadTaskResult = created.clickupError ? { ok: true, warning: `Saved. ClickUp sync failed and will retry: ${created.clickupError}` } : { ok: true };
  const reminderId = typeof input.fromReminderId === "string" && input.fromReminderId ? input.fromReminderId : null;
  if (!reminderId) return result;
  try {
    await (options.removeReminder ?? deleteReminder)(user, reminderId);
    return result;
  } catch (error) {
    console.error("Removing the reminder after Turn into task failed", error instanceof Error ? error.message : error);
    return { ...result, reminderError: REMINDER_NOT_REMOVED };
  }
}
