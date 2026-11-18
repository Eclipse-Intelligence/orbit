"use client";

import { useEffect, useRef } from "react";
import { useSyncSignal } from "@/components/crm/sync-signals";
import { useCompaniesStore } from "@/stores/companies-store";

const REFRESH_GAP_MS = 60_000;

export default function CampaignsWaiting() {
  const signalled = useRef<() => void>(() => undefined);

  useSyncSignal("campaigns", () => signalled.current());

  useEffect(() => {
    let last = 0;
    let live = true;
    const fetchWaiting = () => {
      last = Date.now();
      fetch("/api/campaigns/waiting", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<{ waiting?: number }>) : null))
        .then((body) => {
          if (live && typeof body?.waiting === "number") useCompaniesStore.getState().setCampaignsWaiting(body.waiting);
        })
        .catch(() => null);
    };
    const load = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < REFRESH_GAP_MS) return;
      fetchWaiting();
    };
    signalled.current = () => {
      if (document.visibilityState === "visible") fetchWaiting();
      else last = 0;
    };
    load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      signalled.current = () => undefined;
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  return null;
}
