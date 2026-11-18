"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useSyncSignal } from "@/components/crm/sync-signals";
import { useCompaniesStore } from "@/stores/companies-store";

const REFRESH_GAP_MS = 60_000;

export default function MailUnread() {
  const pathname = usePathname();
  const onMail = pathname === "/mail" || pathname.startsWith("/mail/");
  const signalled = useRef<() => void>(() => undefined);

  useSyncSignal("mail", () => signalled.current());

  useEffect(() => {
    if (onMail) return;
    let last = 0;
    let live = true;
    const fetchUnread = () => {
      last = Date.now();
      fetch("/api/mail/unread", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<{ unread?: number }>) : null))
        .then((body) => {
          if (live && typeof body?.unread === "number") useCompaniesStore.getState().setMailUnread(body.unread);
        })
        .catch(() => null);
    };
    const load = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < REFRESH_GAP_MS) return;
      fetchUnread();
    };
    signalled.current = () => {
      if (document.visibilityState === "visible") fetchUnread();
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
  }, [onMail]);

  return null;
}
