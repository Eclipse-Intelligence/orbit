"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { clickupToken } from "@/lib/clickup";
import { actionError } from "@/lib/companies";
import { CrmError } from "@/lib/crm/errors";
import { buildPlan, pushScheduled, SCHEDULE_FAILED, scheduleTasks, type ScheduledTask } from "@/lib/crm/plan-schedule";
import type { PlanOrderItem, PlanProposal } from "@/lib/crm/plan-tasks";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { revalidateRecordPages } from "@/lib/revalidate";

const PLAN_FAILED = "Couldn't plan your tasks. Try again.";

function pushLater(scheduled: ScheduledTask[]) {
  if (!clickupToken() || !scheduled.some((item) => item.changed && item.task.clickupListId)) return;
  const run = () => pushScheduled(scheduled).catch((error) => console.error("ClickUp push failed", error));
  try {
    after(run);
  } catch {
    void run();
  }
}

export async function planAction(input: { replan?: boolean; ordering?: PlanOrderItem[] | null } = {}): Promise<{ plan: PlanProposal } | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const plan = await buildPlan(user, { replan: input.replan === true, ordering: Array.isArray(input.ordering) ? input.ordering : undefined });
    return { plan };
  } catch (error) {
    console.error("Plan failed", error);
    return { error: error instanceof CrmError ? error.message : PLAN_FAILED };
  }
}

export async function applyPlanAction(entries: unknown): Promise<{ ok?: true; count?: number; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const scheduled = await scheduleTasks(user, entries, { mode: "plan", provenance: { operation: "plan_tasks", source: "web" } });
    pushLater(scheduled);
    revalidatePath("/calendar");
    revalidatePath(TASKS_PATH);
    revalidatePath("/");
    revalidateRecordPages();
    return { ok: true, count: scheduled.filter((item) => item.changed).length };
  } catch (error) {
    if (error instanceof CrmError) return { error: actionError(error).error };
    console.error("Apply plan failed", error);
    return { error: SCHEDULE_FAILED };
  }
}
