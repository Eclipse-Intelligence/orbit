"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { ChatContext, useChat } from "@/components/chat/chat-context";
import ChatMessageRow from "@/components/chat/chat-message";
import Composer from "@/components/chat/composer";
import type { Discussion } from "@/components/chat/use-discussion";
import { dayOf } from "@/lib/chat/format";
import { isLocal, lastOwnMessage, newestServerId, startsGroup } from "@/lib/chat/timeline";
import type { ChatMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";

export const DISCUSSION_PLACEHOLDER = "Comment… @ to tag";
export const NOTE_PLACEHOLDER = "Note… @ to tag";

export function holdEscape(discussion: Discussion | null) {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) {
    if (active.getAttribute("aria-expanded") === "true" || active.getAttribute("aria-label") === "Edit message") return true;
    if (active.closest("[data-chat-composer]") && active.value.trim()) return true;
  }
  if (discussion?.threadId) {
    discussion.context.closeThread();
    return true;
  }
  return false;
}

export function DiscussionProvider({ discussion, children }: { discussion: Discussion; children: ReactNode }) {
  return <ChatContext.Provider value={discussion.context}>{children}</ChatContext.Provider>;
}

function Rows({ messages, pane }: { messages: ChatMessage[]; pane: "room" | "thread" }) {
  const rows = useMemo(
    () =>
      messages.map((message, index) => {
        const previous = index > 0 ? messages[index - 1] : null;
        const sameDay = previous !== null && dayOf(previous.createdAt) === dayOf(message.createdAt);
        return {
          message,
          continuation: !startsGroup(previous, message, sameDay),
        };
      }),
    [messages],
  );
  const last = messages.length - 1;
  return (
    <>
      {rows.map(({ message, continuation }, index) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          continuation={continuation}
          inThread={pane === "thread"}
          pane={pane}
          fullStamp={!continuation}
          tabStop={index === last}
        />
      ))}
    </>
  );
}

export function DiscussionMessages({
  discussion,
  empty = "No comments yet.",
  label = "Discussion",
  className,
}: {
  discussion: Discussion;
  empty?: string;
  label?: string;
  className?: string;
}) {
  const { status, error, timeline, reload, loadOlder } = discussion;
  const messages = timeline?.messages ?? [];
  if (status === "loading" && !timeline) {
    return (
      <p role="status" className={cn("caption-style text-subtle py-3", className)}>
        Loading…
      </p>
    );
  }
  if (status === "error" && !timeline) {
    return (
      <div className={cn("flex flex-col items-start gap-2 py-2", className)}>
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
        <Button variant="secondary" size="sm" onClick={reload} className="hit max-md:h-11">
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div role="log" aria-label={label} aria-live="polite" className={cn("-mx-5 flex flex-col max-md:-mx-3.5", className)}>
      {timeline?.hasOlder && (
        <Button variant="ghost" size="sm" onClick={loadOlder} className="hit mx-5 mb-1 self-start max-md:mx-3.5 max-md:h-11 md:pointer-coarse:my-2">
          Show earlier
        </Button>
      )}
      {messages.length === 0 ? <p className="caption-style text-subtle px-5 py-1 max-md:px-3.5">{empty}</p> : <Rows messages={messages} pane="room" />}
      {timeline?.error && (
        <p role="alert" className="caption-style text-danger px-5 pt-1 max-md:px-3.5">
          {timeline.error}
        </p>
      )}
    </div>
  );
}

export function DiscussionComposer({
  discussion,
  parentId = null,
  autoFocus,
  onEscape,
  noun = "comment",
}: {
  discussion: Discussion;
  parentId?: string | null;
  autoFocus?: boolean;
  onEscape?: () => void;
  noun?: "comment" | "note";
}) {
  const { viewer, setEditing } = useChat();
  const messages = parentId ? (discussion.thread?.timeline.messages ?? []) : (discussion.timeline?.messages ?? []);
  const root = parentId ? discussion.thread?.root : null;
  const prompting = Boolean(discussion.needsShare) && discussion.needsShare?.parentId === parentId;
  return (
    <Composer
      key={discussion.composerVersion}
      id={`discussion-${parentId ?? discussion.draftId}`}
      conversationId={discussion.draftId}
      parentId={parentId}
      placeholder={parentId ? "Reply…" : noun === "note" ? NOTE_PLACEHOLDER : DISCUSSION_PLACEHOLDER}
      label={parentId ? "Reply in thread" : noun === "note" ? "Note" : "Comment"}
      sendLabel={parentId ? "Send reply" : noun === "note" ? "Send note" : "Send comment"}
      compact
      restoreOnFailure
      hideFailure={prompting}
      fallbackDraft={discussion.keptDraft?.parentId === parentId ? discussion.keptDraft : null}
      autoFocus={autoFocus}
      disabled={prompting || (Boolean(parentId) && (!root || Boolean(root.deletedAt && root.replyCount === 0)))}
      onEscape={onEscape}
      onSend={(text, mentions) =>
        discussion.context.send({
          conversationId: discussion.conversationId ?? "",
          parentId,
          text,
          mentions,
        })
      }
      onEditLast={() => {
        const own = lastOwnMessage(messages, viewer.id);
        if (!own) return false;
        setEditing({ id: own.id, pane: parentId ? "thread" : "room" });
        return true;
      }}
    />
  );
}

export function DiscussionThread({ discussion, backLabel }: { discussion: Discussion; backLabel: string }) {
  const { thread, threadId } = discussion;
  const { markThreadRead, closeThread, loadThread } = discussion.context;
  const heading = useRef<HTMLHeadingElement>(null);
  const root = thread?.root ?? null;
  const timeline = thread?.timeline ?? null;
  const replies = useMemo(() => timeline?.messages ?? [], [timeline]);
  const newest = newestServerId(replies);
  const newestMessage = newest ? replies.find((message) => message.id === newest) : null;
  const behind = Boolean(thread?.following && newestMessage && !isLocal(newestMessage) && (!timeline?.lastReadAt || newestMessage.createdAt > timeline.lastReadAt));

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [threadId]);

  useEffect(() => {
    if (!threadId || !newest || !behind || document.visibilityState !== "visible") return;
    const timer = window.setTimeout(() => markThreadRead(threadId, newest), 400);
    return () => window.clearTimeout(timer);
  }, [threadId, newest, behind, markThreadRead]);

  if (!threadId) return null;
  return (
    <section aria-labelledby={`discussion-thread-${threadId}`} className="flex flex-col gap-2 md:pointer-coarse:pt-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={closeThread} aria-label={`Back to ${backLabel}`} className="hit -ml-2 gap-1 pr-2.5 pl-1.5 max-md:h-11">
          <ChevronLeftIcon aria-hidden className="size-3.5" />
          {backLabel}
        </Button>
        <h3 id={`discussion-thread-${threadId}`} ref={heading} tabIndex={-1} className="outline-none">
          Thread
        </h3>
      </div>
      {timeline?.status === "error" && !root ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="caption-style text-danger">
            {timeline.error}
          </p>
          <Button variant="secondary" size="sm" onClick={() => loadThread(threadId, "latest")} className="hit max-md:h-11">
            Try again
          </Button>
        </div>
      ) : !root ? (
        <p role="status" className="caption-style text-subtle">
          Loading…
        </p>
      ) : (
        <div role="log" aria-label="Thread replies" aria-live="polite" className="-mx-5 flex flex-col max-md:-mx-3.5">
          <ChatMessageRow message={root} continuation={false} inThread pane="thread" fullStamp />
          <div className="caption-style text-subtle mx-5 my-2 flex items-center gap-2.5 max-md:mx-3.5" role="separator">
            <span aria-hidden className="bg-line-subtle h-px flex-1" />
            {root.replyCount === 1 ? "1 reply" : `${root.replyCount} replies`}
            <span aria-hidden className="bg-line-subtle h-px flex-1" />
          </div>
          {timeline?.hasOlder && (
            <Button variant="ghost" size="sm" onClick={() => loadThread(threadId, "older")} className="hit mx-5 mb-1 self-start max-md:mx-3.5 max-md:h-11 md:pointer-coarse:mb-2">
              Show earlier
            </Button>
          )}
          <Rows messages={replies} pane="thread" />
        </div>
      )}
    </section>
  );
}

export function DiscussionNotice({ discussion }: { discussion: Discussion }) {
  if (!discussion.notice) return null;
  return (
    <div role="alert" className="ui-style bg-popover border-line-strong flex items-center gap-3 rounded-xl border py-2 pr-2 pl-3.5">
      <span className="min-w-0 flex-1">{discussion.notice}</span>
      <Button variant="ghost" size="sm" onClick={discussion.dismissNotice} className="hit max-md:h-11">
        Dismiss
      </Button>
    </div>
  );
}
