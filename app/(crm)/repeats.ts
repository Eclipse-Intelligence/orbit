"use server";

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
  setTaskRepeat,
  skipOccurrence,
  type RepeatHistoryItem,
  type RepeatInput,
} from "@/lib/crm/task-series";
import type { Task, UserActor } from "@/lib/crm/types";
import { undoTaskEvents } from "@/lib/crm/undo";
import { isPgError } from "@/lib/crm/errors";
import { TASK_LOOKUP_FAILED, taskActorOrError } from "@/lib/crm/workspaces";
import { revalidateTaskPages } from "@/lib/revalidate";
import { REPEAT_SAVE_FAILED } from "@/lib/task-repeat-menu";

const UNDO_FAILED = "Couldn't undo. Try again.";

export type RepeatActionResult = { ok?: true; error?: string; task?: Task; undo?: string[]; skipped?: string };

async function taskUser(id: unknown) {
  const user = await getUserActor();
  if (!user) return null;
  return (await taskActorOrError(user, id)).actor ?? null;
}

function refresh() {
  revalidateTaskPages();
}

function keyed(key: unknown) {
  return typeof key === "string" && isUuid(key) ? { idempotencyKey: key } : {};
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

export async function setRepeatAction(id: string, repeat: RepeatInput | null, key?: string): Promise<RepeatActionResult> {
  return run(id, async (user) => (await setTaskRepeat(user, id, repeat, { provenance: { operation: repeat === null ? "stop_repeating" : "set_repeat", source: "web" }, ...keyed(key) })).body);
}

export async function skipOccurrenceAction(id: string, occursOn?: string | null, key?: string): Promise<RepeatActionResult> {
  return run(id, async (user) =>
    (await skipOccurrence(user, { taskId: id }, { provenance: { operation: "skip_occurrence", source: "web" }, ...(typeof occursOn === "string" ? { expect: occursOn } : {}), ...keyed(key) })).body,
  );
}

export async function endSeriesAction(id: string, until: string, key?: string): Promise<RepeatActionResult> {
  return run(id, async (user) => (await endSeriesOn(user, id, until, { provenance: { operation: "end_repeat", source: "web" }, ...keyed(key) })).body);
}

export async function deleteSeriesAction(id: string, key?: string): Promise<RepeatActionResult> {
  return run(id, async (user) => (await deleteSeries(user, id, { provenance: { operation: "delete_series", source: "web" }, ...keyed(key) })).body);
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
