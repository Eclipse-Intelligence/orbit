"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { tickReminderAction, undoReminderAction } from "@/app/(crm)/reminders";
import type { Reminder } from "@/lib/crm/reminders";
import { settledTicks } from "@/lib/reminder-calendar";
import type { HeldTick } from "@/lib/reminders-card";
import { useCompaniesStore } from "@/stores/companies-store";

const TOAST_MS = 5_000;
const TICK_FAILED = "Couldn't mark it done. Try again.";
const UNDO_FAILED = "Couldn't undo. Try again.";

type Toast = { id: number; reminderId: string };

function without<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function useReminderTicks({ by, onChanged }: { by: string; onChanged: () => void }) {
  const touch = useCompaniesStore((state) => state.touchReminders);
  const [held, setHeld] = useState<Record<string, HeldTick>>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Map<string, Promise<string | null>>());
  const ticked = useRef(new Map<string, string>());
  const latest = useRef(onChanged);
  useEffect(() => {
    latest.current = onChanged;
  });

  const changed = useCallback(() => {
    touch(by);
    latest.current();
  }, [by, touch]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const tick = useCallback(
    (reminder: Reminder) => {
      if (reminder.completedAt || pending.current.has(reminder.id)) return;
      setError(null);
      setHeld((current) => ({ ...current, [reminder.id]: { snapshot: reminder, doneId: null } }));
      setToast({ id: Date.now(), reminderId: reminder.id });
      const drop = () => {
        setHeld((current) => without(current, reminder.id));
        setToast((current) => (current?.reminderId === reminder.id ? null : current));
      };
      const work = tickReminderAction(reminder.id, reminder.dueOn)
        .catch(() => null)
        .then((result) => {
          if (!result || "error" in result) {
            setError(result?.error ?? TICK_FAILED);
            drop();
            latest.current();
            return null;
          }
          if (!result.changed || !result.doneId) {
            drop();
            changed();
            return null;
          }
          const doneId = result.doneId;
          ticked.current.set(reminder.id, doneId);
          setHeld((current) => (current[reminder.id] ? { ...current, [reminder.id]: { ...current[reminder.id], doneId } } : current));
          changed();
          return doneId;
        });
      pending.current.set(reminder.id, work);
    },
    [changed],
  );

  const reopen = useCallback(
    async (id: string) => {
      setError(null);
      const result = await undoReminderAction(id).catch(() => null);
      if (!result || "error" in result) {
        if (!result?.missing) setError(result?.error ?? UNDO_FAILED);
        latest.current();
        return;
      }
      changed();
    },
    [changed],
  );

  const undo = useCallback(
    async (reminderId: string) => {
      const work = pending.current.get(reminderId);
      const doneId = (work ? await work : null) ?? ticked.current.get(reminderId) ?? null;
      pending.current.delete(reminderId);
      ticked.current.delete(reminderId);
      setToast((current) => (current?.reminderId === reminderId ? null : current));
      if (!doneId) {
        setHeld((current) => without(current, reminderId));
        return;
      }
      await reopen(doneId);
      setHeld((current) => without(current, reminderId));
    },
    [reopen],
  );

  const settle = useCallback((reminders: Reminder[]) => {
    setHeld((current) => {
      const next = settledTicks(current, reminders);
      for (const id of Object.keys(current)) if (!(id in next)) pending.current.delete(id);
      return next;
    });
  }, []);

  return { held, toast, error, tick, undo, reopen, settle, clearError: () => setError(null) };
}

export function ReminderUndoToast({ toast, onUndo }: { toast: Toast | null; onUndo: (reminderId: string) => void }) {
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-50 flex justify-center px-4">
      <div
        role="status"
        className="bg-surface-active shadow-overlay caption-style animate-in fade-in-0 slide-in-from-bottom-1 ease-power3-out pointer-events-auto flex max-w-full items-center gap-2.5 rounded-full py-1.5 pr-1.5 pl-3.5 backdrop-blur duration-200"
      >
        <span className="text-foreground truncate">Marked done</span>
        <Button variant="secondary" size="sm" className="hit h-6 rounded-full py-0" onClick={() => onUndo(toast.reminderId)}>
          Undo
        </Button>
      </div>
    </div>
  );
}
