"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import { createTaskWithClickUp } from "@/lib/crm/clickup";
import { isReminderMinutes } from "@/lib/crm/reminder-options";
import { detectPadRecords, parsePadWithAi, type PadAiParse, type PadDetection } from "@/lib/crm/task-pad";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { revalidateRecordPages } from "@/lib/revalidate";

export async function detectTaskRecordsAction(text: string): Promise<PadDetection> {
  const user = await getUserActor();
  if (!user || typeof text !== "string") return { company: null, contact: null };
  return detectPadRecords(user, text);
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

export async function addPadTaskAction(input: {
  title: string;
  dueAt: string | null;
  remindMinutes: number | null;
  companyId: string | null;
  contactId: string | null;
  clickupListId: string | null;
}): Promise<{ ok?: boolean; error?: string; warning?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const dueAt = typeof input.dueAt === "string" && input.dueAt ? input.dueAt : null;
    const created = await createTaskWithClickUp(
      user,
      {
        title: typeof input.title === "string" ? input.title : "",
        dueAt,
        remindMinutes: dueAt && isReminderMinutes(input.remindMinutes) ? input.remindMinutes : null,
        companyId: input.companyId || null,
        contactId: input.contactId || null,
        priority: "normal",
      },
      input.clickupListId || null,
      { provenance: { operation: "create_task", source: "web" } },
    );
    revalidatePath(TASKS_PATH);
    revalidateRecordPages();
    return created.clickupError
      ? { ok: true, warning: `Saved in Orbit, but ClickUp said: ${created.clickupError} Orbit will try again.` }
      : { ok: true };
  } catch (error) {
    return actionError(error);
  }
}
