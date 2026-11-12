"use server";

import { getUserActor } from "@/lib/auth/user";
import { busyFor } from "@/lib/crm/task-due";
import { DEFAULT_TASK_DURATION, isTaskDuration, scheduleChoices, type ScheduleChoice } from "@/lib/crm/task-time";

export async function nextFreeAction(durationMinutes: number): Promise<{ free: ScheduleChoice | null; now: number } | { error: string }> {
  try {
    const actor = await getUserActor();
    if (!actor) return { error: "Your session ended. Sign in again." };
    const now = Date.now();
    const busy = await busyFor(actor, actor.userId, new Date(now), 1);
    if (busy === null) return { error: "Couldn't read your calendar. Try again." };
    const choices = scheduleChoices({ durationMinutes: isTaskDuration(durationMinutes) ? durationMinutes : DEFAULT_TASK_DURATION, now, busy });
    return { free: choices.find((choice) => choice.id === "next-free") ?? null, now };
  } catch {
    return { error: "Couldn't read your calendar. Try again." };
  }
}
