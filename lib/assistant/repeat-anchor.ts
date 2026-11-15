import { taskDueDay } from "@/lib/crm/task-time";
import { dayKeyAt } from "@/lib/crm/working-days";
import { readDateTime } from "@/lib/time";

export type RepeatAnchorTask = { occursOn: string | null; dueAt: string | null; live: boolean };

export function dueDayOfInput(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const reading = readDateTime(value);
  return reading.ok ? taskDueDay(reading.date.toISOString()) : null;
}

export function repeatAnchorDay(task: RepeatAnchorTask | null, input: { dueAt?: unknown; dueDate?: unknown }, now = Date.now()) {
  if (task?.live && task.occursOn) return task.occursOn;
  return dueDayOfInput(input.dueAt) ?? dueDayOfInput(input.dueDate) ?? taskDueDay(task?.dueAt ?? null) ?? dayKeyAt(new Date(now));
}
