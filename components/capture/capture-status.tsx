"use client";

import { useEffect, useRef } from "react";
import { useSyncSignal } from "@/components/crm/sync-signals";
import type { CaptureBadges } from "@/lib/crm/capture";
import { captureBadgeFrom, useCompaniesStore } from "@/stores/companies-store";

const REFRESH_GAP_MS = 60_000;
const SIGNAL_GAP_MS = 30_000;
const SETTLE_MS = 2_500;

export default function CaptureStatus({ renderedAt }: { renderedAt: number }) {
  const signalled = useRef<() => void>(() => undefined);
  const rendered = useRef<() => void>(() => undefined);

  useSyncSignal("mail", () => signalled.current());

  useEffect(() => {
    rendered.current();
  }, [renderedAt]);

  useEffect(() => {
    let last = 0;
    let active = true;
    let running = false;
    let again = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let signalWait: ReturnType<typeof setTimeout> | undefined;
    const fetchStatus = () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      last = Date.now();
      fetch("/api/capture/status", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<CaptureBadges>) : null))
        .then((body) => {
          if (!active || !body || again) return;
          const state = useCompaniesStore.getState();
          if (body.status) state.setCapture(captureBadgeFrom(body.status, state.capture));
          state.setCaptureWaiting(body.waiting);
        })
        .catch(() => null)
        .finally(() => {
          running = false;
          if (!active || !again) return;
          again = false;
          fetchStatus();
        });
    };
    const load = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < REFRESH_GAP_MS) return;
      fetchStatus();
    };
    const later = () => {
      clearTimeout(settle);
      settle = setTimeout(fetchStatus, SETTLE_MS);
    };
    signalled.current = () => {
      if (document.visibilityState !== "visible") {
        last = 0;
        return;
      }
      if (signalWait) return;
      signalWait = setTimeout(() => {
        signalWait = undefined;
        if (document.visibilityState === "visible") fetchStatus();
        else last = 0;
      }, Math.max(0, last + SIGNAL_GAP_MS - Date.now()));
    };
    rendered.current = later;
    later();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearTimeout(settle);
      clearTimeout(signalWait);
      signalled.current = () => undefined;
      rendered.current = () => undefined;
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  return null;
}
