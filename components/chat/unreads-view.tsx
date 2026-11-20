"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import { ChatAvatar, GroupAvatar, roomLabel, useChat } from "@/components/chat/chat-context";
import ChatMessageRow from "@/components/chat/chat-message";
import { useChatEvents } from "@/components/chat/chat-live";
import { PhoneBack } from "@/components/chat/room-view";
import { chatApi } from "@/lib/chat/client";
import { applyPreviews } from "@/lib/chat/timeline";
import { isDirect, type ChatUnreadGroup } from "@/lib/chat/types";
import { useCompaniesStore } from "@/stores/companies-store";
import { useShortcutHint } from "@/components/shortcuts/shortcuts-provider";

const SETTLE_MS = 500;

function Group({ group, onRead }: { group: ChatUnreadGroup; onRead: (id: string) => void }) {
  const { go, viewer, multi } = useChat();
  const { conversation, messages, more } = group;
  const count = messages.length + more;
  const open = () => go({ view: { kind: "room", id: conversation.id }, thread: null, message: messages[0]?.id ?? null });
  const other = messages.find((message) => message.author.id && message.author.id !== viewer.id)?.author ?? null;
  return (
    <article className="bg-surface-raised rounded-2xl pt-3 pb-2" aria-label={`Unread in ${roomLabel(conversation)}`}>
      <div className="flex items-center gap-2 px-4 pb-1.5 max-md:px-3 md:pointer-coarse:pb-3.5">
        <Button variant="link" size="none" onClick={open} className="ui-style hit text-foreground flex min-w-0 items-center gap-2 font-medium max-md:min-h-11">
          {isDirect(conversation.kind) ? (
            <>
              {conversation.kind === "group_dm" ? (
                <GroupAvatar people={conversation.people} />
              ) : (
                <ChatAvatar person={conversation.dmUser ?? (other ? { id: other.id ?? conversation.id, name: other.name } : { id: conversation.id, name: conversation.name })} size="xs" />
              )}
              <span className="truncate">{conversation.name}</span>
            </>
          ) : (
            <span className="truncate">
              <span aria-hidden className="text-faint">
                #
              </span>
              {conversation.name}
            </span>
          )}
        </Button>
        {multi && conversation.kind === "room" && conversation.workspaceName && <span className="caption-style text-faint shrink-0 max-sm:hidden">{conversation.workspaceName}</span>}
        <Tag tone="purple" size="sm" className="h-5 shrink-0 text-[12px]">
          {count >= 100 ? "99+" : count} new
        </Tag>
        <Button variant="ghost" size="sm" onClick={() => onRead(conversation.id)} className="hit ml-auto shrink-0 max-md:h-11">
          Mark read
        </Button>
      </div>
      {messages.map((message) => (
        <ChatMessageRow key={message.id} message={message} continuation={false} inThread={false} pane="card" />
      ))}
      {more > 0 && (
        <Button variant="link" size="none" onClick={open} className="ui-style hit text-subtle mt-0.5 mb-1 ml-14 font-normal max-md:ml-[50px] max-md:min-h-11">
          {more === 1 ? "1 more" : `${more} more`}
        </Button>
      )}
    </article>
  );
}

export default function UnreadsView() {
  const { back, markRead, markAllRead } = useChat();
  const hint = useShortcutHint("chat-mark-all-read");
  const [groups, setGroups] = useState<ChatUnreadGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settle = useRef(0);

  const reload = useCallback(() => {
    chatApi
      .unreads()
      .then((page) => {
        setGroups(page.groups);
        setError(null);
      })
      .catch((failure: Error) => setError(failure.message));
  }, []);

  useEffect(() => {
    reload();
    return () => window.clearTimeout(settle.current);
  }, [reload]);

  const unreadCount = useCompaniesStore((store) => store.chat?.unreadConversations ?? null);
  const [seenCount, setSeenCount] = useState(unreadCount);
  if (seenCount !== unreadCount) {
    setSeenCount(unreadCount);
    if (unreadCount === 0 && groups?.length) setGroups([]);
  }
  useEffect(() => {
    if (!unreadCount) return;
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(reload, SETTLE_MS);
  }, [unreadCount, reload]);

  useChatEvents((event) => {
    if (event.type === "previews") {
      setGroups((current) => current?.map((group) => ({ ...group, messages: applyPreviews(group.messages, event.messageId, event.previews) })) ?? current);
      return;
    }
    if (event.type === "message" && event.message.parentId) return;
    if (event.type === "thread-read") return;
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(reload, SETTLE_MS);
  });

  function read(conversationId: string) {
    setGroups((current) => current?.filter((group) => group.conversation.id !== conversationId) ?? current);
    markRead(conversationId, null);
  }

  function readAll() {
    setGroups([]);
    markAllRead();
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 px-5 max-md:h-auto max-md:px-3 max-md:py-2.5">
        <PhoneBack label="Chat" onClick={back} />
        <h2 className="max-md:flex-1 max-md:text-center">All unreads</h2>
        <Button variant="ghost" size="sm" onClick={readAll} disabled={!groups?.length} title={hint ? `Mark all read (${hint})` : undefined} className="hit ml-auto shrink-0 max-md:ml-0 max-md:h-11">
          Mark all read
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-5 py-4 max-md:gap-2 max-md:px-2 max-md:py-2.5">
        {error && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p role="alert" className="text-danger">
              {error}
            </p>
            <Button variant="secondary" size="sm" onClick={reload} className="hit max-md:h-11">
              Try again
            </Button>
          </div>
        )}
        {groups === null && !error && (
          <p role="status" className="caption-style text-subtle py-10 text-center">
            Loading…
          </p>
        )}
        {groups?.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <h3>No unread messages</h3>
          </div>
        )}
        {groups?.map((group) => <Group key={group.conversation.id} group={group} onRead={read} />)}
      </div>
    </div>
  );
}
