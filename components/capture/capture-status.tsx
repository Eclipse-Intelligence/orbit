"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useSyncSignal } from "@/components/crm/sync-signals";
import type { CaptureBadges } from "@/lib/crm/capture";
import { captureBadgeFrom, useCompaniesStore } from "@/stores/companies-store";

const REFRESH_GAP_MS = 60_000;

export default function CaptureStatus() {
  const pathname = usePathname();
  const live = useCompaniesStore((state) => state.captureLive);
  const signalled = useRef<() => void>(() => undefined);
  const navigated = useRef<() => void>(() => undefined);

  useSyncSignal("mail", () => signalled.current());

  useEffect(() => {
    navigated.current();
  }, [pathname]);

  useEffect(() => {
    if (live) return;
    let last = 0;
    let active = true;
    const fetchStatus = () => {
      last = Date.now();
      fetch("/api/capture/status", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<CaptureBadges>) : null))
        .then((body) => {
          if (!active || !body) return;
          const state = useCompaniesStore.getState();
          if (state.captureLive) return;
          if (body.status) state.setCapture(captureBadgeFrom(body.status, state.capture));
          state.setCaptureWaiting(body.waiting);
        })
        .catch(() => null);
    };
    const load = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < REFRESH_GAP_MS) return;
      fetchStatus();
    };
    signalled.current = () => {
      if (document.visibilityState === "visible") fetchStatus();
      else last = 0;
    };
    navigated.current = load;
    load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      signalled.current = () => undefined;
      navigated.current = () => undefined;
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [live]);

  return null;
}
