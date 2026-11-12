"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useComposer } from "@/components/mail/compose-dock";
import { completeTaskAction, remindTaskAction } from "@/app/(crm)/records";
import { onWorkingDay, taskRemindChoices } from "@/lib/crm/task-snooze";
import type { Task } from "@/lib/crm/types";
import { laterDetail } from "@/lib/mail/later";

export const TASK_UNDO_MS = 8_000;

type Outcome = { error?: string };
type Pending = { timer: number; toast: number };

function without(set: Set<string>, id: string) {
  const next = new Set(set);
  next.delete(id);
  return next;
}

export function useTaskDone(tasks: Task[]) {
  const router = useRouter();
  const composer = useComposer();
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [awaiting, setAwaiting] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(new Map<string, Pending>());
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
      if (back.length > 0) setDone((current) => new Set([...current].filter((id) => !back.includes(id))));
    }
  }

  const commit = useCallback(
    (id: string) => {
      const entry = pending.current.get(id);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      pending.current.delete(id);
      void completeTaskAction(id)
        .catch((): Outcome => ({ error: "Couldn't mark the task done. Try again." }))
        .then((result: Outcome) => {
          if (result.error) {
            setDone((current) => without(current, id));
            setMessage(result.error);
            composer.showToast({ message: result.error, tone: "alert" });
            return;
          }
          setAwaiting((current) => new Set(current).add(id));
          router.refresh();
        });
    },
    [composer, router],
  );

  const flush = useCallback(() => {
    for (const id of [...pending.current.keys()]) commit(id);
  }, [commit]);

  const latestFlush = useRef(flush);
  useEffect(() => {
    latestFlush.current = flush;
  });
  useEffect(() => {
    const send = () => latestFlush.current();
    window.addEventListener("pagehide", send);
    return () => {
      window.removeEventListener("pagehide", send);
      send();
    };
  }, []);

  const undo = useCallback(
    (id: string) => {
      const entry = pending.current.get(id);
      if (!entry) return false;
      window.clearTimeout(entry.timer);
      pending.current.delete(id);
      composer.dismissToast(entry.toast);
      setDone((current) => without(current, id));
      return true;
    },
    [composer],
  );

  const complete = useCallback(
    (task: Task) => {
      if (pending.current.has(task.id)) return;
      setDone((current) => new Set(current).add(task.id));
      setMessage(null);
      const toast = composer.showToast({ message: "Task done.", action: { label: "Undo", run: () => void undo(task.id) }, duration: TASK_UNDO_MS });
      const timer = window.setTimeout(() => commit(task.id), TASK_UNDO_MS);
      pending.current.set(task.id, { timer, toast });
    },
    [commit, composer, undo],
  );

  const undoLast = useCallback(() => {
    const ids = [...pending.current.keys()];
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
