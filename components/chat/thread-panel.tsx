"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { roomLabel, useChat } from "@/components/chat/chat-context";
import ChatMessageRow from "@/components/chat/chat-message";
import Composer from "@/components/chat/composer";
import MessageList from "@/components/chat/message-list";
import { PhoneBack, useVisible } from "@/components/chat/room-view";
import { isLocal, lastOwnMessage, newestServerId, type ThreadState } from "@/lib/chat/timeline";
import type { ChatConversation, ChatMessage } from "@/lib/chat/types";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

function firstUnreadReply(messages: ChatMessage[], lastReadAt: string | null, viewerId: string) {
  if (!lastReadAt) return null;
  return messages.find((message) => !isLocal(message) && message.author.id !== viewerId && message.createdAt > lastReadAt)?.id ?? null;
}

export default function ThreadPanel({
  rootId,
  thread,
  conversation,
  bottomSignal,
  onClose,
}: {
  rootId: string;
  thread: ThreadState | null;
  conversation: ChatConversation | null;
  bottomSignal: number;
  onClose: () => void;
}) {
  const chat = useChat();
  const { viewer, send, setEditing, loadThread, markThreadRead } = chat;
  const heading = useRef<HTMLHeadingElement>(null);
  const [atBottom, setAtBottom] = useState(false);
  const visible = useVisible();
  const timeline = thread?.timeline ?? null;
  const ready = timeline?.status === "ready" && Boolean(thread?.root);
  const messages = useMemo(() => timeline?.messages ?? [], [timeline]);
  const root = thread?.root ?? null;
  const where = thread?.conversation ?? conversation;
  const place = where ? (where.kind === "dm" ? where.name : roomLabel(where)) : "";
  const backLabel = where ? (where.kind === "dm" ? where.name : `# ${where.name}`) : "Chat";
  const [divider, setDivider] = useState<{ ready: boolean; id: string | null }>({ ready: false, id: null });
  if (ready && !divider.ready) setDivider({ ready: true, id: firstUnreadReply(messages, timeline?.lastReadAt ?? null, viewer.id) });

  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) heading.current?.focus({ preventScroll: true });
  }, [rootId]);

  const newest = newestServerId(messages);
  const newestMessage = newest ? messages.find((message) => message.id === newest) : null;
  const behind = Boolean(thread?.following && newestMessage && (!timeline?.lastReadAt || newestMessage.createdAt > timeline.lastReadAt));

  useEffect(() => {
    if (!ready || !atBottom || !behind || !newest || !visible) return;
    const timer = window.setTimeout(() => markThreadRead(rootId, newest), 400);
    return () => window.clearTimeout(timer);
  }, [ready, atBottom, behind, newest, visible, rootId, markThreadRead]);

  const header = root ? (
    <>
      <ChatMessageRow message={root} continuation={false} inThread pane="thread" fullStamp />
      <div className="caption-style text-subtle mx-4 my-2 flex items-center gap-2.5 max-md:mx-3.5" role="separator">
        <span aria-hidden className="bg-line-subtle h-px flex-1" />
        {root.replyCount === 1 ? "1 reply" : `${root.replyCount} replies`}
        <span aria-hidden className="bg-line-subtle h-px flex-1" />
      </div>
    </>
  ) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" role="region" aria-labelledby={`thread-${rootId}`}>
      <header className="border-line-subtle flex h-[52px] shrink-0 items-center gap-2 border-b pr-3 pl-4 max-md:h-auto max-md:border-border max-md:px-3 max-md:py-2.5">
        <PhoneBack label={backLabel} onClick={onClose} />
        <div className="flex min-w-0 flex-col gap-1 max-md:flex-1 max-md:items-center">
          <h3 id={`thread-${rootId}`} ref={heading} tabIndex={-1} className="outline-none">
            Thread
          </h3>
          {place && <span className="caption-style text-subtle truncate max-md:hidden">{place}</span>}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close thread" title="Close (Esc)" onClick={onClose} className="ml-auto max-md:hidden">
          <XIcon aria-hidden className="size-4" />
        </Button>
        <span aria-hidden className="size-11 shrink-0 md:hidden" />
      </header>
      {timeline?.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="alert" className="text-danger">
            {timeline.error}
          </p>
          <Button variant="secondary" size="sm" onClick={() => loadThread(rootId, "latest")}>
            Try again
          </Button>
        </div>
      ) : (
        <MessageList
          key={rootId}
          messages={messages}
          ready={ready}
          dividerId={divider.id}
          days={false}
          pane="thread"
          align="start"
          bottomSignal={bottomSignal}
          hasOlder={timeline?.hasOlder ?? false}
          hasNewer={timeline?.hasNewer ?? false}
          focusId={null}
          header={header}
          label="Thread replies"
          onOlder={() => loadThread(rootId, "older")}
          onNewer={() => loadThread(rootId, "newer")}
          onLatest={() => loadThread(rootId, "latest")}
          onBottom={setAtBottom}
        />
      )}
      {timeline?.error && timeline.status === "ready" && (
        <p role="alert" className="caption-style text-danger px-4 pb-1">
          {timeline.error}
        </p>
      )}
      <div className="shrink-0 px-3 pb-3.5 max-md:px-2 max-md:pb-2">
        <Composer
          id={`chat-reply-${rootId}`}
          conversationId={root?.conversationId ?? where?.id ?? ""}
          parentId={rootId}
          placeholder="Reply…"
          label="Reply in thread"
          sendLabel="Send reply"
          autoFocus
          disabled={!root || Boolean(root.deletedAt && root.replyCount === 0)}
          onSend={(text, mentions) => (root ? send({ conversationId: root.conversationId, parentId: rootId, text, mentions }) : Promise.resolve(null))}
          onEditLast={() => {
            const own = lastOwnMessage(messages, viewer.id);
            if (!own) return false;
            setEditing({ id: own.id, pane: "thread" });
            return true;
          }}
        />
      </div>
    </div>
  );
}
