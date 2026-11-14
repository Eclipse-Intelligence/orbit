"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useComposer } from "@/components/mail/compose-dock";
import { completeTaskAction, openTaskIdsAction, remindTaskAction, reopenTaskAction } from "@/app/(crm)/records";
import { taskRemindChoices } from "@/lib/crm/task-snooze";
import { TASK_BEACON_PATH } from "@/lib/crm/task-views";
import { reconcileDone } from "@/lib/task-done";
import { movedMessage } from "@/lib/task-pad";
import type { Task } from "@/lib/crm/types";

export const TASK_UNDO_MS = 8_000;
const BEACON_BATCH = 50;
const NOT_DONE = "Couldn't mark it done. Try again.";
const NOT_REOPENED = "Couldn't reopen the task. Try again.";
const RECHECK_MS = 1_500;

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

type Outcome = { error?: string };
type Moved = Outcome & { saved?: { dueAt: string | null; dueHasTime: boolean } };

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
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set());
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const inflight = useRef(new Map<string, Promise<unknown>>());
  const reopening = useRef(new Set<string>());
  const [message, setMessage] = useState<string | null>(null);
  const entries = useRef(new Map<string, Entry>());
  const beaconed = useRef(new Set<string>());
  const withdrawn = useRef(new Set<string>());
  const undone = useRef(new Set<string>());
  const openKey = tasks
    .filter((task) => !task.completedAt)
    .map((task) => task.id)
    .join(",");
  const [seenKey, setSeenKey] = useState(openKey);
  if (seenKey !== openKey) {
    setSeenKey(openKey);
    const next = reconcileDone(new Set(openKey.split(",")), { done, awaiting, confirmed, sent });
    setDone(next.done);
    setAwaiting(next.awaiting);
    setConfirmed(next.confirmed);
    setSent(next.sent);
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
      setSent((current) => new Set(current).add(id));
      const request = completeTaskAction(id)
        .catch((): Outcome => ({ error: NOT_DONE }))
        .then((result: Outcome) => {
          inflight.current.delete(id);
          if (result.error) {
            setSent((current) => without(current, [id]));
            setDone((current) => without(current, [id]));
            setMessage(result.error);
            composer.showToast({ message: result.error, tone: "alert" });
            return;
          }
          setAwaiting((current) => new Set(current).add(id));
          router.refresh();
        });
      inflight.current.set(id, request);
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
    setSent((current) => new Set([...current, ...ids]));
    sendBeacon(ids);
  }, [expire]);

  const recheck = useCallback(() => {
    const ids = [...beaconed.current];
    beaconed.current.clear();
    if (ids.length === 0 && entries.current.size === 0) return;
    router.refresh();
    if (ids.length === 0) return;
    const stillOpen = async (wanted: string[]) => (await openTaskIdsAction(wanted).catch(() => ({ open: [] as string[] }))).open ?? [];
    void (async () => {
      await wait(RECHECK_MS);
      let open = await stillOpen(ids);
      if (open.length > 0) {
        await wait(RECHECK_MS);
        open = await stillOpen(open);
      }
      open = open.filter((id) => !withdrawn.current.has(id));
      if (open.length < ids.length) router.refresh();
      if (open.length === 0) return;
      for (const id of open) {
        const entry = entries.current.get(id);
        if (entry) composer.dismissToast(entry.toast);
        expire(id);
      }
      setDone((current) => without(current, open));
      composer.showToast({ message: NOT_DONE, tone: "alert" });
      router.refresh();
      await wait(RECHECK_MS * 2);
      const late = await stillOpen(open);
      if (late.length < open.length) router.refresh();
    })();
  }, [composer, expire, router]);

  const latest = useRef({ flush, beacon, recheck });
  useEffect(() => {
    latest.current = { flush, beacon, recheck };
  });
  useEffect(() => {
    const leave = () => latest.current.beacon();
    const back = (event: PageTransitionEvent) => {
      if (event.persisted) latest.current.recheck();
    };
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
      undone.current.add(id);
      expire(id);
      composer.dismissToast(entry.toast);
      setSent((current) => without(current, [id]));
      setConfirmed((current) => without(current, [id]));
      if (!entry.sent) {
        setDone((current) => without(current, [id]));
        return true;
      }
      withdrawn.current.add(id);
      void (async () => {
        const reopen = () => reopenTaskAction(id).catch((): Outcome => ({ error: "Couldn't undo. Try again." }));
        const result: Outcome = await reopen();
        if (result.error) {
          composer.showToast({ message: result.error, tone: "alert" });
          return;
        }
        setDone((current) => without(current, [id]));
        router.refresh();
        for (let check = 0; check < 2; check += 1) {
          await wait(RECHECK_MS);
          const open = (await openTaskIdsAction([id]).catch(() => ({ open: [id] }))).open ?? [id];
          if (open.includes(id)) continue;
          await reopen();
          router.refresh();
        }
      })();
      return true;
    },
    [composer, expire, router],
  );

  const complete = useCallback(
    (task: Task, options: { hold?: boolean } = {}) => {
      if (entries.current.has(task.id)) return;
      withdrawn.current.delete(task.id);
      undone.current.delete(task.id);
      setDone((current) => new Set(current).add(task.id));
      setMessage(null);
      const toast = composer.showToast({ message: "Task done.", action: { label: "Undo", run: () => void undo(task.id) }, duration: TASK_UNDO_MS });
      const timer = options.hold ? 0 : window.setTimeout(() => commit(task.id), TASK_UNDO_MS);
      entries.current.set(task.id, { toast, timer, until: Date.now() + TASK_UNDO_MS, sent: false });
    },
    [commit, composer, undo],
  );

  const release = useCallback(
    (id: string) => {
      const entry = entries.current.get(id);
      if (!entry || entry.sent) return;
      window.clearTimeout(entry.timer);
      entry.timer = window.setTimeout(() => commit(id), Math.max(0, entry.until - Date.now()));
    },
    [commit],
  );

  const settle = useCallback(
    (id: string, message: string) => {
      if (undone.current.has(id)) {
        undone.current.delete(id);
        void reopenTaskAction(id)
          .catch((): Outcome => ({ error: "Couldn't undo. Try again." }))
          .then((result: Outcome) => {
            composer.showToast(result.error ? { message: `Saved, but the task is still done. ${result.error}`, tone: "alert" } : { message: "Saved. Task reopened." });
            router.refresh();
          });
        return false;
      }
      const entry = entries.current.get(id);
      if (entry) {
        composer.dismissToast(entry.toast);
        expire(id);
      }
      withdrawn.current.delete(id);
      setDone((current) => new Set(current).add(id));
      setAwaiting((current) => new Set(current).add(id));
      composer.showToast({ message });
      router.refresh();
      return true;
    },
    [composer, expire, router],
  );

  const abandon = useCallback(
    (id: string) => {
      if (!undone.current.has(id)) return;
      undone.current.delete(id);
      void (async () => {
        const open = (await openTaskIdsAction([id]).catch(() => ({ open: [] as string[] }))).open ?? [];
        if (open.includes(id)) return;
        const result: Outcome = await reopenTaskAction(id).catch((): Outcome => ({ error: "Couldn't undo. Try again." }));
        if (result.error) composer.showToast({ message: result.error, tone: "alert" });
        router.refresh();
      })();
    },
    [composer, router],
  );

  const reopen = useCallback(
    (task: Task) => {
      if (entries.current.has(task.id)) return undo(task.id);
      if (reopening.current.has(task.id)) return false;
      reopening.current.add(task.id);
      setMessage(null);
      const forget = (id: string) => {
        setDone((current) => without(current, [id]));
        setAwaiting((current) => without(current, [id]));
        setConfirmed((current) => without(current, [id]));
        setSent((current) => without(current, [id]));
      };
      void (async () => {
        await inflight.current.get(task.id);
        const result: Outcome = await reopenTaskAction(task.id).catch((): Outcome => ({ error: NOT_REOPENED }));
        reopening.current.delete(task.id);
        if (result.error) {
          setMessage(result.error);
          composer.showToast({ message: result.error, tone: "alert" });
          return;
        }
        forget(task.id);
        composer.showToast({
          message: "Task reopened.",
          duration: TASK_UNDO_MS,
          action: {
            label: "Undo",
            run: () =>
              void completeTaskAction(task.id)
                .catch((): Outcome => ({ error: NOT_DONE }))
                .then((done: Outcome) => {
                  if (done.error) {
                    composer.showToast({ message: done.error, tone: "alert" });
                    return;
                  }
                  setDone((current) => new Set(current).add(task.id));
                  setAwaiting((current) => new Set(current).add(task.id));
                  router.refresh();
                }),
          },
        });
        router.refresh();
      })();
      return true;
    },
    [composer, router, undo],
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
        options: taskRemindChoices(task, new Date(now)),
        now,
        onPick: (at) => {
          setMessage(null);
          void remindTaskAction(task.id, at)
            .catch((): Moved => ({ error: "Couldn't move the task. Try again." }))
            .then((result: Moved) => {
              if (result.error) {
                setMessage(result.error);
                composer.showToast({ message: result.error, tone: "alert" });
                return;
              }
              composer.showToast({ message: movedMessage(task, at, result.saved, Date.now()) });
              router.refresh();
            });
        },
      });
    },
    [composer, router],
  );

  return { done, message, setMessage, complete, release, settle, abandon, undo, undoLast, remind, reopen };
}
