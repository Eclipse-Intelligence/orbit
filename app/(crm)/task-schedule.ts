"use server";

import { getUserActor } from "@/lib/auth/user";
import { busyFor } from "@/lib/crm/task-due";
import { DEFAULT_TASK_DURATION, isTaskDuration, scheduleChoices, type ScheduleChoice } from "@/lib/crm/task-time";

export async function scheduleChoicesAction(durationMinutes: number): Promise<{ choices: ScheduleChoice[] | null }> {
  const actor = await getUserActor();
  if (!actor) return { choices: null };
  const now = Date.now();
  const busy = await busyFor(actor, actor.userId, new Date(now), 1);
  if (busy === null) return { choices: null };
  return { choices: scheduleChoices({ durationMinutes: isTaskDuration(durationMinutes) ? durationMinutes : DEFAULT_TASK_DURATION, now, busy }) };
}
