"use client";

import type { MouseEvent, ReactNode } from "react";
import Button from "@/components/_ui/button";
import CountBadge from "@/components/_ui/count-badge";
import { ChatAvatar, useChat } from "@/components/chat/chat-context";
import { chatLocationHref, type ChatView } from "@/lib/chat/routes";
import type { ChatConversation, ChatSidebar } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import ThreadsIcon from "@/public/assets/images/chat/threads.svg";

export function orderedConversations(sidebar: ChatSidebar | null) {
  const conversations = sidebar?.conversations ?? [];
  return {
    rooms: conversations.filter((conversation) => conversation.kind === "room"),
    dms: conversations.filter((conversation) => conversation.kind === "dm"),
  };
}

export function listViews(sidebar: ChatSidebar | null): ChatView[] {
  const { rooms, dms } = orderedConversations(sidebar);
  return [{ kind: "threads" }, ...[...rooms, ...dms].map((conversation) => ({ kind: "room" as const, id: conversation.id }))];
}

function Badge({ count, accent, label }: { count: number; accent: boolean; label: string }) {
  if (count <= 0) return null;
  return (
    <CountBadge className={cn(accent && "bg-primary text-primary-foreground border-transparent shadow-none")}>
      {count >= 100 ? "99+" : count}
      <span className="sr-only"> {label}</span>
    </CountBadge>
  );
}

function Item({ view, active, unread, children }: { view: ChatView; active: boolean; unread: boolean; children: ReactNode }) {
  const { go } = useChat();
  const href = chatLocationHref({ view });
  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    go({ view, thread: null, message: null });
  }
  return (
    <li>
      <a
        href={href}
        onClick={open}
        aria-current={active ? "page" : undefined}
        className={cn(
          "hover:bg-surface-hover hover:text-foreground flex h-[30px] w-full items-center gap-2 rounded-lg px-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-md:h-11 max-md:text-[15px]",
          active ? "bg-surface-active text-foreground" : "text-soft",
          unread && "text-foreground font-semibold",
        )}
      >
        {children}
      </a>
    </li>
  );
}

function Heading({ id, label, action }: { id: string; label: string; action: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2 pt-3.5 pb-1.5">
      <span id={id} className="eyebrow-style text-subtle">
        {label}
      </span>
      {action}
    </div>
  );
}

function RoomItem({ conversation, active }: { conversation: ChatConversation; active: boolean }) {
  const { multi } = useChat();
  return (
    <Item view={{ kind: "room", id: conversation.id }} active={active} unread={conversation.unread > 0}>
      <span aria-hidden className="text-faint font-normal">
        #
      </span>
      <span className="min-w-0 flex-1 truncate">{conversation.name}</span>
      {multi && conversation.workspaceName && <span className="text-faint shrink-0 text-[11.5px] font-normal">{conversation.workspaceName}</span>}
      <Badge count={conversation.mentions} accent label={conversation.mentions === 1 ? "mention" : "mentions"} />
      {conversation.unread > 0 && conversation.mentions === 0 && <span className="sr-only">, unread</span>}
    </Item>
  );
}

function DmItem({ conversation, active }: { conversation: ChatConversation; active: boolean }) {
  return (
    <Item view={{ kind: "room", id: conversation.id }} active={active} unread={conversation.unread > 0}>
      <ChatAvatar person={conversation.dmUser ?? { id: conversation.id, name: conversation.name }} size="sm" />
      <span className="min-w-0 flex-1 truncate">{conversation.name}</span>
      <Badge count={conversation.unread} accent label="unread" />
    </Item>
  );
}

export default function ChatList({
  sidebar,
  error,
  view,
  onNewRoom,
  onNewMessage,
  className,
}: {
  sidebar: ChatSidebar | null;
  error: string | null;
  view: ChatView;
  onNewRoom: () => void;
  onNewMessage: () => void;
  className?: string;
}) {
  const { rooms, dms } = orderedConversations(sidebar);
  const threads = sidebar?.threads ?? { unread: 0, mentions: 0 };
  const activeId = view.kind === "room" ? view.id : null;

  return (
    <nav aria-label="Conversations" className={cn("flex min-h-0 flex-col overflow-y-auto overscroll-contain px-2 py-2.5 md:w-[272px] md:shrink-0", className)}>
      <ul className="flex flex-col gap-0.5">
        <Item view={{ kind: "threads" }} active={view.kind === "threads"} unread={threads.unread > 0}>
          <ThreadsIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Threads</span>
          <Badge count={threads.unread} accent={threads.mentions > 0} label="unread" />
        </Item>
      </ul>
      {error && !sidebar && (
        <p role="alert" className="caption-style text-danger px-2 pt-3">
          {error}
        </p>
      )}
      <section aria-labelledby="chat-rooms">
        <Heading
          id="chat-rooms"
          label="Rooms"
          action={
            <Button variant="ghost" size="icon-sm" aria-label="New room" title="New room" onClick={onNewRoom} className="max-md:size-11">
              <PlusIcon aria-hidden className="size-3" />
            </Button>
          }
        />
        {rooms.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {rooms.map((conversation) => (
              <RoomItem key={conversation.id} conversation={conversation} active={conversation.id === activeId} />
            ))}
          </ul>
        ) : (
          sidebar && <p className="caption-style text-subtle px-2 pb-1">No rooms yet.</p>
        )}
      </section>
      <section aria-labelledby="chat-dms">
        <Heading
          id="chat-dms"
          label="Direct messages"
          action={
            <Button variant="ghost" size="icon-sm" aria-label="New message" title="New message" onClick={onNewMessage} className="max-md:size-11">
              <PlusIcon aria-hidden className="size-3" />
            </Button>
          }
        />
        {dms.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {dms.map((conversation) => (
              <DmItem key={conversation.id} conversation={conversation} active={conversation.id === activeId} />
            ))}
          </ul>
        ) : (
          sidebar && <p className="caption-style text-subtle px-2">Message anyone who shares a workspace with you.</p>
        )}
      </section>
    </nav>
  );
}
