"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { settingsHashTarget } from "@/lib/settings-nav";

export default function SettingsHashRedirect() {
  const router = useRouter();
  useEffect(() => {
    const target = settingsHashTarget(window.location.hash);
    if (!target) return;
    router.replace(`${target}${window.location.search}`);
  }, [router]);
  return null;
}
