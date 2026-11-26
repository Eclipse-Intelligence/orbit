"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { refreshPush, registerServiceWorker } from "@/components/push/push-client";
import { linkInWorkspace } from "@/lib/open-link";
import { pushTrail, trailPath } from "@/components/push/trail";

export const OPEN_THREAD_EVENT = "orbit:open-thread";

const PENDING_CACHE = "orbit-pending";
const PENDING_KEY = "/__orbit-pending";
const FRESH_MS = 60_000;
const PENDING_CHECKS_MS = [0, 300, 800, 1600, 3000, 5000];

async function takeCachedPending() {
  if (!("caches" in window)) return null;
  const cache = await caches.open(PENDING_CACHE);
  const hit = await cache.match(PENDING_KEY);
  if (!hit) return null;
  await caches.delete(PENDING_CACHE);
  const value = (await hit.json().catch(() => null)) as { url?: unknown; at?: unknown; id?: unknown } | null;
  const fresh = value && typeof value.url === "string" && typeof value.at === "number" && Date.now() - value.at < FRESH_MS ? value.url : null;
  pushTrail("page-cache", { id: value?.id ?? null, fresh: Boolean(fresh), ageMs: typeof value?.at === "number" ? Date.now() - value.at : null, path: window.location.pathname });
  return fresh;
}

export default function PushRegistrar({ workspaceId }: { workspaceId?: string }) {
  const router = useRouter();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let last: string | null = null;
    const open = (value: unknown, source: string) => {
      if (typeof value !== "string") return;
      if (value === last) {
        pushTrail("page-open", { source, how: "repeat", path: window.location.pathname });
        return;
      }
      last = value;
      window.setTimeout(() => {
        if (last === value) last = null;
      }, 5_000);
      const first = new URL(value, window.location.origin);
      if (first.origin !== window.location.origin) return;
      const target = linkInWorkspace(`${first.pathname}${first.search}`, workspaceId);
      const url = new URL(target.path, window.location.origin);
      const thread = url.searchParams.get("thread");
      const event = (thread || !url.search) && url.pathname === "/mail" && window.location.pathname === "/mail";
      pushTrail("page-open", { source, target: target.path, from: trailPath(), how: target.reload ? "reload" : event ? "event" : "navigate" });
      if (target.reload) {
        window.location.assign(target.path);
        return;
      }
      if (event) {
        window.dispatchEvent(new CustomEvent(OPEN_THREAD_EVENT, { detail: { thread, view: url.searchParams.get("view") } }));
        return;
      }
      router.push(`${url.pathname}${url.search}`);
    };
    const askWorker = async () => {
      const registration = await navigator.serviceWorker.ready;
      const worker = navigator.serviceWorker.controller ?? registration.active;
      if (!worker) return;
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => open(event.data, "worker");
      worker.postMessage({ type: "orbit-pending" }, [channel.port2]);
    };
    const checkPending = () => {
      void takeCachedPending()
        .then((url) => (url ? open(url, "cache") : askWorker()))
        .catch(() => askWorker().catch(() => undefined));
    };
    let checks: number[] = [];
    const watchPending = () => {
      checks.forEach((timer) => window.clearTimeout(timer));
      checks = PENDING_CHECKS_MS.map((delay) => window.setTimeout(checkPending, delay));
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "orbit-open") return;
      pushTrail("page-message", { id: event.data.id ?? null, path: window.location.pathname });
      open(event.data.url, "message");
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") watchPending();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", watchPending);
    window.addEventListener("focus", watchPending);
    pushTrail("page-start", { path: trailPath(), standalone: window.matchMedia("(display-mode: standalone)").matches, controlled: Boolean(navigator.serviceWorker.controller) });
    void registerServiceWorker().then(async () => {
      await refreshPush();
      pushTrail("page-ready", { path: window.location.pathname });
      watchPending();
    });
    return () => {
      checks.forEach((timer) => window.clearTimeout(timer));
      navigator.serviceWorker.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", watchPending);
      window.removeEventListener("focus", watchPending);
    };
  }, [router, workspaceId]);

  return null;
}
