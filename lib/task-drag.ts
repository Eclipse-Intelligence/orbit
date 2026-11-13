import { DAY_MINUTES } from "@/lib/calendar-view";
import {
  dayStartIso,
  DEFAULT_TASK_DURATION,
  MAX_TASK_DURATION,
  taskDueDay,
  wallInstant,
} from "@/lib/crm/task-time";
import type { Task } from "@/lib/crm/types";
import { appTimeZone } from "@/lib/time";

export const DRAG_STEP_MINUTES = 15;
export const DRAG_MIN_DURATION = DRAG_STEP_MINUTES;

export type GridSlot = {
  day: string;
  minutes: number;
  durationMinutes: number;
};

export type DropPlacement =
  | { at: string; durationMinutes: number }
  | { dateOnly: true };

function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high);
}

export function blockDuration(minutes: number | null | undefined) {
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    ? Math.round(minutes)
    : DEFAULT_TASK_DURATION;
}

export function snapStart(minutes: number, durationMinutes: number) {
  const latest =
    DAY_MINUTES - Math.min(blockDuration(durationMinutes), DAY_MINUTES);
  const snapped = Math.round(minutes / DRAG_STEP_MINUTES) * DRAG_STEP_MINUTES;
  return clamp(
    snapped,
    0,
    Math.floor(latest / DRAG_STEP_MINUTES) * DRAG_STEP_MINUTES,
  );
}

export function snapDuration(startMinutes: number, endMinutes: number) {
  const room = Math.max(DRAG_MIN_DURATION, DAY_MINUTES - startMinutes);
  const snapped =
    Math.round((endMinutes - startMinutes) / DRAG_STEP_MINUTES) *
    DRAG_STEP_MINUTES;
  return clamp(snapped, DRAG_MIN_DURATION, Math.min(MAX_TASK_DURATION, room));
}

export function slotInstant(
  day: string,
  minutes: number,
  timeZone = appTimeZone(),
) {
  return new Date(
    wallInstant(day, Math.floor(minutes / 60), minutes % 60, timeZone),
  ).toISOString();
}

function clock(minutes: number) {
  const total = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function slotRange(slot: Pick<GridSlot, "minutes" | "durationMinutes">) {
  return `${clock(slot.minutes)} to ${clock(slot.minutes + slot.durationMinutes)}`;
}

export function slotDayLabel(day: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

export function slotDateLabel(day: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
    .format(new Date(`${day}T12:00:00Z`))
    .replace(",", "");
}

export function samePlace(
  task: Pick<Task, "dueAt" | "dueHasTime" | "durationMinutes">,
  slot: GridSlot,
  timeZone = appTimeZone(),
) {
  if (!task.dueHasTime || !task.dueAt) return false;
  return (
    new Date(task.dueAt).getTime() ===
      new Date(slotInstant(slot.day, slot.minutes, timeZone)).getTime() &&
    blockDuration(task.durationMinutes) === slot.durationMinutes
  );
}

export function placementFor(
  slot: GridSlot,
  timeZone = appTimeZone(),
): DropPlacement {
  return {
    at: slotInstant(slot.day, slot.minutes, timeZone),
    durationMinutes: slot.durationMinutes,
  };
}

export function placedTask(
  task: Task,
  placement: DropPlacement,
  viewerId: string,
  timeZone = appTimeZone(),
): Task {
  if ("dateOnly" in placement) {
    const day = taskDueDay(task.dueAt, timeZone);
    if (!day) return task;
    return {
      ...task,
      dueAt: dayStartIso(day, timeZone),
      dueDate: day,
      dueHasTime: false,
      scheduledBy: null,
      remindMinutes: null,
    };
  }
  return {
    ...task,
    dueAt: placement.at,
    dueDate: taskDueDay(placement.at, timeZone),
    dueHasTime: true,
    scheduledBy: "person",
    durationMinutes: placement.durationMinutes,
    ownerId: task.ownerId ?? viewerId,
  };
}

export function placementLanded(
  task: Pick<Task, "dueAt" | "dueHasTime" | "durationMinutes" | "ownerId">,
  expected: Task,
) {
  const instant = (value: string | null) =>
    value ? new Date(value).getTime() : null;
  return (
    instant(task.dueAt) === instant(expected.dueAt) &&
    task.dueHasTime === expected.dueHasTime &&
    (!expected.dueHasTime ||
      (task.durationMinutes === expected.durationMinutes &&
        task.ownerId === expected.ownerId))
  );
}

export function edgeScrollSpeed(
  pointer: number,
  top: number,
  bottom: number,
  edge = 48,
  fastest = 18,
) {
  if (bottom - top < edge * 3) return 0;
  if (pointer < top + edge)
    return -Math.ceil(fastest * clamp((top + edge - pointer) / edge, 0, 1));
  if (pointer > bottom - edge)
    return Math.ceil(fastest * clamp((pointer - (bottom - edge)) / edge, 0, 1));
  return 0;
}
