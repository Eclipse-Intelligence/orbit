"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useComposer } from "@/components/mail/compose-dock";
import { completeTaskAction, openTaskIdsAction, remindTaskAction, reopenTaskAction } from "@/app/(crm)/records";
import { onWorkingDay, taskRemindChoices } from "@/lib/crm/task-snooze";
import { TASK_BEACON_PATH } from "@/lib/crm/task-views";
import type { Task } from "@/lib/crm/types";
import { laterDetail } from "@/lib/mail/later";

export const TASK_UNDO_MS = 8_000;
const BEACON_BATCH = 50;
const NOT_DONE = "Couldn't mark it done. Try again.";

type Outcome = { error?: string };
type Entry = { toast: number; timer: number; until: number; sent: boolean };

function without(set: Set<string>, ids: string[]) {
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
}

function sendBeacon(ids: string[]) {
  for (let start = 0; start < ids.length; start += BEACON_BATCH) {
    const body = JSON.stringify({ ids: ids.slice(start, start + BEACON_BATCH) });
    let queued = false;
    try {
      queued = navigator.sendBeacon?.(TASK_BEACON_PATH, new Blob([body], { type: "text/plain;charset=UTF-8" })) ?? false;
    } catch {
      queued = false;
    }
    if (!queued) {
      void fetch(TASK_BEACON_PATH, { method: "POST", body, keepalive: true, credentials: "same-origin", headers: { "content-type": "text/plain;charset=UTF-8" } }).catch(() => undefined);
    }
  }
}

export function useTaskDone(tasks: Task[]) {
  const router = useRouter();
  const composer = useComposer();
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [awaiting, setAwaiting] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const entries = useRef(new Map<string, Entry>());
  const beaconed = useRef(new Set<string>());
  const openKey = tasks
    .filter((task) => !task.completedAt)
    .map((task) => task.id)
    .join(",");
  const [seenKey, setSeenKey] = useState(openKey);
  if (seenKey !== openKey) {
    setSeenKey(openKey);
    if (awaiting.size > 0) {
      const open = new Set(openKey.split(","));
      const back = [...awaiting].filter((id) => open.has(id));
      setAwaiting(new Set());
      if (back.length > 0) setDone((current) => without(current, back));
    }
  }

  const expire = useCallback((id: string) => {
    const entry = entries.current.get(id);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    entries.current.delete(id);
  }, []);

  const commit = useCallback(
    (id: string) => {
      const entry = entries.current.get(id);
      if (!entry || entry.sent) return;
      expire(id);
      composer.dismissToast(entry.toast);
      void completeTaskAction(id)
        .catch((): Outcome => ({ error: NOT_DONE }))
        .then((result: Outcome) => {
          if (result.error) {
            setDone((current) => without(current, [id]));
            setMessage(result.error);
            composer.showToast({ message: result.error, tone: "alert" });
            return;
          }
          setAwaiting((current) => new Set(current).add(id));
          router.refresh();
        });
    },
    [composer, expire, router],
  );

  const flush = useCallback(() => {
    for (const [id, entry] of [...entries.current]) if (!entry.sent) commit(id);
  }, [commit]);

  const beacon = useCallback(() => {
    const ids = [...entries.current].filter(([, entry]) => !entry.sent).map(([id]) => id);
    if (ids.length === 0) return;
    for (const id of ids) {
      const entry = entries.current.get(id);
      if (!entry) continue;
      window.clearTimeout(entry.timer);
      entry.sent = true;
      entry.timer = window.setTimeout(() => expire(id), Math.max(0, entry.until - Date.now()));
      beaconed.current.add(id);
    }
    sendBeacon(ids);
  }, [expire]);

  const recheck = useCallback(() => {
    const ids = [...beaconed.current];
    beaconed.current.clear();
    router.refresh();
    if (ids.length === 0) return;
    void openTaskIdsAction(ids)
      .catch(() => ({ open: [] as string[] }))
      .then((result) => {
        const open = result.open ?? [];
        if (open.length === 0) return;
        for (const id of open) {
          const entry = entries.current.get(id);
          if (entry) composer.dismissToast(entry.toast);
          expire(id);
        }
        setDone((current) => without(current, open));
        composer.showToast({ message: NOT_DONE, tone: "alert" });
      });
  }, [composer, expire, router]);

  const latest = useRef({ flush, beacon, recheck });
  useEffect(() => {
    latest.current = { flush, beacon, recheck };
  });
  useEffect(() => {
    const leave = () => latest.current.beacon();
    const back = () => latest.current.recheck();
    const visibility = () => {
      if (document.visibilityState === "hidden") latest.current.beacon();
      else latest.current.recheck();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
      document.removeEventListener("visibilitychange", visibility);
      latest.current.flush();
    };
  }, []);

  const undo = useCallback(
    (id: string) => {
      const entry = entries.current.get(id);
      if (!entry) return false;
      expire(id);
      composer.dismissToast(entry.toast);
      if (!entry.sent) {
        setDone((current) => without(current, [id]));
        return true;
      }
      void reopenTaskAction(id)
        .catch((): Outcome => ({ error: "Couldn't undo. Try again." }))
        .then((result: Outcome) => {
          if (result.error) {
            composer.showToast({ message: result.error, tone: "alert" });
            return;
          }
          setDone((current) => without(current, [id]));
          router.refresh();
        });
      return true;
    },
    [composer, expire, router],
  );

  const complete = useCallback(
    (task: Task) => {
      if (entries.current.has(task.id)) return;
      setDone((current) => new Set(current).add(task.id));
      setMessage(null);
      const toast = composer.showToast({ message: "Task done.", action: { label: "Undo", run: () => void undo(task.id) }, duration: TASK_UNDO_MS });
      const timer = window.setTimeout(() => commit(task.id), TASK_UNDO_MS);
      entries.current.set(task.id, { toast, timer, until: Date.now() + TASK_UNDO_MS, sent: false });
    },
    [commit, composer, undo],
  );

  const undoLast = useCallback(() => {
    const ids = [...entries.current.keys()];
    const id = ids[ids.length - 1];
    return id ? undo(id) : false;
  }, [undo]);

  const remind = useCallback(
    (task: Task) => {
      const now = Date.now();
      composer.pickLater({
        title: "Remind me",
        description: "Moves the due date.",
        options: taskRemindChoices(task.dueAt, new Date(now)),
        now,
        onPick: (at) => {
          setMessage(null);
          void remindTaskAction(task.id, at)
            .catch((): Outcome => ({ error: "Couldn't move the task. Try again." }))
            .then((result: Outcome) => {
              if (result.error) {
                setMessage(result.error);
                composer.showToast({ message: result.error, tone: "alert" });
                return;
              }
              composer.showToast({ message: `Due ${laterDetail(onWorkingDay(new Date(at)), Date.now())}.` });
              router.refresh();
            });
        },
      });
    },
    [composer, router],
  );

  return { done, message, setMessage, complete, undo, undoLast, remind };
}
