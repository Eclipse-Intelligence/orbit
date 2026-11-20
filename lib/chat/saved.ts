import { isLocal } from "@/lib/chat/timeline";
import type { ChatMessage, ChatSavedItem } from "@/lib/chat/types";

export function savedPlace(conversation: ChatSavedItem["conversation"]) {
  if (conversation.kind === "room") return `#${conversation.name}`;
  if (conversation.kind === "dm") return conversation.name;
  if (conversation.kind === "mail_thread") return "Shared email";
  const label = conversation.kind === "task" ? "Task" : "Doc";
  return conversation.name ? `${label}: ${conversation.name}` : label;
}

export function canSaveMessage(message: ChatMessage) {
  return !isLocal(message) && !message.deletedAt && message.kind !== "event";
}
