"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { clickupToken } from "@/lib/clickup";
import { actionError } from "@/lib/companies";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { getInviteSetup, type InviteSetup } from "@/lib/crm/invites";
import { isUuid } from "@/lib/crm/mutate";
import { markTaskSpam } from "@/lib/mail/filing";
import { completeTaskWithOutcome, relinkTaskUndoable, taskContext, undoTaskLinkChange, type LinkChange, type TaskContext, type TaskOutcome } from "@/lib/crm/task-act";
import { setTaskPrepareSettings, type TaskPrepareSettings } from "@/lib/crm/task-prepare";
import { TASKS_PATH } from "@/lib/crm/task-views";
import type { UserActor } from "@/lib/crm/types";
import { TASK_LOOKUP_FAILED, taskActorOrError } from "@/lib/crm/workspaces";
import { revalidateRecordPages } from "@/lib/revalidate";

const SIGN_IN = "Sign in again.";

function refresh() {
  revalidatePath(TASKS_PATH);
  revalidateRecordPages();
}

function pushLater(user: UserActor, ids: string[]) {
  if (!clickupToken()) return;
  try {
    after(async () => {
      for (const id of ids) {
        try {
          await pushClickUpTask(user, id);
        } catch (error) {
          console.error("ClickUp push failed", error);
        }
      }
    });
  } catch (error) {
    console.error("ClickUp push failed", error);
  }
}

async function taskUser(id: unknown) {
  const user = await getUserActor();
  if (!user) return null;
  return (await taskActorOrError(user, id)).actor ?? TASK_LOOKUP_FAILED;
}

export async function taskContextAction(id: string): Promise<{ context?: TaskContext; error?: string }> {
  const user = await taskUser(id);
  if (!user) return { error: SIGN_IN };
  if (typeof user === "string") return { error: user };
  if (typeof id !== "string" || !isUuid(id)) return { error: "Task not found." };
  try {
    return { context: await taskContext(user, id) };
  } catch (error) {
    return actionError(error);
  }
}

export async function taskInviteSetupAction(): Promise<{ setup?: InviteSetup; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: SIGN_IN };
  try {
    return { setup: await getInviteSetup(user) };
  } catch (error) {
    return actionError(error);
  }
}

export async function relinkTaskAction(id: string, change: LinkChange): Promise<{ ok?: boolean; undo?: string | null; error?: string }> {
  const user = await taskUser(id);
  if (!user) return { error: SIGN_IN };
  if (typeof user === "string") return { error: user };
  if (typeof id !== "string" || !isUuid(id) || !change || typeof change !== "object") return { error: "Couldn't link the task. Try again." };
  try {
    const result = await relinkTaskUndoable(
      user,
      id,
      { companyId: change.companyId, contactId: change.contactId, opportunityId: change.opportunityId, ...(change.mailThreadKey === null ? { mailThreadKey: null } : {}) },
      { operation: "link_task", source: "web" },
    );
    pushLater(user, [id]);
    refresh();
    return { ok: true, undo: result.undo };
  } catch (error) {
    return actionError(error);
  }
}

export async function undoTaskLinkAction(id: string, eventId: string): Promise<{ ok?: boolean; error?: string }> {
  const user = await taskUser(id);
  if (!user) return { error: SIGN_IN };
  if (typeof user === "string") return { error: user };
  if (typeof id !== "string" || !isUuid(id) || typeof eventId !== "string" || !isUuid(eventId)) return { error: "Couldn't undo. Try again." };
  try {
    await undoTaskLinkChange(user, id, eventId);
    pushLater(user, [id]);
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function completeTaskWithOutcomeAction(id: string, outcome: TaskOutcome): Promise<{ ok?: boolean; next?: boolean; logged?: boolean; completed?: boolean; error?: string }> {
  const user = await taskUser(id);
  if (!user) return { error: SIGN_IN };
  if (typeof user === "string") return { error: user };
  if (typeof id !== "string" || !isUuid(id) || !outcome || typeof outcome !== "object") return { error: "Couldn't save. Try again." };
  try {
    const saved = await completeTaskWithOutcome(user, id, outcome);
    pushLater(user, saved.next?.clickupListId ? [id, saved.next.id] : [id]);
    refresh();
    return { ok: true, next: Boolean(saved.next), logged: Boolean(saved.activityId), completed: Boolean(saved.task.completedAt) };
  } catch (error) {
    return actionError(error);
  }
}

export async function setTaskPrepareAction(input: { prepareEachMorning: boolean }): Promise<{ settings?: TaskPrepareSettings; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: SIGN_IN };
  try {
    return { settings: await setTaskPrepareSettings(user, { prepareEachMorning: input?.prepareEachMorning }) };
  } catch (error) {
    return actionError(error);
  }
}

export async function markTaskSpamAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const user = await taskUser(id);
  if (!user) return { error: SIGN_IN };
  if (typeof user === "string") return { error: user };
  if (typeof id !== "string" || !isUuid(id)) return { error: "Couldn't mark it as spam. Try again." };
  try {
    await markTaskSpam(user, id);
    refresh();
    revalidatePath("/capture");
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}
