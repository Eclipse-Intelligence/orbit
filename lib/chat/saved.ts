import { isLocal } from "@/lib/chat/timeline";
import { chatLabel, isChatKind, type ChatMessage, type ChatSavedItem } from "@/lib/chat/types";

export function savedPlace(conversation: ChatSavedItem["conversation"]) {
  if (isChatKind(conversation.kind)) return chatLabel(conversation);
  if (conversation.kind === "mail_thread") return "Shared email";
  const label = conversation.kind === "task" ? "Task" : "Doc";
  return conversation.name ? `${label}: ${conversation.name}` : label;
}

export function canSaveMessage(message: ChatMessage) {
  return !isLocal(message) && !message.deletedAt && message.kind !== "event";
}
