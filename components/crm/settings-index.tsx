"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export default function SettingsIndex() {
  const router = useRouter();
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const open = () => {
      if (wide.matches) router.replace(`${SETTINGS_PATHS.general}${window.location.hash}`);
    };
    open();
    wide.addEventListener("change", open);
    return () => wide.removeEventListener("change", open);
  }, [router]);
  return null;
}
