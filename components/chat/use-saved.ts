"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { remindAboutMessageAction, saveMessageAction } from "@/app/(crm)/chat/actions";
import { newClientKey } from "@/lib/chat/client";
import { isLocal } from "@/lib/chat/timeline";
import type { ChatMessage, ChatRemindWhen } from "@/lib/chat/types";
import { useChatSaved } from "@/stores/chat-saved-store";

export const SAVE_FAILED = "Couldn't save the message. Try again.";
export const UNSAVE_FAILED = "Couldn't remove it from Saved. Try again.";
export const REMIND_FAILED = "Couldn't set the reminder. Try again.";
export const REMINDER_ADDED = "Reminder added";

export const REMIND_CHOICES: { when: ChatRemindWhen; label: string }[] = [
  { when: "hour", label: "In 1 hour" },
  { when: "tomorrow", label: "Tomorrow" },
  { when: "none", label: "No date" },
];

export type ChatSavedActions = {
  isSaved: (messageId: string) => boolean;
  save: (message: ChatMessage, saved: boolean) => void;
  remind: (message: ChatMessage, when: ChatRemindWhen) => void;
};

export function useSavedMessages(report: (message: string) => void, enabled = true): ChatSavedActions {
  const ids = useChatSaved((store) => store.ids);
  const reporter = useRef(report);
  useLayoutEffect(() => {
    reporter.current = report;
  });
  const reminding = useRef(new Set<string>());

  useEffect(() => {
    if (enabled) useChatSaved.getState().load();
  }, [enabled]);

  const isSaved = useCallback((messageId: string) => ids.has(messageId), [ids]);

  const save = useCallback((message: ChatMessage, saved: boolean) => {
    if (isLocal(message) || message.deletedAt) return;
    useChatSaved.getState().mark(message.id, saved);
    void saveMessageAction(message.id, saved)
      .catch(() => ({ error: saved ? SAVE_FAILED : UNSAVE_FAILED }))
      .then((result) => {
        if ("ok" in result && result.ok) return;
        useChatSaved.getState().mark(message.id, !saved);
        reporter.current("error" in result ? result.error : saved ? SAVE_FAILED : UNSAVE_FAILED);
      });
  }, []);

  const remind = useCallback((message: ChatMessage, when: ChatRemindWhen) => {
    if (isLocal(message) || message.deletedAt || reminding.current.has(message.id)) return;
    reminding.current.add(message.id);
    void remindAboutMessageAction(message.id, when, newClientKey())
      .catch(() => ({ error: REMIND_FAILED }))
      .then((result) => reporter.current("ok" in result && result.ok ? REMINDER_ADDED : "error" in result ? result.error : REMIND_FAILED))
      .finally(() => reminding.current.delete(message.id));
  }, []);

  return useMemo(() => ({ isSaved, save, remind }), [isSaved, save, remind]);
}
