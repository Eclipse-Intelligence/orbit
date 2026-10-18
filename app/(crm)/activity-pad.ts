"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import {
  activitySuggestions,
  logPadActivity,
  tidyActivity,
  type ActivitySuggestion,
  type ActivityTidy,
  type PadActivityInput,
} from "@/lib/crm/activity-pad";
import { TASKS_PATH } from "@/lib/crm/task-views";
import type { Activity } from "@/lib/crm/types";
import { revalidateRecordPages } from "@/lib/revalidate";

export async function logPadActivityAction(
  input: PadActivityInput,
): Promise<{ activity?: Activity; warning?: string | null; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const result = await logPadActivity(user, input);
    revalidatePath("/activities");
    revalidateRecordPages();
    if (input.followUp) revalidatePath(TASKS_PATH);
    return result;
  } catch (error) {
    return actionError(error);
  }
}

export async function tidyActivityAction(text: string, names: string[]): Promise<ActivityTidy | null> {
  const user = await getUserActor();
  if (!user || typeof text !== "string") return null;
  try {
    return await tidyActivity(text, Array.isArray(names) ? names.filter((name) => typeof name === "string").slice(0, 10) : []);
  } catch (error) {
    console.warn("Activity pad tidy failed", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function activitySuggestionsAction(): Promise<ActivitySuggestion[]> {
  const user = await getUserActor();
  if (!user) return [];
  try {
    return await activitySuggestions(user);
  } catch (error) {
    console.warn("Activity suggestions failed", error instanceof Error ? error.message : error);
    return [];
  }
}
