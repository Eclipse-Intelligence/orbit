"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { createTaskWithClickUp } from "@/lib/crm/clickup";
import { isUuid } from "@/lib/crm/mutate";
import { isReminderMinutes } from "@/lib/crm/reminder-options";
import {
  detectPadRecords,
  NO_PAD_DETECTION,
  parsePadWithAi,
  searchPadRecords,
  type PadAiParse,
  type PadDetection,
  type PadOption,
  type PadSearchKind,
} from "@/lib/crm/task-pad";
import { isTaskDuration } from "@/lib/crm/task-time";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { padDueHasTime } from "@/lib/task-pad";
import { revalidateRecordPages } from "@/lib/revalidate";

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

export async function parseTaskWithAiAction(text: string): Promise<PadAiParse | null> {
  const user = await getUserActor();
  if (!user || typeof text !== "string") return null;
  try {
    return await parsePadWithAi(text);
  } catch (error) {
    console.warn("Task pad AI parse failed", error instanceof Error ? error.message : error);
    return null;
  }
}

function padLink(value: unknown) {
  return typeof value === "string" && isUuid(value) ? value : null;
}

function padLinks(input: { companyId?: unknown; contactId?: unknown; opportunityId?: unknown }) {
  return Object.fromEntries(
    (["companyId", "contactId", "opportunityId"] as const).flatMap((key) => (input[key] === undefined ? [] : [[key, padLink(input[key])]])),
  ) as { companyId?: string | null; contactId?: string | null; opportunityId?: string | null };
}

export async function addPadTaskAction(input: {
  title: string;
  dueAt: string | null;
  remindMinutes: number | null;
  companyId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  clickupListId: string | null;
  ownerId?: string | null;
  durationMinutes?: number | null;
}): Promise<{ ok?: boolean; error?: string; warning?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const due = typeof input.dueAt === "string" && input.dueAt ? input.dueAt : null;
    const timed = padDueHasTime(due);
    const created = await createTaskWithClickUp(
      user,
      {
        title: typeof input.title === "string" ? input.title : "",
        ...(timed ? { dueAt: due } : { dueDate: due }),
        remindMinutes: due && isReminderMinutes(input.remindMinutes) ? input.remindMinutes : null,
        ...(isTaskDuration(input.durationMinutes) ? { durationMinutes: input.durationMinutes } : {}),
        ...padLinks(input),
        ownerId: typeof input.ownerId === "string" && isUuid(input.ownerId) ? input.ownerId : user.userId,
        priority: "normal",
      },
      input.clickupListId || null,
      { provenance: { operation: "create_task", source: "web" } },
    );
    revalidatePath(TASKS_PATH);
    revalidateRecordPages();
    return created.clickupError
      ? { ok: true, warning: `Saved. ClickUp sync failed and will retry: ${created.clickupError}` }
      : { ok: true };
  } catch (error) {
    return actionError(error);
  }
}
