import { isDirect, type ChatSidebar } from "@/lib/chat/types";

export function orderedConversations(sidebar: ChatSidebar | null) {
  const conversations = sidebar?.conversations ?? [];
  const starred = conversations.filter((conversation) => conversation.starred);
  return {
    starred: [...starred.filter((conversation) => conversation.kind === "room"), ...starred.filter((conversation) => isDirect(conversation.kind))],
    rooms: conversations.filter((conversation) => conversation.kind === "room" && !conversation.starred),
    dms: conversations.filter((conversation) => isDirect(conversation.kind) && !conversation.starred),
  };
}
