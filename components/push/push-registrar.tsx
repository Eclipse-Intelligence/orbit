"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { refreshPush, registerServiceWorker } from "@/components/push/push-client";

export const OPEN_THREAD_EVENT = "orbit:open-thread";

const PENDING_CACHE = "orbit-pending";
const PENDING_KEY = "/__orbit-pending";
const FRESH_MS = 60_000;

async function takeCachedPending() {
  if (!("caches" in window)) return null;
  const cache = await caches.open(PENDING_CACHE);
  const hit = await cache.match(PENDING_KEY);
  if (!hit) return null;
  await caches.delete(PENDING_CACHE);
  const value = (await hit.json().catch(() => null)) as { url?: unknown; at?: unknown } | null;
  return value && typeof value.url === "string" && typeof value.at === "number" && Date.now() - value.at < FRESH_MS ? value.url : null;
}

export default function PushRegistrar() {
  const router = useRouter();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let last: string | null = null;
    const open = (value: unknown) => {
      if (typeof value !== "string" || value === last) return;
      last = value;
      window.setTimeout(() => {
        if (last === value) last = null;
      }, 5_000);
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin) return;
      const thread = url.searchParams.get("thread");
      if (thread && url.pathname === "/mail" && window.location.pathname === "/mail") {
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
      channel.port1.onmessage = (event) => open(event.data);
      worker.postMessage({ type: "orbit-pending" }, [channel.port2]);
    };
    const checkPending = () => {
      void takeCachedPending()
        .then((url) => (url ? open(url) : askWorker()))
        .catch(() => askWorker().catch(() => undefined));
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "orbit-open") open(event.data.url);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") checkPending();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", checkPending);
    window.addEventListener("focus", checkPending);
    void registerServiceWorker().then(async () => {
      await refreshPush();
      checkPending();
    });
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", checkPending);
      window.removeEventListener("focus", checkPending);
    };
  }, [router]);

  return null;
}
