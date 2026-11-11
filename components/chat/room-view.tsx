"use client";

import { useEffect, useMemo, useState } from "react";
import Button from "@/components/_ui/button";
import { AvatarStack, ChatAvatar, roomLabel, useChat } from "@/components/chat/chat-context";
import { setChatViewing, useChatEvents } from "@/components/chat/chat-live";
import Composer from "@/components/chat/composer";
import MessageList from "@/components/chat/message-list";
import { useTyping } from "@/components/chat/use-typing";
import { isLocal, lastOwnMessage, newestServerId, typingLine, type Timeline } from "@/lib/chat/timeline";
import type { ChatConversation, ChatMessage, ChatRoom } from "@/lib/chat/types";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SlidersIcon from "@/public/assets/images/chat/sliders.svg";

const HEADER_AVATARS = 4;

function firstUnread(messages: ChatMessage[], lastReadAt: string | null, viewerId: string) {
  if (!lastReadAt) return null;
  return messages.find((message) => !isLocal(message) && !message.deletedAt && (message.author.id !== viewerId || message.via) && message.createdAt > lastReadAt)?.id ?? null;
}

export function useVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible" && document.hasFocus());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return visible;
}

export function PhoneBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="secondary" size="sm" onClick={onClick} className="h-11 max-w-[45%] min-w-11 shrink-0 gap-1 pr-3 pl-2 text-[13px] md:hidden" aria-label={`Back to ${label}`}>
      <ChevronLeftIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

export function TypingLine({ names }: { names: string[] }) {
  return (
    <div role="status" className="caption-style text-subtle flex h-[22px] items-center gap-1.5 px-1">
      {names.length > 0 && (
        <>
          <span aria-hidden className="flex gap-[3px]">
            <span className="bg-subtle size-1 rounded-full motion-safe:animate-bounce" />
            <span className="bg-subtle size-1 rounded-full [animation-delay:150ms] motion-safe:animate-bounce" />
            <span className="bg-subtle size-1 rounded-full [animation-delay:300ms] motion-safe:animate-bounce" />
          </span>
          {typingLine(names)}
        </>
      )}
    </div>
  );
}

export default function RoomView({
  conversationId,
  conversation,
  room,
  roomError,
  timeline,
  focusId,
  bottomSignal,
  onSettings,
  onAddPeople,
}: {
  conversationId: string;
  conversation: ChatConversation | null;
  room: ChatRoom | null;
  roomError: string | null;
  timeline: Timeline | null;
  focusId: string | null;
  bottomSignal: number;
  onSettings: () => void;
  onAddPeople: () => void;
}) {
  const chat = useChat();
  const { viewer, multi, send, setEditing, loadMessages, markRead, back } = chat;
  const info = room?.conversation ?? conversation;
  const members = room?.members;
  const memberSet = useMemo(() => (members ? new Map(members.map((member) => [member.id, member.name])) : null), [members]);
  const typing = useTyping(conversationId, viewer, memberSet);
  const visible = useVisible();
  const [atBottom, setAtBottom] = useState(false);
  const ready = timeline?.status === "ready";
  const messages = useMemo(() => timeline?.messages ?? [], [timeline]);
  const [divider, setDivider] = useState<{ ready: boolean; id: string | null }>({ ready: false, id: null });
  if (ready && !divider.ready) setDivider({ ready: true, id: firstUnread(messages, timeline?.lastReadAt ?? null, viewer.id) ?? timeline?.firstUnreadId ?? null });

  useChatEvents((event) => {
    if (event.type === "message" && event.conversationId === conversationId) typing.stopped(event.message.author.id);
  });

  const newest = newestServerId(messages);
  const unread = (conversation?.unread ?? 0) > 0;
  const newestMessage = newest ? messages.find((message) => message.id === newest) : null;
  const behind = Boolean(newestMessage && timeline?.lastReadAt && newestMessage.createdAt > timeline.lastReadAt);

  const reading = ready && atBottom && visible;
  useEffect(() => {
    if (!reading) return;
    setChatViewing(conversationId);
    return () => setChatViewing(null);
  }, [reading, conversationId]);

  useEffect(() => {
    if (!reading || !newest || !(unread || behind)) return;
    const timer = window.setTimeout(() => markRead(conversationId, newest), 400);
    return () => window.clearTimeout(timer);
  }, [reading, newest, unread, behind, conversationId, markRead]);

  const title = info ? roomLabel(info) : "";
  const dm = info?.kind === "dm";
  const placeholder = info ? `Message ${dm ? info.name : `#${info.name}`}` : "Message";
  const shownMembers = (members ?? []).slice(0, HEADER_AVATARS).map((member) => ({ id: member.id, name: member.name }));

  const empty = (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {dm ? (
        <>
          <ChatAvatar person={info?.dmUser ?? null} size="lg" />
          <p className="text-soft">Start of your conversation with {info?.name}.</p>
        </>
      ) : (
        <>
          <AvatarStack people={shownMembers} size="lg" />
          <p className="text-soft">Start of {title}. Only members can see it.</p>
          <Button variant="secondary" size="sm" onClick={onAddPeople} className="max-md:h-11">
            <PlusIcon aria-hidden className="size-3" />
            Add people
          </Button>
        </>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-line-subtle flex h-[52px] shrink-0 items-center gap-2 border-b pr-3 pl-5 max-md:h-auto max-md:border-border max-md:px-3 max-md:py-2.5">
        <PhoneBack label="Chat" onClick={back} />
        <h2 className="flex min-w-0 items-center gap-1 max-md:flex-1 max-md:justify-center">
          {dm ? (
            <ChatAvatar person={info?.dmUser ?? null} size="sm" className="mr-1 max-md:hidden" />
          ) : (
            <span aria-hidden className="text-faint">
              #
            </span>
          )}
          <span className="truncate">{info ? info.name : roomError ? "Conversation" : ""}</span>
        </h2>
        {multi && !dm && info?.workspaceName && <span className="caption-style text-faint ml-1 shrink-0 max-md:hidden">{info.workspaceName}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 max-md:ml-0">
          {!dm && shownMembers.length > 0 && (
            <span className="flex items-center gap-2 max-md:hidden" aria-label={`${members?.length ?? 0} members`}>
              <AvatarStack people={shownMembers} size="sm" />
              <span className="caption-style text-subtle tabular-nums" aria-hidden>
                {members?.length}
              </span>
            </span>
          )}
          {!dm && info && (
            <Button variant="ghost" size="icon" aria-label="Room settings" title="Room settings" onClick={onSettings} className="max-md:size-11">
              <SlidersIcon aria-hidden className="size-3.5" />
            </Button>
          )}
          {(dm || !info) && <span aria-hidden className="size-11 md:hidden" />}
        </span>
      </header>
      {roomError && !info ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="alert" className="text-danger">
            {roomError}
          </p>
          <Button variant="secondary" size="sm" onClick={back}>
            Back to Chat
          </Button>
        </div>
      ) : timeline?.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="alert" className="text-danger">
            {timeline.error}
          </p>
          <Button variant="secondary" size="sm" onClick={() => loadMessages(conversationId, "latest")}>
            Try again
          </Button>
        </div>
      ) : (
        <MessageList
          key={`${conversationId}:${focusId ?? ""}`}
          messages={messages}
          ready={ready}
          dividerId={divider.id}
          days
          pane="room"
          bottomSignal={bottomSignal}
          loadError={timeline?.error ?? null}
          hasOlder={timeline?.hasOlder ?? false}
          hasNewer={timeline?.hasNewer ?? false}
          focusId={focusId}
          empty={empty}
          label={title ? `Messages in ${title}` : "Messages"}
          onOlder={() => loadMessages(conversationId, "older")}
          onNewer={() => loadMessages(conversationId, "newer")}
          onLatest={() => loadMessages(conversationId, "latest")}
          onBottom={setAtBottom}
        />
      )}
      {timeline?.error && timeline.status === "ready" && (
        <p role="alert" className="caption-style text-danger px-5 pb-1">
          {timeline.error}
        </p>
      )}
      <div className="shrink-0 px-4 pb-3.5 max-md:px-2 max-md:pb-2">
        <TypingLine names={typing.names} />
        <Composer
          id={`chat-composer-${conversationId}`}
          conversationId={conversationId}
          parentId={null}
          placeholder={placeholder}
          label={placeholder}
          autoFocus={!chat.location.thread}
          disabled={!info}
          onTyping={typing.send}
          onSend={(text, mentions) => send({ conversationId, parentId: null, text, mentions })}
          onEditLast={() => {
            const own = lastOwnMessage(messages, viewer.id);
            if (!own) return false;
            setEditing({ id: own.id, pane: "room" });
            return true;
          }}
        />
      </div>
    </div>
  );
}
