"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { listNotificationsAction } from "@/app/(crm)/workflows/actions";
import { DocsContext } from "@/components/docs/use-docs";
import type { Notification } from "@/lib/workflows/store";

const NotificationsContext = createContext<Notification[]>([]);

const POLL_MS = 60_000;
const FOCUS_GAP_MS = 5_000;

export function AttentionProvider({ notifications = [], children }: { notifications?: Notification[]; children: ReactNode }) {
  const seed = useContext(DocsContext)?.seed ?? null;
  const [served, setServed] = useState(notifications);
  const [items, setItems] = useState(notifications);
  if (served !== notifications) {
    setServed(notifications);
    setItems(notifications);
  }
  const live = seed?.live ?? null;
  const publish = seed?.livePublish === true;
  const userId = seed?.viewer.id ?? null;
  const workspaceId = seed?.workspaceId ?? null;

  useEffect(() => {
    let stopped = false;
    let joined = false;
    let running = false;
    let again = false;
    let last = Date.now();
    let stopLive: (() => void) | null = null;

    const load = () => {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      last = Date.now();
      void listNotificationsAction()
        .then((result) => {
          if (!stopped && result.notifications) setItems(result.notifications);
        })
        .catch(() => undefined)
        .finally(() => {
          running = false;
          if (again) {
            again = false;
            load();
          }
        });
    };
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= FOCUS_GAP_MS) load();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !(joined && publish)) load();
    }, POLL_MS);

    if (live && userId && workspaceId) {
      void import("@/lib/docs/live/client")
        .then((module) =>
          module.watchLiveActivity(
            live,
            { workspaceId, userId },
            null,
            (now) => {
              joined = now;
            },
            () => load(),
          ),
        )
        .then((stop) => {
          if (stopped) stop();
          else stopLive = stop;
        })
        .catch(() => undefined);
    }

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      stopLive?.();
    };
  }, [live, publish, userId, workspaceId]);

  return <NotificationsContext.Provider value={items}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  return useContext(NotificationsContext);
}
