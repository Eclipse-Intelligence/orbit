"use client";

import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import Button from "@/components/_ui/button";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";

const QUERY = "(display-mode: standalone)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function standalone() {
  return window.matchMedia(QUERY).matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export default function StandaloneBack() {
  const router = useRouter();
  const inApp = useSyncExternalStore(subscribe, standalone, () => false);
  if (!inApp) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      aria-label="Back to Orbit"
      onClick={() => {
        const fromOrbit = document.referrer.startsWith(window.location.origin) && !new URL(document.referrer).pathname.startsWith(window.location.pathname);
        if (fromOrbit && window.history.length > 1) window.history.back();
        else router.push("/mail");
      }}
      className="fixed top-[calc(env(safe-area-inset-top)+0.75rem)] left-3 z-50 gap-1 pr-3"
    >
      <ChevronLeftIcon aria-hidden className="size-3.5" />
      Orbit
    </Button>
  );
}
