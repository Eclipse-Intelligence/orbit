"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DocsContext } from "@/components/docs/use-docs";
import { setBadge } from "@/components/push/push-client";
import type { Notification } from "@/lib/workflows/store";

type Attention = { notifications: Notification[]; teamUnread: number; refresh: () => void };

const NONE: Notification[] = [];

const AttentionContext = createContext<Attention>({ notifications: NONE, teamUnread: 0, refresh: () => {} });

const POLL_MS = 60_000;
const FOCUS_GAP_MS = 5_000;

type Fetched = { notifications?: Notification[]; teamUnread?: number | null; badge?: number | null };

export function AttentionProvider({ notifications = NONE, teamUnread = 0, children }: { notifications?: Notification[]; teamUnread?: number; children: ReactNode }) {
  const seed = useContext(DocsContext)?.seed ?? null;
  const [served, setServed] = useState({ notifications, teamUnread });
  const [state, setState] = useState({ notifications, teamUnread });
  if (served.notifications !== notifications || served.teamUnread !== teamUnread) {
    setServed({ notifications, teamUnread });
    setState({ notifications, teamUnread });
  }
  const live = seed?.live ?? null;
  const publish = seed?.livePublish === true;
  const userId = seed?.viewer.id ?? null;
  const workspaceId = seed?.workspaceId ?? null;
  const loader = useRef<() => void>(() => {});

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
      void fetch("/api/notifications", { cache: "no-store", credentials: "same-origin" })
        .then((response) => (response.ok ? (response.json() as Promise<Fetched>) : null))
        .then((body) => {
          if (stopped || !body?.notifications) return;
          const fresh = body.notifications;
          setState((current) => ({ notifications: fresh, teamUnread: typeof body.teamUnread === "number" ? body.teamUnread : current.teamUnread }));
          if (typeof body.badge === "number") setBadge(body.badge);
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
    loader.current = load;
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
              const rejoined = now && !joined;
              joined = now;
              if (rejoined) load();
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
      loader.current = () => {};
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      stopLive?.();
    };
  }, [live, publish, userId, workspaceId]);

  const refresh = useCallback(() => loader.current(), []);
  const value = useMemo(() => ({ notifications: state.notifications, teamUnread: state.teamUnread, refresh }), [state, refresh]);
  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}

export function useNotifications() {
  return useContext(AttentionContext).notifications;
}

export function useTeamUnread() {
  return useContext(AttentionContext).teamUnread;
}

export function useRefreshNotifications() {
  return useContext(AttentionContext).refresh;
}
