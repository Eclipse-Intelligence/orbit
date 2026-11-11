"use client";

import { useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { DocsContext } from "@/components/docs/use-docs";
import { chatApi } from "@/lib/chat/client";
import { sidebarRead } from "@/lib/chat/timeline";
import type { ChatLiveEvent } from "@/lib/chat/types";
import { useCompaniesStore } from "@/stores/companies-store";

type Listener = (event: ChatLiveEvent) => void;

const POLL_IDLE_MS = 60_000;
const POLL_CHAT_MS = 15_000;
const FOCUS_GAP_MS = 5_000;
const EVENT_SETTLE_MS = 400;

const listeners = new Set<Listener>();
const joinListeners = new Set<() => void>();
let joined = false;
let reload: () => void = () => {};
let viewing: string | null = null;

export function setChatViewing(conversationId: string | null) {
  viewing = conversationId;
  if (conversationId) useCompaniesStore.getState().setChat((current) => (current ? sidebarRead(current, conversationId) : current));
}

function setJoined(next: boolean) {
  if (joined === next) return;
  joined = next;
  for (const listener of joinListeners) listener();
}

export function chatJoined() {
  return joined;
}

export function refreshChatSidebar() {
  reload();
}

export function useChatEvents(handler: Listener) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const listener: Listener = (event) => latest.current(event);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}

function subscribeJoined(listener: () => void) {
  joinListeners.add(listener);
  return () => {
    joinListeners.delete(listener);
  };
}

export function useChatJoined() {
  return useSyncExternalStore(
    subscribeJoined,
    () => joined,
    () => false,
  );
}

export default function ChatLive() {
  const seed = useContext(DocsContext)?.seed ?? null;
  const live = seed?.live ?? null;
  const publish = seed?.livePublish === true;
  const userId = seed?.viewer.id ?? null;
  const pathname = usePathname();
  const onChat = useRef(false);
  useEffect(() => {
    onChat.current = pathname === "/chat" || pathname.startsWith("/chat/");
  }, [pathname]);

  useEffect(() => {
    let stopped = false;
    let running = false;
    let again = false;
    let last = 0;
    let settle = 0;
    let isJoined = false;
    let stopLive: (() => void) | null = null;

    const load = () => {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      last = Date.now();
      chatApi
        .sidebar()
        .then((sidebar) => {
          if (!stopped) useCompaniesStore.getState().setChat(viewing ? sidebarRead(sidebar, viewing) : sidebar);
        })
        .catch(() => undefined)
        .finally(() => {
          running = false;
          if (again) {
            again = false;
            load();
          }
        });
    };
    reload = load;
    const soon = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(load, EVENT_SETTLE_MS);
    };
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= FOCUS_GAP_MS) load();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || (isJoined && publish)) return;
      if (Date.now() - last >= (onChat.current ? POLL_CHAT_MS : POLL_IDLE_MS)) load();
    }, POLL_CHAT_MS);

    load();
    if (live && userId) {
      void import("@/lib/docs/live/client")
        .then((module) =>
          module.watchChat(
            live,
            userId,
            (event) => {
              for (const listener of listeners) listener(event);
              if (event.type === "read") {
                const conversationId = event.conversationId;
                useCompaniesStore.getState().setChat((current) => (current ? sidebarRead(current, conversationId) : current));
                return;
              }
              if (event.type === "message" && event.conversationId === viewing && !event.message.parentId) return;
              soon();
            },
            (now) => {
              const rejoined = now && !isJoined;
              isJoined = now;
              setJoined(now && publish);
              if (rejoined) load();
            },
          ),
        )
        .then((stop) => {
          if (stopped) stop();
          else stopLive = stop;
        })
        .catch(() => undefined);
    }

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stopped = true;
      reload = () => {};
      setJoined(false);
      window.clearInterval(timer);
      window.clearTimeout(settle);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      stopLive?.();
    };
  }, [live, publish, userId]);

  return null;
}
