"use client";

import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import CountBadge from "@/components/_ui/count-badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { ChatAvatar, roomLabel, useChat } from "@/components/chat/chat-context";
import { conversationLevel, NotifyItems } from "@/components/chat/notify-menu";
import { chatLocationHref, type ChatView } from "@/lib/chat/routes";
import type { ChatConversation, ChatSidebar } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import BellOffIcon from "@/public/assets/images/chat/bell-off.svg";
import ThreadsIcon from "@/public/assets/images/chat/threads.svg";
import UnreadsIcon from "@/public/assets/images/chat/unreads.svg";

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;

export function orderedConversations(sidebar: ChatSidebar | null) {
  const conversations = sidebar?.conversations ?? [];
  const starred = conversations.filter((conversation) => conversation.starred);
  return {
    starred: [...starred.filter((conversation) => conversation.kind === "room"), ...starred.filter((conversation) => conversation.kind === "dm")],
    rooms: conversations.filter((conversation) => conversation.kind === "room" && !conversation.starred),
    dms: conversations.filter((conversation) => conversation.kind === "dm" && !conversation.starred),
  };
}

export function listViews(sidebar: ChatSidebar | null): ChatView[] {
  const { starred, rooms, dms } = orderedConversations(sidebar);
  return [{ kind: "threads" }, { kind: "unreads" }, ...[...starred, ...rooms, ...dms].map((conversation) => ({ kind: "room" as const, id: conversation.id }))];
}

function Badge({ count, accent, label, className }: { count: number; accent: boolean; label: string; className?: string }) {
  if (count <= 0) return null;
  return (
    <CountBadge className={cn(accent && "bg-primary text-primary-foreground", className)}>
      {count >= 100 ? "99+" : count}
      <span className="sr-only"> {label}</span>
    </CountBadge>
  );
}

const ROW = "hover:bg-surface-hover hover:text-foreground flex h-[30px] w-full items-center gap-2 rounded-lg px-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-md:h-11 max-md:text-[15px]";

function useOpen(view: ChatView) {
  const { go } = useChat();
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    go({ view, thread: null, message: null });
  };
}

function Item({ view, active, unread, children }: { view: ChatView; active: boolean; unread: boolean; children: ReactNode }) {
  const open = useOpen(view);
  return (
    <li>
      <a href={chatLocationHref({ view })} onClick={open} aria-current={active ? "page" : undefined} className={cn(ROW, active ? "bg-surface-active text-foreground" : "text-soft", unread && "text-foreground font-semibold")}>
        {children}
      </a>
    </li>
  );
}

function ConversationRow({ conversation, active, children }: { conversation: ChatConversation; active: boolean; children: ReactNode }) {
  const { markRead, markUnread } = useChat();
  const view: ChatView = { kind: "room", id: conversation.id };
  const open = useOpen(view);
  const [menu, setMenu] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const unread = conversation.unread > 0;
  const muted = conversationLevel(conversation) === "mute";

  function startPress(event: PointerEvent<HTMLAnchorElement>) {
    pressed.current = false;
    if (event.pointerType !== "touch") return;
    const timer = window.setTimeout(() => {
      press.current = null;
      pressed.current = true;
      setMenu(true);
    }, LONG_PRESS_MS);
    press.current = { timer, x: event.clientX, y: event.clientY };
  }

  function movePress(event: PointerEvent<HTMLAnchorElement>) {
    const current = press.current;
    if (current && (Math.abs(event.clientX - current.x) > MOVE_SLOP || Math.abs(event.clientY - current.y) > MOVE_SLOP)) endPress();
  }

  function endPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  return (
    <li className="group/row relative">
      <a
        href={chatLocationHref({ view })}
        onClick={(event) => {
          if (pressed.current) {
            pressed.current = false;
            event.preventDefault();
            return;
          }
          if (event.altKey && event.button === 0) {
            event.preventDefault();
            void markUnread(conversation.id, null);
            return;
          }
          open(event);
        }}
        onPointerDown={startPress}
        onPointerMove={movePress}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu(true);
        }}
        aria-current={active ? "page" : undefined}
        className={cn(
          ROW,
          "pointer-fine:group-hover/row:pr-8 pointer-fine:group-focus-within/row:pr-8 [@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none]",
          active ? "bg-surface-active text-foreground" : muted ? "text-subtle" : "text-soft",
          unread && "font-semibold",
          unread && !muted && "text-foreground",
          unread && muted && "text-soft",
        )}
      >
        {children}
        {muted && <BellOffIcon aria-label="Muted" role="img" className="text-faint size-3 shrink-0 pointer-fine:group-hover/row:hidden pointer-fine:group-focus-within/row:hidden" />}
        {unread && conversation.kind === "room" && conversation.mentions === 0 && <span className="sr-only">, unread</span>}
      </a>
      <DropdownMenu open={menu} onOpenChange={setMenu} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Options for ${roomLabel(conversation)}`}
            title="Options"
            className="absolute top-1/2 right-1 size-6 -translate-y-1/2 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:pointer-events-none"
          >
            <MoreIcon aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[248px]" onFocusOutside={(event) => event.preventDefault()}>
          {unread ? (
            <DropdownMenuItem onSelect={() => markRead(conversation.id, null)}>Mark read</DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={!conversation.lastMessageAt} onSelect={() => void markUnread(conversation.id, null)}>
              Mark unread
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <NotifyItems conversation={conversation} />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function Heading({ id, label, action }: { id: string; label: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2 pt-3.5 pb-1.5 md:pointer-coarse:pb-2.5">
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
    <ConversationRow conversation={conversation} active={active}>
      <span aria-hidden className="text-faint font-normal">
        #
      </span>
      <span className="min-w-0 flex-1 truncate">{conversation.name}</span>
      {multi && conversation.workspaceName && <span className="text-faint shrink-0 text-[11.5px] font-normal pointer-fine:group-hover/row:hidden">{conversation.workspaceName}</span>}
      <Badge
        count={conversation.mentions}
        accent
        label={conversation.mentions === 1 ? "mention" : "mentions"}
        className="pointer-fine:group-hover/row:hidden pointer-fine:group-focus-within/row:hidden"
      />
    </ConversationRow>
  );
}

function DmItem({ conversation, active }: { conversation: ChatConversation; active: boolean }) {
  const muted = conversationLevel(conversation) === "mute";
  return (
    <ConversationRow conversation={conversation} active={active}>
      <ChatAvatar person={conversation.dmUser ?? { id: conversation.id, name: conversation.name }} size="sm" />
      <span className="min-w-0 flex-1 truncate">{conversation.name}</span>
      <Badge count={conversation.unread} accent={!muted} label="unread" className="pointer-fine:group-hover/row:hidden pointer-fine:group-focus-within/row:hidden" />
    </ConversationRow>
  );
}

function Conversations({ list, activeId }: { list: ChatConversation[]; activeId: string | null }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {list.map((conversation) =>
        conversation.kind === "dm" ? (
          <DmItem key={conversation.id} conversation={conversation} active={conversation.id === activeId} />
        ) : (
          <RoomItem key={conversation.id} conversation={conversation} active={conversation.id === activeId} />
        ),
      )}
    </ul>
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
  const { starred, rooms, dms } = orderedConversations(sidebar);
  const threads = sidebar?.threads ?? { unread: 0, mentions: 0 };
  const unreadConversations = sidebar?.unreadConversations ?? 0;
  const activeId = view.kind === "room" ? view.id : null;

  return (
    <nav aria-label="Conversations" className={cn("flex min-h-0 flex-col overflow-y-auto overscroll-contain px-2 py-2.5 md:w-[272px] md:shrink-0", className)}>
      <ul className="flex flex-col gap-0.5">
        <Item view={{ kind: "threads" }} active={view.kind === "threads"} unread={threads.unread > 0}>
          <ThreadsIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Threads</span>
          <Badge count={threads.unread} accent={threads.mentions > 0} label="unread" />
        </Item>
        <Item view={{ kind: "unreads" }} active={view.kind === "unreads"} unread={unreadConversations > 0}>
          <UnreadsIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">All unreads</span>
          <Badge count={unreadConversations} accent={false} label={unreadConversations === 1 ? "unread conversation" : "unread conversations"} />
        </Item>
      </ul>
      {error && !sidebar && (
        <p role="alert" className="caption-style text-danger px-2 pt-3">
          {error}
        </p>
      )}
      {starred.length > 0 && (
        <section aria-labelledby="chat-starred">
          <Heading id="chat-starred" label="Starred" />
          <Conversations list={starred} activeId={activeId} />
        </section>
      )}
      <section aria-labelledby="chat-rooms">
        <Heading
          id="chat-rooms"
          label="Rooms"
          action={
            <Button variant="ghost" size="icon-sm" aria-label="New room" title="New room" onClick={onNewRoom} className="hit max-md:size-11">
              <PlusIcon aria-hidden className="size-3" />
            </Button>
          }
        />
        {rooms.length > 0 ? (
          <Conversations list={rooms} activeId={activeId} />
        ) : (
          sidebar && !starred.some((conversation) => conversation.kind === "room") && <p className="caption-style text-subtle px-2 pb-1">No rooms yet.</p>
        )}
      </section>
      <section aria-labelledby="chat-dms">
        <Heading
          id="chat-dms"
          label="Direct messages"
          action={
            <Button variant="ghost" size="icon-sm" aria-label="New message" title="New message" onClick={onNewMessage} className="hit max-md:size-11">
              <PlusIcon aria-hidden className="size-3" />
            </Button>
          }
        />
        {dms.length > 0 ? (
          <Conversations list={dms} activeId={activeId} />
        ) : (
          sidebar && !starred.some((conversation) => conversation.kind === "dm") && <p className="caption-style text-subtle px-2">Message anyone who shares a workspace with you.</p>
        )}
      </section>
    </nav>
  );
}
