"use client";

import { createContext, useContext } from "react";
import { ParticipantAvatar, type AvatarSize } from "@/components/docs/presence";
import type { ChatLocation } from "@/lib/chat/routes";
import type { EmojiPrefs } from "@/components/chat/reactions";
import type { ChatTimelineActions } from "@/components/chat/use-chat-actions";
import type { ChatScheduleActions } from "@/components/chat/use-scheduled";
import type { ChatPinActions } from "@/components/chat/use-pins";
import type { ChatSavedActions } from "@/components/chat/use-saved";
import { chatLabel, type ChatAttachment, type ChatConversation, type ChatMessage, type ChatPerson } from "@/lib/chat/types";
import type { Mention } from "@/lib/mentions";
import { personParticipant } from "@/lib/docs/participants";
import { cn } from "@/lib/utils";

export type ChatWorkspace = { id: string; name: string };

export type ChatPane = "room" | "thread" | "card";

export type ChatEditing = { id: string; pane: ChatPane } | null;

export type ChatContextValue = ChatTimelineActions & {
  viewer: ChatPerson;
  now: number;
  multi: boolean;
  workspaces: ChatWorkspace[];
  location: ChatLocation;
  failed: Record<string, string>;
  editing: ChatEditing;
  setEditing: (editing: ChatEditing) => void;
  go: (location: ChatLocation, options?: { replace?: boolean }) => void;
  back: () => void;
  openThread: (conversationId: string, rootId: string) => void;
  closeThread: () => void;
  conversation: (id: string) => ChatConversation | null;
  copyLink: (message: ChatMessage) => Promise<boolean>;
  messageLink: (message: ChatMessage) => { href: string; label: string };
  send: (input: { conversationId: string; parentId: string | null; text: string; mentions: Mention[]; attachments?: ChatAttachment[]; discardOnFailure?: boolean }) => Promise<string | null>;
  memberNames: Map<string, string>;
  emoji: EmojiPrefs;
  saved: ChatSavedActions;
  schedule?: ChatScheduleActions;
  pins: ChatPinActions;
  discussion?: boolean;
};

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error("useChat needs a ChatContext");
  return value;
}

export function ChatAvatar({ person, size = "lg", ring, className }: { person: ChatPerson | null; size?: AvatarSize; ring?: boolean; className?: string }) {
  const { viewer } = useChat();
  return <ParticipantAvatar participant={personParticipant(person, viewer.id)} size={size} ring={ring} className={className} />;
}

export function AvatarStack({ people, size = "xs", ringClass }: { people: ChatPerson[]; size?: AvatarSize; ringClass?: string }) {
  if (people.length === 0) return null;
  return (
    <span aria-hidden className="flex items-center -space-x-1">
      {people.map((person) => (
        <ChatAvatar key={person.id} person={person} size={size} ring className={cn(ringClass)} />
      ))}
    </span>
  );
}

export function GroupAvatar({ people, className }: { people: ChatPerson[]; className?: string }) {
  const [first, second] = people;
  return (
    <span aria-hidden className={cn("relative inline-block size-5 shrink-0", className)}>
      {first && <ChatAvatar person={first} size="xs" ring className="absolute top-0 left-0 size-3.5 text-[0px]" />}
      {second && <ChatAvatar person={second} size="xs" ring className="absolute right-0 bottom-0 size-3.5 text-[0px]" />}
    </span>
  );
}

export function roomLabel(conversation: Pick<ChatConversation, "kind" | "name">) {
  return chatLabel(conversation);
}
