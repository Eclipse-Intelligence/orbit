"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useComposer } from "@/components/mail/compose-dock";
import { completeTaskAction, remindTaskAction, reopenTaskAction } from "@/app/(crm)/records";
import { onWorkingDay, taskRemindChoices } from "@/lib/crm/task-snooze";
import type { Task } from "@/lib/crm/types";
import { laterDetail } from "@/lib/mail/later";

type Outcome = { error?: string };

export function useTaskDone() {
  const router = useRouter();
  const composer = useComposer();
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const completing = useRef(new Map<string, Promise<Outcome>>());
  const undoable = useRef<string[]>([]);
  const toasts = useRef(new Map<string, number>());

  function forget(id: string) {
    setDone((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function complete(task: Task) {
    if (done.has(task.id)) return;
    setDone((current) => new Set(current).add(task.id));
    setMessage(null);
    const pending: Promise<Outcome> = completeTaskAction(task.id).catch(() => ({ error: "Couldn't mark the task done. Try again." }));
    completing.current.set(task.id, pending);
    undoable.current = [...undoable.current.filter((id) => id !== task.id), task.id];
    const toast = composer.showToast({ message: "Task done.", action: { label: "Undo", run: () => void undo(task.id) } });
    toasts.current.set(task.id, toast);
    void pending.then((result) => {
      if (completing.current.get(task.id) === pending) completing.current.delete(task.id);
      if (result.error) {
        forget(task.id);
        undoable.current = undoable.current.filter((id) => id !== task.id);
        composer.dismissToast(toast);
        toasts.current.delete(task.id);
        setMessage(result.error);
        return;
      }
      router.refresh();
    });
  }

  async function undo(id: string) {
    if (!undoable.current.includes(id)) return;
    undoable.current = undoable.current.filter((item) => item !== id);
    const toast = toasts.current.get(id);
    if (toast !== undefined) composer.dismissToast(toast);
    toasts.current.delete(id);
    const pending = completing.current.get(id);
    const finished: Outcome = pending ? await pending : {};
    if (finished.error) return;
    forget(id);
    const result: Outcome = await reopenTaskAction(id).catch(() => ({ error: "Couldn't undo. Try again." }));
    if (result.error) {
      setDone((current) => new Set(current).add(id));
      setMessage(result.error);
      return;
    }
    router.refresh();
  }

  function undoLast() {
    const id = undoable.current[undoable.current.length - 1];
    if (!id) return false;
    void undo(id);
    return true;
  }

  function remind(task: Task) {
    const now = Date.now();
    composer.pickLater({
      title: "Remind me",
      description: "Moves the due date.",
      options: taskRemindChoices(task.dueAt, new Date(now)),
      now,
      onPick: (at) => {
        setMessage(null);
        void remindTaskAction(task.id, at)
          .catch(() => ({ error: "Couldn't move the task. Try again." }))
          .then((result: Outcome) => {
            if (result.error) {
              setMessage(result.error);
              return;
            }
            composer.showToast({ message: `Due ${laterDetail(onWorkingDay(new Date(at)), Date.now())}.` });
            router.refresh();
          });
      },
    });
  }

  return { done, message, setMessage, complete, undo, undoLast, remind };
}
