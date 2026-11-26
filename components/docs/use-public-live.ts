import { useEffect, useState } from "react";
import { publicLive } from "@/lib/docs/public-expiry";

const LONGEST_TIMEOUT = 2 ** 31 - 1;

export function usePublicLive(summary: { public: boolean; publicExpiresAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = summary.publicExpiresAt;
  useEffect(() => {
    if (expiresAt === null) return;
    const wait = Date.parse(expiresAt) - Date.now();
    if (wait <= 0 || wait > LONGEST_TIMEOUT) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return publicLive(summary.public, expiresAt, now);
}
