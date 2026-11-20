"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { cancelScheduledAction, scheduleMessageAction, sendScheduledNowAction, updateScheduledAction } from "@/app/(crm)/chat/actions";
import { refreshChatSidebar, useChatEvents } from "@/components/chat/chat-live";
import { messageBody } from "@/components/chat/use-chat-actions";
import { scheduledWhen } from "@/lib/chat/scheduled";
import type { ChatAttachment, ChatPost, ChatScheduledChange, ChatScheduledItem } from "@/lib/chat/types";
import type { Mention } from "@/lib/mentions";
import { useChatScheduled } from "@/stores/chat-scheduled-store";
import { useCompaniesStore } from "@/stores/companies-store";

const SCHEDULE_FAILED = "Couldn't schedule the message. Try again.";
const SAVE_FAILED = "Couldn't save the message. Try again.";
const CANCEL_FAILED = "Couldn't delete the message. Try again.";
const SEND_FAILED = "Couldn't send. Try again.";
const GONE = "That message is no longer scheduled.";
const FOCUS_GAP_MS = 30_000;

export type ChatScheduleInput = {
  conversationId: string;
  parentId: string | null;
  text: string;
  mentions: Mention[];
  attachments: ChatAttachment[];
  sendAt: string;
};

export type ChatScheduleActions = {
  schedule: (input: ChatScheduleInput) => Promise<string | null>;
  update: (item: ChatScheduledItem, change: ChatScheduledChange) => Promise<string | null>;
  cancel: (item: ChatScheduledItem) => Promise<string | null>;
  sendNow: (item: ChatScheduledItem) => Promise<string | null>;
};

function newScheduleId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function signature(input: ChatScheduleInput, body: string) {
  return JSON.stringify([input.conversationId, input.parentId, body, input.attachments.map((file) => file.id), input.sendAt]);
}

export function useScheduledMessages(report: (message: string) => void, onPosted: (post: ChatPost) => void): ChatScheduleActions {
  const reporter = useRef(report);
  const posted = useRef(onPosted);
  useLayoutEffect(() => {
    reporter.current = report;
    posted.current = onPosted;
  });
  const attempts = useRef(new Map<string, string>());
  const counted = useCompaniesStore((store) => store.chat?.scheduled ?? null);
  const known = useChatScheduled((store) => (store.loaded ? store.items.length : null));

  useEffect(() => {
    useChatScheduled.getState().load();
  }, []);

  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < FOCUS_GAP_MS || useChatScheduled.getState().items.length === 0) return;
      last = Date.now();
      useChatScheduled.getState().load({ force: true });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  useChatEvents((event) => {
    if (event.type === "scheduled") {
      useChatScheduled.getState().load({ force: true });
      return;
    }
    const key = event.type === "message" ? event.message.clientKey : null;
    if (!key || !useChatScheduled.getState().items.some((item) => item.id === key)) return;
    useChatScheduled.getState().remove(key);
    refreshChatSidebar();
  });

  useEffect(() => {
    if (counted !== null && known !== null && counted !== known) useChatScheduled.getState().load({ force: true });
  }, [counted, known]);

  const schedule = useCallback(async (input: ChatScheduleInput) => {
    const body = messageBody(input.text, input.mentions);
    if (!body && input.attachments.length === 0) return null;
    const same = signature(input, body);
    const id = attempts.current.get(same) ?? newScheduleId();
    attempts.current = new Map([[same, id]]);
    const result = await scheduleMessageAction({
      id,
      conversationId: input.conversationId,
      parentId: input.parentId,
      body,
      format: "markdown",
      attachmentIds: input.attachments.map((file) => file.id),
      sendAt: input.sendAt,
    }).catch(() => ({ error: SCHEDULE_FAILED }));
    if ("ok" in result && result.ok) {
      attempts.current = new Map();
      useChatScheduled.getState().upsert(result.item);
      refreshChatSidebar();
      reporter.current(`Scheduled for ${scheduledWhen(result.item.sendAt, Date.now(), undefined, { sentence: true })}`);
      return null;
    }
    return "error" in result ? result.error : SCHEDULE_FAILED;
  }, []);

  const update = useCallback(async (item: ChatScheduledItem, change: ChatScheduledChange) => {
    const result = await updateScheduledAction(item.id, change).catch(() => ({ error: SAVE_FAILED }));
    if ("ok" in result && result.ok) {
      useChatScheduled.getState().upsert(result.item);
      refreshChatSidebar();
      return null;
    }
    useChatScheduled.getState().load({ force: true });
    return "error" in result ? result.error : SAVE_FAILED;
  }, []);

  const cancel = useCallback(async (item: ChatScheduledItem) => {
    const result = await cancelScheduledAction(item.id).catch(() => ({ error: CANCEL_FAILED }));
    if ("ok" in result && result.ok) {
      useChatScheduled.getState().remove(item.id);
      refreshChatSidebar();
      if (!result.cancelled) reporter.current(GONE);
      return null;
    }
    useChatScheduled.getState().load({ force: true });
    return "error" in result ? result.error : CANCEL_FAILED;
  }, []);

  const sendNow = useCallback(async (item: ChatScheduledItem) => {
    const result = await sendScheduledNowAction(item.id).catch(() => ({ error: SEND_FAILED }));
    if ("ok" in result && result.ok) {
      useChatScheduled.getState().remove(item.id);
      refreshChatSidebar();
      if (result.post) posted.current(result.post);
      return null;
    }
    useChatScheduled.getState().load({ force: true });
    return "error" in result ? result.error : SEND_FAILED;
  }, []);

  return useMemo(() => ({ schedule, update, cancel, sendNow }), [schedule, update, cancel, sendNow]);
}
