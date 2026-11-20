"use client";

import { askOrbit } from "@/components/assistant/ask-orbit";
import { useChat } from "@/components/chat/chat-context";
import { addTask } from "@/components/crm/add-task-event";
import { useComposer } from "@/components/mail/compose-dock";
import { isLocal } from "@/lib/chat/timeline";
import { taskTitleFromMessage } from "@/lib/chat/task-text";
import type { ChatMessage } from "@/lib/chat/types";
import { focusChatThreadForAsk } from "@/stores/page-context-store";

export const CREATE_TASK_LABEL = "Create task";

export function askLabel(message: Pick<ChatMessage, "parentId" | "replyCount">) {
  return message.parentId || message.replyCount > 0 ? "Ask Orbit about this thread" : "Ask Orbit about this message";
}

export function useOrbitActions(message: ChatMessage) {
  const { messageLink, discussion } = useChat();
  const composer = useComposer();
  const listed = !isLocal(message) && !message.deletedAt && message.kind !== "event";

  function createTask() {
    const link = messageLink(message);
    const opened = addTask({ title: taskTitleFromMessage(message), link });
    if (!opened) composer.showToast({ message: "Couldn't open Add task. Try again.", tone: "alert" });
  }

  function ask() {
    focusChatThreadForAsk(message.parentId ?? message.id);
    if (!askOrbit("")) composer.showToast({ message: "Ask Orbit isn't available here.", tone: "alert" });
  }

  return { canCreateTask: listed, canAsk: listed && !discussion, createTask, ask };
}
