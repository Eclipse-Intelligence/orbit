"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { settingsAnchorRedirect } from "@/lib/settings-nav";

export default function SettingsHashRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const next = settingsAnchorRedirect(pathname, window.location.search, window.location.hash);
    if (next) router.replace(next);
  }, [router, pathname]);
  return null;
}
