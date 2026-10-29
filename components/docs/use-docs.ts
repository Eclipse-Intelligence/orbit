"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { DocsNav, DocsSeed } from "@/lib/docs/client-types";
import { localDate } from "@/lib/docs/daily";
import { isDocsPath } from "@/lib/docs/routes";
import { useDocsStore } from "@/stores/docs-store";

export const NOTE_TYPE = "application/x-orbit-note";

export type DocsContextValue = { seed: DocsSeed; nav: DocsNav };

export const DocsContext = createContext<DocsContextValue | null>(null);

export function useDocsNav() {
  const context = useContext(DocsContext);
  const live = useDocsStore((state) => state.nav);
  return live ?? context?.nav ?? null;
}

export function useDocsNow() {
  const context = useContext(DocsContext);
  const live = useDocsStore((state) => (state.ready ? state.now : null));
  return live ?? context?.seed.now ?? new Date(0).toISOString();
}

export function navigateWithinDocs(href: string, replace = false) {
  if (typeof window === "undefined" || !isDocsPath(window.location.pathname) || !isDocsPath(href.split("?")[0])) return false;
  if (`${window.location.pathname}${window.location.search}` === href) return true;
  if (replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  return true;
}

export function useDocsNavigate() {
  const router = useRouter();
  return useCallback(
    (href: string, options: { replace?: boolean; newTab?: boolean } = {}) => {
      if (options.newTab) {
        window.open(href, "_blank", "noopener");
        return;
      }
      if (navigateWithinDocs(href, options.replace)) return;
      if (options.replace) router.replace(href);
      else router.push(href);
    },
    [router],
  );
}

export function useMedia(query: string, serverValue = false) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

function subscribeToday(listener: () => void) {
  const timer = window.setInterval(listener, 30_000);
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
  };
}

export function useToday() {
  const nav = useDocsNav();
  const fallback = nav?.today ?? "";
  return useSyncExternalStore(
    subscribeToday,
    () => localDate(),
    () => fallback,
  );
}
