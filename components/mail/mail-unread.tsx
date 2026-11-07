"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useCompaniesStore } from "@/stores/companies-store";

const REFRESH_GAP_MS = 60_000;

export default function MailUnread() {
  const pathname = usePathname();
  const onMail = pathname === "/mail" || pathname.startsWith("/mail/");

  useEffect(() => {
    if (onMail) return;
    let last = 0;
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < REFRESH_GAP_MS) return;
      last = Date.now();
      fetch("/api/mail/unread", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<{ unread?: number }>) : null))
        .then((body) => {
          if (live && typeof body?.unread === "number") useCompaniesStore.getState().setMailUnread(body.unread);
        })
        .catch(() => null);
    };
    load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [onMail]);

  return null;
}
