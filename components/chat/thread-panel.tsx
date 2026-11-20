"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { FileDrop } from "@/components/chat/attachments";
import { roomLabel, useChat } from "@/components/chat/chat-context";
import ChatMessageRow from "@/components/chat/chat-message";
import Composer from "@/components/chat/composer";
import { useOrbitActions } from "@/components/chat/orbit-actions";
import MessageList from "@/components/chat/message-list";
import ScheduledNote from "@/components/chat/scheduled-note";
import { PhoneBack, useVisible } from "@/components/chat/room-view";
import { usePinsSync } from "@/components/chat/use-pins";
import { isLocal, lastOwnMessage, newestServerId, type ThreadState } from "@/lib/chat/timeline";
import { isDirect, type ChatConversation, type ChatMessage } from "@/lib/chat/types";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

function firstUnreadReply(messages: ChatMessage[], lastReadAt: string | null, viewerId: string) {
  if (!lastReadAt) return null;
  return messages.find((message) => !isLocal(message) && message.author.id !== viewerId && message.createdAt > lastReadAt)?.id ?? null;
}

function AskAboutThread({ root }: { root: ChatMessage }) {
  const { canAsk, ask } = useOrbitActions(root);
  if (!canAsk) return <span aria-hidden className="size-11 shrink-0 md:hidden" />;
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Ask Orbit about this thread" title="Ask Orbit about this thread" onClick={ask} className="hit max-md:size-11">
      <SparkleIcon aria-hidden className="size-3.5" />
    </Button>
  );
}

export default function ThreadPanel({
  rootId,
  focusId,
  thread,
  conversation,
  bottomSignal,
  onClose,
}: {
  rootId: string;
  focusId: string | null;
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
  const archived = Boolean((conversation ?? thread?.conversation)?.archivedAt);
  const place = where ? roomLabel(where) : "";
  const backLabel = where ? (isDirect(where.kind) ? where.name : `# ${where.name}`) : "Chat";
  const [divider, setDivider] = useState<{ ready: boolean; id: string | null }>({ ready: false, id: null });
  const addFiles = useRef<((files: File[]) => void) | null>(null);
  const target = root?.conversationId ?? where?.id ?? null;
  usePinsSync(target);
  const uploadTo = useCallback(() => Promise.resolve({ id: target, error: target ? null : "Couldn't upload. Try again." }), [target]);
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
      <ChatMessageRow message={root} continuation={false} inThread pane="thread" fullStamp readOnly={archived} />
      <div className="caption-style text-subtle mx-4 my-3 flex items-center justify-center gap-2.5 max-md:mx-3.5" role="separator">
        {root.replyCount === 1 ? "1 reply" : `${root.replyCount} replies`}
      </div>
    </>
  ) : null;

  return (
    <FileDrop
      label="Drop to add to the thread"
      disabled={!root || archived}
      onFiles={(files) => addFiles.current?.(files)}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      role="region"
      labelledBy={`thread-${rootId}`}
    >
      <header className="flex h-[52px] shrink-0 items-center gap-2 pr-3 pl-4 max-md:h-auto max-md:px-3 max-md:py-2.5">
        <PhoneBack label={backLabel} onClick={onClose} />
        <div className="flex min-w-0 flex-col gap-1 max-md:flex-1 max-md:items-center">
          <h3 id={`thread-${rootId}`} ref={heading} tabIndex={-1} className="outline-none">
            Thread
          </h3>
          {place && <span className="caption-style text-subtle truncate max-md:hidden">{place}</span>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pointer-coarse:gap-6 max-md:ml-0">
          {root ? <AskAboutThread root={root} /> : <span aria-hidden className="size-11 shrink-0 md:hidden" />}
          <Button variant="ghost" size="icon-sm" aria-label="Close thread" title="Close (Esc)" onClick={onClose} className="hit max-md:hidden">
            <XIcon aria-hidden className="size-4" />
          </Button>
        </div>
      </header>
      {timeline?.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="alert" className="text-danger">
            {timeline.error}
          </p>
          <Button variant="secondary" size="sm" className="hit" onClick={() => loadThread(rootId, "latest")}>
            Try again
          </Button>
        </div>
      ) : (
        <MessageList
          key={`${rootId}:${focusId ?? ""}`}
          messages={messages}
          ready={ready}
          dividerId={divider.id}
          days={false}
          pane="thread"
          align="start"
          bottomSignal={bottomSignal}
          loadError={timeline?.error ?? null}
          hasOlder={timeline?.hasOlder ?? false}
          hasNewer={timeline?.hasNewer ?? false}
          focusId={focusId}
          readOnly={archived}
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
        {archived ? (
          <p className="bg-surface-raised ui-style text-soft rounded-[10px] px-3 py-2.5">This room is archived.</p>
        ) : (
          <>
            {root && <ScheduledNote conversationId={root.conversationId} parentId={rootId} />}
            <Composer
              id={`chat-reply-${rootId}`}
              conversationId={root?.conversationId ?? where?.id ?? ""}
              parentId={rootId}
              placeholder="Reply…"
              label="Reply in thread"
              sendLabel="Send reply"
              scope="thread"
              autoFocus
              onEscape={onClose}
              disabled={!root || Boolean(root.deletedAt && root.replyCount === 0)}
              uploadTo={uploadTo}
              fileRef={addFiles}
              onSend={(text, mentions, attachments) => (root ? send({ conversationId: root.conversationId, parentId: rootId, text, mentions, attachments }) : Promise.resolve(null))}
              onSchedule={
                chat.schedule && root
                  ? (text, mentions, attachments, sendAt) => chat.schedule!.schedule({ conversationId: root.conversationId, parentId: rootId, text, mentions, attachments, sendAt })
                  : undefined
              }
              onEditLast={() => {
                const own = lastOwnMessage(messages, viewer.id);
                if (!own) return false;
                setEditing({ id: own.id, pane: "thread" });
                return true;
              }}
            />
          </>
        )}
      </div>
    </FileDrop>
  );
}
