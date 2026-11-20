"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { pinMessageAction } from "@/app/(crm)/chat/actions";
import { useChatEvents, useChatJoined } from "@/components/chat/chat-live";
import { isLocal } from "@/lib/chat/timeline";
import { CHAT_PINS_MAX, type ChatMessage, type ChatPerson } from "@/lib/chat/types";
import { useChatPins } from "@/stores/chat-pins-store";

const PIN_FAILED = "Couldn't pin the message. Try again.";
const UNPIN_FAILED = "Couldn't unpin the message. Try again.";
const PINS_FULL = `A conversation can have up to ${CHAT_PINS_MAX} pinned messages. Unpin one first.`;

export type ChatPinActions = {
  known: (conversationId: string) => boolean;
  isPinned: (message: ChatMessage) => boolean;
  pin: (message: ChatMessage, pinned: boolean) => void;
};

export const NO_PINS: ChatPinActions = { known: () => false, isPinned: () => false, pin: () => undefined };

export function usePinActions(report: (message: string) => void, viewer: ChatPerson): ChatPinActions {
  const rooms = useChatPins((store) => store.rooms);
  const reporter = useRef(report);
  const person = useRef(viewer);
  useLayoutEffect(() => {
    reporter.current = report;
    person.current = viewer;
  });

  const known = useCallback((conversationId: string) => Boolean(rooms[conversationId]), [rooms]);
  const isPinned = useCallback((message: ChatMessage) => Boolean(rooms[message.conversationId]?.some((pin) => pin.message.id === message.id)), [rooms]);

  const pin = useCallback((message: ChatMessage, pinned: boolean) => {
    if (isLocal(message) || message.deletedAt) return;
    const store = useChatPins.getState();
    const current = store.rooms[message.conversationId];
    if (!current) return;
    if (pinned && current.length >= CHAT_PINS_MAX) {
      reporter.current(PINS_FULL);
      return;
    }
    if (pinned) store.add(message, person.current);
    else store.remove(message.conversationId, message.id);
    void pinMessageAction(message.id, pinned)
      .catch(() => ({ error: pinned ? PIN_FAILED : UNPIN_FAILED }))
      .then((result) => {
        useChatPins.getState().load(message.conversationId, { force: true });
        if ("ok" in result && result.ok) return;
        reporter.current("error" in result ? result.error : pinned ? PIN_FAILED : UNPIN_FAILED);
      });
  }, []);

  return useMemo(() => ({ known, isPinned, pin }), [known, isPinned, pin]);
}

export function usePinsSync(conversationId: string | null) {
  const joined = useChatJoined();

  useEffect(() => {
    if (conversationId) useChatPins.getState().load(conversationId, { force: true });
  }, [conversationId, joined]);

  useEffect(() => {
    if (!conversationId) return;
    const reload = () => {
      if (document.visibilityState === "visible") useChatPins.getState().load(conversationId, { force: true });
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [conversationId]);

  useChatEvents((event) => {
    if (!conversationId || event.conversationId !== conversationId) return;
    const store = useChatPins.getState();
    if (event.type === "pins") store.load(conversationId, { force: true });
    else if (event.type === "delete") store.remove(conversationId, event.messageId);
    else if (event.type === "edit") store.edit(event.message);
    else if (event.type === "removed") store.forget(conversationId);
  });
}
