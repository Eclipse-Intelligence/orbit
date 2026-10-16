"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { dueRemindersAction } from "@/app/(crm)/records";
import { reminderFireAt, reminderHeadline } from "@/lib/crm/reminder-options";
import { TASKS_PATH } from "@/lib/crm/task-views";
import type { DueReminder } from "@/lib/crm/tasks";
import {
  markReminderFired,
  notificationPermission,
  reminderFired,
  reminderKey,
  requestReminderPermission,
} from "@/lib/reminder-alerts";

const POLL_MS = 60_000;

type Alert = { key: string; reminder: DueReminder; headline: string };

export default function TaskReminders() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [permission, setPermission] = useState<string>("unsupported");
  const timers = useRef(new Map<string, number>());

  const fire = useCallback(
    (key: string, reminder: DueReminder) => {
      timers.current.delete(key);
      if (reminderFired(key)) return;
      markReminderFired(key);
      const headline = reminderHeadline(reminder.dueAt);
      const about = reminder.contactName ?? reminder.companyName;
      if (notificationPermission() === "granted") {
        try {
          const notification = new Notification(headline, {
            body: about ? `${reminder.title} · ${about}` : reminder.title,
            tag: key,
          });
          notification.onclick = () => {
            window.focus();
            router.push(TASKS_PATH);
            notification.close();
          };
        } catch {}
      }
      setAlerts((current) =>
        current.some((alert) => alert.key === key) ? current : [...current, { key, reminder, headline }],
      );
    },
    [router],
  );

  const refresh = useCallback(async () => {
    let reminders: DueReminder[];
    try {
      reminders = await dueRemindersAction();
    } catch {
      return;
    }
    const now = Date.now();
    const wanted = new Set<string>();
    for (const reminder of reminders) {
      const key = reminderKey(reminder.id, reminder.dueAt, reminder.remindMinutes);
      wanted.add(key);
      if (timers.current.has(key) || reminderFired(key)) continue;
      const delay = Math.max(0, reminderFireAt(reminder.dueAt, reminder.remindMinutes) - now);
      timers.current.set(key, window.setTimeout(() => fire(key, reminder), delay));
    }
    for (const [key, timer] of timers.current) {
      if (wanted.has(key)) continue;
      window.clearTimeout(timer);
      timers.current.delete(key);
    }
  }, [fire]);

  useEffect(() => {
    const active = timers.current;
    const sync = () => setPermission(notificationPermission());
    const initial = window.setTimeout(() => {
      sync();
      void refresh();
    }, 0);
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      sync();
      void refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      for (const timer of active.values()) window.clearTimeout(timer);
      active.clear();
    };
  }, [refresh]);

  if (alerts.length === 0) return null;

  function dismiss(key: string) {
    setAlerts((current) => current.filter((alert) => alert.key !== key));
  }

  return (
    <div className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] left-1/2 z-50 flex w-[min(24em,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
      {alerts.map((alert) => {
        const about = alert.reminder.contactName ?? alert.reminder.companyName;
        return (
          <div
            key={alert.key}
            role="alert"
            className="border-line-strong bg-popover shadow-overlay animate-in fade-in-0 slide-in-from-bottom-2 ease-power3-out pointer-events-auto flex flex-col gap-3 rounded-xl border p-3 duration-200"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="caption-style text-warning">{alert.headline}</span>
              <span className="truncate text-[14px] leading-5">{alert.reminder.title}</span>
              {about && <span className="caption-style text-subtle truncate">{about}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={() => {
                  dismiss(alert.key);
                  router.push(TASKS_PATH);
                }}
              >
                Open tasks
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={() => dismiss(alert.key)}>
                Dismiss
              </Button>
              {permission === "default" && (
                <Button
                  variant="link"
                  size="none"
                  type="button"
                  className="caption-style ml-auto"
                  onClick={() => void requestReminderPermission().then((next) => setPermission(next))}
                >
                  Turn on browser alerts
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
