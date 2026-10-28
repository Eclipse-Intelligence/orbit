"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(display-mode: standalone)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function standalone() {
  return window.matchMedia(QUERY).matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function useStandalone() {
  return useSyncExternalStore(subscribe, standalone, () => false);
}
