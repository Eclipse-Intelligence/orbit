"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { refreshPush, registerServiceWorker } from "@/components/push/push-client";

export const OPEN_THREAD_EVENT = "orbit:open-thread";

export default function PushRegistrar() {
  const router = useRouter();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const open = (value: unknown) => {
      if (typeof value !== "string") return;
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin) return;
      const thread = url.searchParams.get("thread");
      if (thread && url.pathname === "/mail" && window.location.pathname === "/mail") {
        window.dispatchEvent(new CustomEvent(OPEN_THREAD_EVENT, { detail: { thread } }));
        return;
      }
      router.push(`${url.pathname}${url.search}`);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "orbit-open") open(event.data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    void registerServiceWorker().then(async () => {
      await refreshPush();
      const registration = await navigator.serviceWorker.ready;
      const worker = navigator.serviceWorker.controller ?? registration.active;
      if (!worker) return;
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => open(event.data);
      worker.postMessage({ type: "orbit-pending" }, [channel.port2]);
    });
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  return null;
}
