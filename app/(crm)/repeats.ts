"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { clickupToken } from "@/lib/clickup";
import { actionError } from "@/lib/companies";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { isUuid } from "@/lib/crm/mutate";
import {
  deleteSeries,
  endSeriesOn,
  readRepeatHistory,
  REPEAT_SAVE_FAILED,
  setTaskRepeat,
  REPEAT_SCOPES,
  skipOccurrence,
  type RepeatHistoryItem,
  type RepeatScope,
  type RepeatInput,
} from "@/lib/crm/task-series";
import { TASKS_PATH } from "@/lib/crm/task-views";
import type { Task, TaskWrite, UserActor } from "@/lib/crm/types";
import { moveUpcoming } from "@/lib/crm/upcoming";
import { undoTaskEvents } from "@/lib/crm/undo";
import { isPgError } from "@/lib/crm/errors";
import { TASK_LOOKUP_FAILED, taskActorOrError } from "@/lib/crm/workspaces";
import { revalidateRecordPages } from "@/lib/revalidate";

const UNDO_FAILED = "Couldn't undo. Try again.";

export type RepeatActionResult = { ok?: true; error?: string; task?: Task; undo?: string[]; skipped?: string };

async function taskUser(id: unknown) {
  const user = await getUserActor();
  if (!user) return null;
  return (await taskActorOrError(user, id)).actor ?? null;
}

function refresh() {
  revalidatePath(TASKS_PATH);
  revalidatePath("/calendar");
  revalidateRecordPages();
}

function pushLater(user: UserActor, id: string) {
  if (!clickupToken()) return;
  after(async () => {
    try {
      await pushClickUpTask(user, id);
    } catch (error) {
      console.error("ClickUp push failed", error);
    }
  });
}

async function run(id: string, work: (user: UserActor) => Promise<{ task: Task; undo: string[]; skipped?: string }>): Promise<RepeatActionResult> {
  if (!isUuid(id)) return { error: REPEAT_SAVE_FAILED };
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  try {
    const result = await work(user);
    pushLater(user, result.task.id);
    refresh();
    return { ok: true, task: result.task, undo: result.undo, ...(result.skipped ? { skipped: result.skipped } : {}) };
  } catch (error) {
    return actionError(error);
  }
}

export async function setRepeatAction(id: string, repeat: RepeatInput | null): Promise<RepeatActionResult> {
  return run(id, async (user) => (await setTaskRepeat(user, id, repeat, { provenance: { operation: repeat === null ? "stop_repeating" : "set_repeat", source: "web" } })).body);
}

export async function skipOccurrenceAction(id: string, occursOn?: string | null): Promise<RepeatActionResult> {
  return run(id, async (user) =>
    (await skipOccurrence(user, { taskId: id }, { provenance: { operation: "skip_occurrence", source: "web" }, ...(typeof occursOn === "string" ? { expect: occursOn } : {}) })).body,
  );
}

export type UpcomingTarget = { currentTaskId: string; seriesId: string; occursOn: string };

function readTarget(target: UpcomingTarget) {
  if (!target || typeof target !== "object" || !isUuid(target.currentTaskId) || !isUuid(target.seriesId) || typeof target.occursOn !== "string") return null;
  return { currentTaskId: target.currentTaskId, seriesId: target.seriesId, occursOn: target.occursOn };
}

export async function skipUpcomingAction(target: UpcomingTarget): Promise<RepeatActionResult> {
  const read = readTarget(target);
  if (!read) return { error: REPEAT_SAVE_FAILED };
  return run(read.currentTaskId, async (user) =>
    (await skipOccurrence(user, { seriesId: read.seriesId, occursOn: read.occursOn }, { provenance: { operation: "skip_occurrence", source: "web" } })).body,
  );
}

export async function moveUpcomingAction(
  target: UpcomingTarget,
  move: { dueAt?: string; durationMinutes?: number },
  scope: RepeatScope,
  replaces: string[] = [],
): Promise<RepeatActionResult> {
  const read = readTarget(target);
  if (!read || !REPEAT_SCOPES.includes(scope) || !move || typeof move !== "object") return { error: REPEAT_SAVE_FAILED };
  const write: TaskWrite = {};
  if (move.dueAt !== undefined) {
    if (typeof move.dueAt !== "string" || Number.isNaN(Date.parse(move.dueAt))) return { error: REPEAT_SAVE_FAILED };
    write.dueAt = new Date(move.dueAt).toISOString();
    write.dueHasTime = true;
  }
  if (move.durationMinutes !== undefined) {
    if (!Number.isInteger(move.durationMinutes) || move.durationMinutes < 5 || move.durationMinutes > 480) return { error: "Choose a duration between 5 and 480 minutes." };
    write.durationMinutes = move.durationMinutes;
  }
  if (Object.keys(write).length === 0) return { error: REPEAT_SAVE_FAILED };
  const undone = (Array.isArray(replaces) ? replaces : []).filter((event) => typeof event === "string" && isUuid(event));
  return run(read.currentTaskId, (user) =>
    moveUpcoming(user, { seriesId: read.seriesId, occursOn: read.occursOn }, write, scope, undone, { operation: "drag_task", source: "web" }),
  );
}

export async function endSeriesAction(id: string, until: string): Promise<RepeatActionResult> {
  return run(id, async (user) => (await endSeriesOn(user, id, until, { provenance: { operation: "end_repeat", source: "web" } })).body);
}

export async function deleteSeriesAction(id: string): Promise<RepeatActionResult> {
  return run(id, async (user) => (await deleteSeries(user, id, { provenance: { operation: "delete_series", source: "web" } })).body);
}

export async function repeatHistoryAction(id: string): Promise<{ items?: RepeatHistoryItem[]; error?: string }> {
  if (!isUuid(id)) return { items: [] };
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  try {
    return { items: await readRepeatHistory(user, id) };
  } catch (error) {
    return actionError(error);
  }
}

export async function undoRepeatAction(id: string, events: string[]): Promise<{ ok?: true; error?: string }> {
  if (!isUuid(id)) return { error: UNDO_FAILED };
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  const ids = (Array.isArray(events) ? events : []).filter((event) => typeof event === "string" && isUuid(event));
  if (ids.length === 0) return { error: UNDO_FAILED };
  try {
    await undoTaskEvents(user, id, ids, { operation: "undo_change", source: "web" });
    pushLater(user, id);
    refresh();
    return { ok: true };
  } catch (error) {
    if (isPgError(error) && error.code === "40P01") return { error: UNDO_FAILED };
    return actionError(error);
  }
}
