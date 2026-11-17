"use client";

import { useEffect, useState } from "react";
import type { MailAddress } from "@/lib/mail/types";

const WAIT_MS = 300;

export function useSuppressionCaution(recipients: MailAddress[]) {
  const key = JSON.stringify(
    recipients
      .map((item) => ({ address: item.address.trim().toLowerCase(), name: item.name ?? null }))
      .filter((item) => item.address)
      .sort((a, b) => a.address.localeCompare(b.address)),
  );
  const [found, setFound] = useState<{ key: string; line: string | null }>({ key: "[]", line: null });

  useEffect(() => {
    if (key === "[]") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch("/api/mail/suppressed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipients: JSON.parse(key) }),
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { line?: unknown } | null) => setFound({ key, line: typeof body?.line === "string" ? body.line : null }))
        .catch(() => undefined);
    }, WAIT_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  return found.key === key ? found.line : null;
}
