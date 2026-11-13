"use server";

import { getUserActor } from "@/lib/auth/user";
import { busyFor } from "@/lib/crm/task-due";
import { DEFAULT_TASK_DURATION, isTaskDuration, nextFreeStart, scheduleChoices, type ScheduleChoice } from "@/lib/crm/task-time";
import { getWorkingHours } from "@/lib/crm/working-hours";

export async function nextFreeAction(
  durationMinutes: number,
): Promise<{ free: ScheduleChoice | null; fixed: ScheduleChoice[]; outside: boolean; now: number } | { error: string }> {
  try {
    const actor = await getUserActor();
    if (!actor) return { error: "Your session ended. Sign in again." };
    const now = Date.now();
    const duration = isTaskDuration(durationMinutes) ? durationMinutes : DEFAULT_TASK_DURATION;
    const [busy, hours] = await Promise.all([busyFor(actor, actor.userId, new Date(now), 1), getWorkingHours(actor)]);
    if (busy === null) return { error: "Couldn't read your calendar. Try again." };
    const choices = scheduleChoices({ durationMinutes: duration, now, busy, hours });
    return {
      free: choices.find((choice) => choice.id === "next-free") ?? null,
      fixed: choices.filter((choice) => choice.id !== "next-free"),
      outside: nextFreeStart(now, duration, [], undefined, hours) === null,
      now,
    };
  } catch {
    return { error: "Couldn't read your calendar. Try again." };
  }
}
