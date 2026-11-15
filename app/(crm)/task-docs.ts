"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { CrmError } from "@/lib/crm/errors";
import { changeTaskDoc, LINK_DOC_FAILED, UNLINK_DOC_FAILED } from "@/lib/crm/task-doc-links";
import { listTaskDocs, type TaskDocEntry } from "@/lib/crm/task-docs";
import { TASKS_PATH } from "@/lib/crm/task-views";
import type { TaskDoc } from "@/lib/crm/types";
import { taskActorOrError } from "@/lib/crm/workspaces";
import type { DocPick } from "@/lib/docs/client-types";
import { docPickTargets } from "@/lib/docs/view";
import { revalidateRecordPages } from "@/lib/revalidate";

const SIGN_IN = "Sign in again.";

async function actorFor(taskId: string | null | undefined) {
  const user = await getUserActor();
  if (!user) return { error: SIGN_IN };
  if (!taskId) return { actor: user };
  const resolved = await taskActorOrError(user, taskId);
  return resolved.actor ? { actor: resolved.actor } : { error: resolved.error };
}

export async function searchTaskDocsAction(query: string, taskId: string | null = null): Promise<{ docs?: DocPick[]; error?: string }> {
  if (typeof query !== "string") return { docs: [] };
  const found = await actorFor(taskId);
  if (!found.actor) return { error: found.error };
  try {
    return { docs: await docPickTargets(found.actor, query) };
  } catch {
    return { error: "Couldn't search. Try again." };
  }
}

export async function taskDocsAction(taskId: string): Promise<{ docs?: TaskDocEntry[]; error?: string }> {
  const found = await actorFor(taskId);
  if (!found.actor) return { error: found.error };
  try {
    return { docs: await listTaskDocs(found.actor, taskId) };
  } catch (error) {
    return actionError(error);
  }
}

async function change(taskId: string, pageId: string, kind: "link" | "unlink"): Promise<{ docs?: TaskDoc[]; error?: string }> {
  const found = await actorFor(taskId);
  if (!found.actor) return { error: found.error };
  try {
    const task = await changeTaskDoc(found.actor, taskId, pageId, kind, { operation: kind === "link" ? "link_task_doc" : "unlink_task_doc", source: "web" });
    revalidatePath(TASKS_PATH);
    revalidateRecordPages();
    return { docs: task.docs };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : kind === "link" ? LINK_DOC_FAILED : UNLINK_DOC_FAILED };
  }
}

export async function linkTaskDocAction(taskId: string, pageId: string) {
  return change(taskId, pageId, "link");
}

export async function unlinkTaskDocAction(taskId: string, pageId: string) {
  return change(taskId, pageId, "unlink");
}
