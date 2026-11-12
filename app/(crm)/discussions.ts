"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import type { ChatResult, ChatSubject } from "@/lib/chat/types";
import { clickupToken } from "@/lib/clickup";
import { actionError } from "@/lib/companies";
import { openDiscussion } from "@/lib/crm/chat";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { getTask, listTaskParticipants, removeTaskParticipant, updateTask } from "@/lib/crm/tasks";
import type { Task, TaskWrite } from "@/lib/crm/types";
import { revalidateRecordPages } from "@/lib/revalidate";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { toIsoInstant } from "@/lib/time";

const SESSION_ENDED = "Your session ended. Sign in again.";

export async function openDiscussionAction(subject: ChatSubject): Promise<ChatResult<{ conversationId: string }>> {
  try {
    const actor = await getUserActor();
    if (!actor) return { error: SESSION_ENDED };
    return { ok: true, ...(await openDiscussion(actor, subject)) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Opening a discussion failed", error);
    return { error: "Couldn't open the discussion. Try again." };
  }
}

export type TaskDetails = Pick<TaskWrite, "title" | "description" | "dueAt" | "dueDate" | "remindMinutes" | "durationMinutes">;

function details(input: TaskDetails): TaskDetails {
  const write: TaskDetails = {};
  if (typeof input?.title === "string") write.title = input.title;
  if (input?.description === null || typeof input?.description === "string") write.description = input.description;
  if (input?.dueAt === null || typeof input?.dueAt === "string") write.dueAt = input.dueAt;
  else if (input?.dueDate === null || typeof input?.dueDate === "string") write.dueDate = input.dueDate;
  if (typeof input?.durationMinutes === "number") write.durationMinutes = input.durationMinutes;
  if (input?.remindMinutes === null || typeof input?.remindMinutes === "number") write.remindMinutes = input.remindMinutes;
  return write;
}

function sameInstant(left: string | null, right: string | null) {
  if (left === null || right === null) return left === right;
  return toIsoInstant(left) === toIsoInstant(right) || left === right;
}

function changed(task: Task, write: TaskDetails): TaskDetails {
  const next: TaskDetails = {};
  if (write.title !== undefined && write.title.trim() !== task.title) next.title = write.title;
  if (write.description !== undefined && (write.description?.trim() || null) !== (task.description?.trim() || null)) next.description = write.description;
  if (write.dueAt !== undefined && (!sameInstant(write.dueAt, task.dueAt) || (write.dueAt !== null && !task.dueHasTime))) next.dueAt = write.dueAt;
  if (write.dueDate !== undefined && (write.dueDate === null ? task.dueAt !== null : task.dueHasTime || write.dueDate !== task.dueDate)) next.dueDate = write.dueDate;
  if (write.durationMinutes !== undefined && write.durationMinutes !== task.durationMinutes) next.durationMinutes = write.durationMinutes;
  if (write.remindMinutes !== undefined && write.remindMinutes !== task.remindMinutes) next.remindMinutes = write.remindMinutes;
  return next;
}

function refresh() {
  revalidatePath("/");
  revalidateRecordPages();
  revalidatePath("/contacts");
  revalidatePath("/opportunities");
  revalidatePath("/boards", "layout");
  revalidatePath(SETTINGS_PATHS.activity);
  revalidatePath(TASKS_PATH);
}

export async function saveTaskDetailsAction(id: string, input: TaskDetails): Promise<{ ok?: true; error?: string }> {
  const actor = await getUserActor();
  if (!actor) return { error: SESSION_ENDED };
  if (!isUuid(id)) return { error: "Couldn't save. Try again." };
  try {
    const write = changed(await getTask(actor, id), details(input));
    if (Object.keys(write).length === 0) return { ok: true };
    await updateTask(actor, id, write, { provenance: { operation: "update_task", source: "web" } });
    if (clickupToken()) {
      after(async () => {
        try {
          await pushClickUpTask(actor, id);
        } catch (error) {
          console.error("ClickUp push failed", error);
        }
      });
    }
    refresh();
    return { ok: true };
  } catch (error) {
    return { error: actionError(error).error };
  }
}

export async function untagTaskAction(taskId: string, userId: string): Promise<{ ok?: true; error?: string }> {
  const actor = await getUserActor();
  if (!actor) return { error: SESSION_ENDED };
  if (!isUuid(taskId) || !isUuid(userId)) return { error: "Couldn't remove them. Try again." };
  try {
    await removeTaskParticipant(actor, taskId, userId, { operation: "untag_task", source: "web" });
    refresh();
    return { ok: true };
  } catch (error) {
    return { error: actionError(error).error };
  }
}

export async function taskTaggedAction(taskId: string): Promise<{ tagged?: string[]; error?: string }> {
  const actor = await getUserActor();
  if (!actor) return { error: SESSION_ENDED };
  if (!isUuid(taskId)) return { tagged: [] };
  try {
    return { tagged: (await listTaskParticipants(actor, [taskId]))[taskId] ?? [] };
  } catch (error) {
    return { error: actionError(error).error };
  }
}
