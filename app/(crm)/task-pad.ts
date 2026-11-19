"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { isUuid } from "@/lib/crm/mutate";
import { addPadTask, type PadTaskInput } from "@/lib/crm/pad-task";
import {
  detectPadRecords,
  NO_PAD_DETECTION,
  searchPadRecords,
  type PadDetection,
  type PadOption,
  type PadSearchKind,
} from "@/lib/crm/task-pad";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { revalidateRecordPages } from "@/lib/revalidate";
import { taskActorOrError } from "@/lib/crm/workspaces";

export async function detectTaskRecordsAction(text: string, companyId: string | null = null): Promise<PadDetection> {
  const user = await getUserActor();
  if (!user || typeof text !== "string") return NO_PAD_DETECTION;
  return detectPadRecords(user, text, { companyId: typeof companyId === "string" && isUuid(companyId) ? companyId : null });
}

const SEARCH_KINDS: PadSearchKind[] = ["contact", "company", "opportunity"];

export async function searchTaskLinksAction(kind: PadSearchKind, query: string, companyId: string | null = null): Promise<PadOption[]> {
  const user = await getUserActor();
  if (!user || !SEARCH_KINDS.includes(kind) || typeof query !== "string") return [];
  return searchPadRecords(user, kind, query, typeof companyId === "string" && isUuid(companyId) ? companyId : null);
}

export async function searchLinksForTaskAction(taskId: string, kind: PadSearchKind, query: string, companyId: string | null = null): Promise<{ options?: PadOption[]; error?: string }> {
  const viewer = await getUserActor();
  if (!viewer) return { error: "Your session ended. Sign in again." };
  if (!SEARCH_KINDS.includes(kind) || typeof query !== "string") return { options: [] };
  const resolved = await taskActorOrError(viewer, taskId);
  if (!resolved.actor) return { error: resolved.error };
  try {
    return { options: await searchPadRecords(resolved.actor, kind, query, typeof companyId === "string" && isUuid(companyId) ? companyId : null) };
  } catch {
    return { error: "Couldn't search. Try again." };
  }
}

export async function addPadTaskAction(input: PadTaskInput): Promise<{ ok?: boolean; error?: string; warning?: string; reminderError?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const result = await addPadTask(user, input);
    revalidatePath(TASKS_PATH);
    revalidateRecordPages();
    return result;
  } catch (error) {
    return actionError(error);
  }
}
