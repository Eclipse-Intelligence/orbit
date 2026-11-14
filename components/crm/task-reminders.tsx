"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { pushState } from "@/components/push/push-client";
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
  alertRenderKey,
  keyboardUp,
  restingView,
  shownAlert,
  typingInto,
  type RestingView,
} from "@/lib/reminder-alerts";

const POLL_MS = 60_000;

type Alert = { key: string; reminder: DueReminder; headline: string };

export default function TaskReminders() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [permission, setPermission] = useState<string>("unsupported");
  const timers = useRef(new Map<string, number>());
  const devicePushed = useRef(false);
  const [keyboard, setKeyboard] = useState(false);
  const [lastShown, setLastShown] = useState<string | null>(null);

  useEffect(() => {
    const view = window.visualViewport;
    const coarse = window.matchMedia("(pointer: coarse)");
    const visibleHeight = () => (view ? view.height * view.scale : window.innerHeight);
    let resting: RestingView = { width: window.innerWidth, height: visibleHeight() };
    let timer = 0;
    const check = () => {
      const height = visibleHeight();
      const typing = coarse.matches && typingInto(document.activeElement);
      resting = restingView(resting, { width: window.innerWidth, height, layoutHeight: window.innerHeight, typing });
      setKeyboard(keyboardUp(resting.height, height, typing));
    };
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, 0);
    };
    soon();
    view?.addEventListener("resize", soon);
    window.addEventListener("resize", soon);
    document.addEventListener("focusin", soon);
    document.addEventListener("focusout", soon);
    return () => {
      window.clearTimeout(timer);
      view?.removeEventListener("resize", soon);
      window.removeEventListener("resize", soon);
      document.removeEventListener("focusin", soon);
      document.removeEventListener("focusout", soon);
    };
  }, []);

  const fire = useCallback(
    (key: string, reminder: DueReminder) => {
      timers.current.delete(key);
      if (reminderFired(key)) return;
      markReminderFired(key);
      const headline = reminderHeadline(reminder.dueAt);
      const about = reminder.contactName ?? reminder.companyName;
      if (notificationPermission() === "granted" && !(reminder.pushed && devicePushed.current)) {
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
    devicePushed.current = await pushState().then(
      (state) => state === "on",
      () => false,
    );
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

  const { alert, more } = shownAlert(alerts);
  if (alert && !keyboard && alert.key !== lastShown) setLastShown(alert.key);
  if (!alert) return null;

  function dismiss(key: string) {
    setAlerts((current) => current.filter((alert) => alert.key !== key));
  }

  const about = alert.reminder.contactName ?? alert.reminder.companyName;
  return (
    <div
      hidden={keyboard}
      className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] left-1/2 z-50 flex w-[min(24em,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2"
    >
      <div
        key={alertRenderKey(alert.key, keyboard, lastShown)}
        role="alert"
        className="border-line-strong bg-popover shadow-overlay animate-in fade-in-0 slide-in-from-bottom-2 ease-power3-out pointer-events-auto flex flex-col gap-3 rounded-xl border p-3 duration-200"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <span className="caption-style flex items-baseline gap-2">
            <span className="text-warning min-w-0 flex-1 truncate">{alert.headline}</span>
            {more > 0 && <span className="text-subtle shrink-0">+{more} more</span>}
          </span>
          <span className="truncate text-[14px] leading-5">{alert.reminder.title}</span>
          {about && <span className="caption-style text-subtle truncate">{about}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 [@media(pointer:coarse)]:gap-x-3 [@media(pointer:coarse)]:gap-y-6">
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => {
              setAlerts([]);
              router.push(TASKS_PATH);
            }}
            className="hit"
          >
            Open tasks
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={() => dismiss(alert.key)} className="hit">
            Dismiss
          </Button>
          {permission === "default" && (
            <Button
              variant="link"
              size="none"
              type="button"
              className="caption-style hit ml-auto"
              onClick={() => void requestReminderPermission().then((next) => setPermission(next))}
            >
              Turn on browser alerts
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
