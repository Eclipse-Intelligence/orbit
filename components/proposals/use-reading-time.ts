"use client";

import { useEffect, useRef } from "react";

const FLUSH_FROM_SECONDS = 3;

export function useReadingTime(token: string, label: string, enabled: boolean) {
  const state = useRef<{ label: string; since: number | null; totals: Record<string, number> }>({ label, since: null, totals: {} });

  useEffect(() => {
    if (!enabled) return;
    const current = state.current;
    const settle = () => {
      if (current.since !== null) {
        current.totals[current.label] = (current.totals[current.label] ?? 0) + (Date.now() - current.since) / 1000;
        current.since = document.visibilityState === "visible" ? Date.now() : null;
      }
    };
    const flush = () => {
      settle();
      const total = Object.values(current.totals).reduce((sum, value) => sum + value, 0);
      if (total < FLUSH_FROM_SECONDS) return;
      const tabs = Object.fromEntries(Object.entries(current.totals).map(([key, value]) => [key, Math.round(value)]));
      current.totals = {};
      const body = JSON.stringify({ tabs });
      if (!navigator.sendBeacon?.(`/api/p/${token}/reading`, new Blob([body], { type: "text/plain" }))) {
        void fetch(`/api/p/${token}/reading`, { method: "POST", body, keepalive: true }).catch(() => undefined);
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        flush();
        current.since = null;
      } else current.since = Date.now();
    };
    current.since = document.visibilityState === "visible" ? Date.now() : null;
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [token, enabled]);

  useEffect(() => {
    const current = state.current;
    if (current.label === label) return;
    if (current.since !== null) {
      current.totals[current.label] = (current.totals[current.label] ?? 0) + (Date.now() - current.since) / 1000;
      current.since = Date.now();
    }
    current.label = label;
  }, [label]);
}
