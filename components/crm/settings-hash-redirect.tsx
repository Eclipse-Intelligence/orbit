"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { settingsHashTarget } from "@/lib/settings-nav";

export default function SettingsHashRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const target = settingsHashTarget(window.location.hash);
    if (!target || target === pathname) return;
    router.replace(`${target}${window.location.search}${window.location.hash}`);
  }, [router, pathname]);
  return null;
}
