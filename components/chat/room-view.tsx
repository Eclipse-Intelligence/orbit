"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import { setRoomArchivedAction } from "@/app/(crm)/chat/actions";
import { AvatarStack, ChatAvatar, roomLabel, useChat } from "@/components/chat/chat-context";
import { refreshChatSidebar, setChatViewing, useChatEvents } from "@/components/chat/chat-live";
import { FileDrop } from "@/components/chat/attachments";
import Composer from "@/components/chat/composer";
import MessageList from "@/components/chat/message-list";
import { NotifyButton } from "@/components/chat/notify-menu";
import { useTyping } from "@/components/chat/use-typing";
import { isLocal, lastOwnMessage, newestServerId, typingLine, type Timeline } from "@/lib/chat/timeline";
import type { ChatConversation, ChatMessage, ChatRoom } from "@/lib/chat/types";
import { ROOM_MENTION_MAX_MEMBERS } from "@/lib/mentions";
import ArchiveIcon from "@/public/assets/images/chat/archive.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SlidersIcon from "@/public/assets/images/chat/sliders.svg";

const HEADER_AVATARS = 4;

function firstUnread(messages: ChatMessage[], lastReadAt: string | null, viewerId: string) {
  if (!lastReadAt) return null;
  return messages.find((message) => !isLocal(message) && message.kind === "message" && !message.deletedAt && (message.author.id !== viewerId || message.via) && message.createdAt > lastReadAt)?.id ?? null;
}

function ArchivedBanner({ conversationId, canUnarchive }: { conversationId: string; canUnarchive: boolean }) {
  const { loadRoom, loadMessages } = useChat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unarchive() {
    setBusy(true);
    setError(null);
    const result = await setRoomArchivedAction(conversationId, false).catch(() => ({ error: "Couldn't unarchive the room. Try again." }));
    setBusy(false);
    if ("ok" in result && result.ok) {
      loadRoom(conversationId);
      loadMessages(conversationId, "newer");
      refreshChatSidebar();
    } else setError("error" in result ? result.error : "Couldn't unarchive the room. Try again.");
  }

  return (
    <div className="flex flex-col gap-1.5 pt-1 pb-2">
      <div className="bg-surface-raised flex items-center gap-2.5 rounded-[10px] px-3 py-2.5">
        <ArchiveIcon aria-hidden className="text-soft size-3.5 shrink-0" />
        <p className="ui-style text-soft min-w-0 flex-1">This room is archived. You can read it, but not post.</p>
        {canUnarchive && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void unarchive()} className="hit shrink-0 max-md:h-11">
            Unarchive
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger px-1">
          {error}
        </p>
      )}
    </div>
  );
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
    <div role="status" className="caption-style text-subtle flex h-[22px] items-center gap-1.5 px-1 md:order-last">
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
  held,
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
  held: string | null;
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
  const addFiles = useRef<((files: File[]) => void) | null>(null);
  const uploadTo = useCallback(() => Promise.resolve({ id: conversationId, error: null }), [conversationId]);
  if (ready && !divider.ready) setDivider({ ready: true, id: firstUnread(messages, timeline?.lastReadAt ?? null, viewer.id) ?? timeline?.firstUnreadId ?? null });
  const [heldShown, setHeldShown] = useState<string | null>(null);
  if (held && held !== heldShown) {
    setHeldShown(held);
    setDivider({ ready: true, id: held });
  }

  useChatEvents((event) => {
    if (event.type === "message" && event.conversationId === conversationId) typing.stopped(event.message.author.id);
  });

  const newest = newestServerId(messages);
  const unread = (conversation?.unread ?? 0) > 0;
  const newestMessage = newest ? messages.find((message) => message.id === newest) : null;
  const behind = Boolean(newestMessage && timeline?.lastReadAt && newestMessage.createdAt > timeline.lastReadAt);

  const reading = ready && atBottom && visible && held === null;
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
  const archived = Boolean(info?.archivedAt);
  const topic = dm ? null : (info?.topic ?? null);
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
          <Button variant="secondary" size="sm" onClick={onAddPeople} className="hit max-md:h-11">
            <PlusIcon aria-hidden className="size-3" />
            Add people
          </Button>
        </>
      )}
    </div>
  );

  return (
    <FileDrop label={`Drop to add to ${title || "this conversation"}`} disabled={!info || archived} onFiles={(files) => addFiles.current?.(files)} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 pr-3 pl-5 max-md:h-auto max-md:px-3 max-md:py-2.5">
        <PhoneBack label="Chat" onClick={back} />
        <div className="flex min-w-0 flex-col max-md:flex-1 max-md:items-center">
          <span className="flex max-w-full min-w-0 items-center gap-2">
            <h2 className="flex min-w-0 items-center gap-1">
              {dm ? (
                <ChatAvatar person={info?.dmUser ?? null} size="sm" className="mr-1 max-md:hidden" />
              ) : (
                <span aria-hidden className="text-faint">
                  #
                </span>
              )}
              <span className="truncate">{info ? info.name : roomError ? "Conversation" : ""}</span>
            </h2>
            {archived && (
              <Tag size="sm" className="h-5 text-[12px]">
                Archived
              </Tag>
            )}
          </span>
          {topic && (
            <p title={topic} className="caption-style text-subtle max-w-[28em] truncate max-md:max-w-full">
              {topic}
            </p>
          )}
        </div>
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
          {conversation && <NotifyButton conversation={conversation} />}
          {!dm && info && (
            <Button variant="ghost" size="icon" aria-label="Room settings" title="Room settings" onClick={onSettings} className="hit max-md:size-11">
              <SlidersIcon aria-hidden className="size-3.5" />
            </Button>
          )}
          {(dm || !info) && !conversation && <span aria-hidden className="size-11 md:hidden" />}
        </span>
      </header>
      {roomError && !info ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="alert" className="text-danger">
            {roomError}
          </p>
          <Button variant="secondary" size="sm" onClick={back} className="hit">
            Back to Chat
          </Button>
        </div>
      ) : timeline?.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="alert" className="text-danger">
            {timeline.error}
          </p>
          <Button variant="secondary" size="sm" className="hit" onClick={() => loadMessages(conversationId, "latest")}>
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
          readOnly={archived}
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
      <div className="flex shrink-0 flex-col px-4 pb-1.5 max-md:px-2 max-md:pb-2">
        {archived ? (
          <ArchivedBanner conversationId={conversationId} canUnarchive={room?.canArchive ?? false} />
        ) : (
          <>
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
              roomMention={info?.kind === "room" && (members?.length ?? 0) <= ROOM_MENTION_MAX_MEMBERS}
              uploadTo={uploadTo}
              fileRef={addFiles}
              onSend={(text, mentions, attachments) => send({ conversationId, parentId: null, text, mentions, attachments })}
              onEditLast={() => {
                const own = lastOwnMessage(messages, viewer.id);
                if (!own) return false;
                setEditing({ id: own.id, pane: "room" });
                return true;
              }}
            />
          </>
        )}
      </div>
    </FileDrop>
  );
}
