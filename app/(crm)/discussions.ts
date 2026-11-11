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
import { removeTaskParticipant, updateTask } from "@/lib/crm/tasks";
import type { TaskWrite } from "@/lib/crm/types";

const SESSION_ENDED = "Your session ended. Sign in again.";

export async function openDiscussionAction(subject: ChatSubject): Promise<ChatResult<{ conversationId: string }>> {
  try {
    const actor = await getUserActor();
    if (!actor) return { error: SESSION_ENDED };
    return { ok: true, ...(await openDiscussion(actor, subject)) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Opening a discussion failed", error);
    return { error: "Couldn't send. Try again." };
  }
}

export type TaskDetails = Pick<TaskWrite, "title" | "description" | "dueAt" | "remindMinutes">;

function details(input: TaskDetails): TaskDetails {
  const write: TaskDetails = {};
  if (typeof input?.title === "string") write.title = input.title;
  if (input?.description === null || typeof input?.description === "string") write.description = input.description;
  if (input?.dueAt === null || typeof input?.dueAt === "string") write.dueAt = input.dueAt;
  if (input?.remindMinutes === null || typeof input?.remindMinutes === "number") write.remindMinutes = input.remindMinutes;
  return write;
}

export async function saveTaskDetailsAction(id: string, input: TaskDetails): Promise<{ ok?: true; error?: string }> {
  const actor = await getUserActor();
  if (!actor) return { error: SESSION_ENDED };
  if (!isUuid(id)) return { error: "Couldn't save. Try again." };
  const write = details(input);
  if (Object.keys(write).length === 0) return { ok: true };
  try {
    await updateTask(actor, id, write, {
      provenance: { operation: "update_task", source: "web" },
    });
    if (clickupToken()) {
      after(async () => {
        try {
          await pushClickUpTask(actor, id);
        } catch (error) {
          console.error("ClickUp push failed", error);
        }
      });
    }
    revalidatePath(TASKS_PATH);
    return { ok: true };
  } catch (error) {
    return { error: actionError(error).error };
  }
}

export async function untagTaskAction(taskId: string, userId: string): Promise<{ ok?: true; error?: string }> {
  const actor = await getUserActor();
  if (!actor) return { error: SESSION_ENDED };
  try {
    await removeTaskParticipant(actor, taskId, userId, {
      operation: "untag_task",
      source: "web",
    });
    revalidatePath(TASKS_PATH);
    return { ok: true };
  } catch (error) {
    return { error: actionError(error).error };
  }
}
