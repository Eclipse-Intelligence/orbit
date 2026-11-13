"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import { ChatAvatar, useChat } from "@/components/chat/chat-context";
import ChatMessageRow from "@/components/chat/chat-message";
import { useChatEvents } from "@/components/chat/chat-live";
import Composer from "@/components/chat/composer";
import { PhoneBack } from "@/components/chat/room-view";
import { chatApi } from "@/lib/chat/client";
import { shortWhen } from "@/lib/chat/format";
import { appendCards, refreshCards } from "@/lib/chat/timeline";
import type { ChatThreadCard, ChatThreads } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

const SETTLE_MS = 500;

function Card({ card, open: expanded }: { card: ChatThreadCard; open: boolean }) {
  const { now, openThread, send, viewer } = useChat();
  const unread = card.unread > 0;
  const latestAt = card.latest[card.latest.length - 1]?.createdAt ?? card.root.lastReplyAt;
  const open = () => openThread(card.conversation.id, card.root.id);
  const other = [card.root, ...card.latest].find((message) => message.author.id && message.author.id !== viewer.id)?.author ?? null;
  return (
    <article
      className={cn("rounded-2xl pt-3 pb-2", unread ? "bg-surface-raised" : "bg-surface-panel")}
      aria-label={`Thread in ${card.conversation.kind === "dm" ? card.conversation.name : `#${card.conversation.name}`}`}
    >
      <div className="flex items-center gap-2 px-4 pb-1.5 max-md:px-3 md:pointer-coarse:pb-3.5">
        <button
          type="button"
          onClick={open}
          className="ui-style hit flex min-w-0 items-center gap-2 rounded-md font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 max-md:min-h-11"
        >
          {card.conversation.kind === "dm" ? (
            <>
              <ChatAvatar person={other ? { id: other.id ?? card.conversation.id, name: other.name } : { id: card.conversation.id, name: card.conversation.name }} size="xs" />
              <span className="truncate">{card.conversation.name}</span>
              <span className="caption-style text-subtle font-normal max-sm:hidden">Direct message</span>
            </>
          ) : (
            <span className={cn("truncate", !unread && "text-soft")}>
              <span aria-hidden className="text-faint">
                #
              </span>
              {card.conversation.name}
            </span>
          )}
        </button>
        {unread && (
          <Tag tone="purple" size="sm" className="h-5 text-[12px]">
            {card.unread} new
          </Tag>
        )}
        {latestAt && <span className="caption-style text-subtle ml-auto shrink-0">{shortWhen(latestAt, now)}</span>}
      </div>
      <ChatMessageRow message={card.root} continuation={false} inThread={expanded} pane="card" />
      {expanded && (
        <>
          {card.earlier > 0 && (
            <Button variant="link" size="none" onClick={open} className="ui-style hit text-subtle mt-0.5 mb-1 ml-14 font-normal max-md:ml-[50px] max-md:min-h-11 md:pointer-coarse:mt-2 md:pointer-coarse:mb-3.5">
              {card.earlier === 1 ? "1 earlier reply" : `${card.earlier} earlier replies`}
            </Button>
          )}
          {card.latest.map((message) => (
            <ChatMessageRow key={message.id} message={message} continuation={false} inThread pane="card" />
          ))}
          <div className="py-1.5 pr-4 pl-14 max-md:pr-3 max-md:pl-3">
            <Composer
              id={`chat-card-${card.root.id}`}
              conversationId={card.conversation.id}
              parentId={card.root.id}
              placeholder="Reply…"
              label="Reply in thread"
              sendLabel="Send reply"
              compact
              restoreOnFailure
              onSend={(text, mentions) => send({ conversationId: card.conversation.id, parentId: card.root.id, text, mentions, discardOnFailure: true })}
            />
          </div>
        </>
      )}
    </article>
  );
}

export default function ThreadsView({ initial }: { initial: ChatThreads | { error: string } | null }) {
  const { back } = useChat();
  const seeded = initial && "threads" in initial ? initial : null;
  const [cards, setCards] = useState<ChatThreadCard[] | null>(seeded?.threads ?? null);
  const [next, setNext] = useState<string | null>(seeded?.next ?? null);
  const [error, setError] = useState<string | null>(initial && "error" in initial ? initial.error : null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set((seeded?.threads ?? []).filter((card) => card.unread > 0).map((card) => card.root.id)));
  const [loadingMore, setLoadingMore] = useState(false);
  const settle = useRef(0);

  const receive = useCallback((incoming: ChatThreadCard[], merge: (current: ChatThreadCard[], incoming: ChatThreadCard[]) => ChatThreadCard[]) => {
    setCards((current) => merge(current ?? [], incoming));
    setExpanded((current) => {
      const opened = incoming.filter((card) => card.unread > 0 && !current.has(card.root.id));
      return opened.length ? new Set([...current, ...opened.map((card) => card.root.id)]) : current;
    });
  }, []);

  const reload = useCallback(() => {
    chatApi
      .threads()
      .then((page) => {
        receive(page.threads, refreshCards);
        setNext((current) => current ?? page.next);
        setError(null);
      })
      .catch((failure: Error) => setError(failure.message));
  }, [receive]);

  useEffect(() => {
    if (!seeded) reload();
  }, [seeded, reload]);

  useEffect(() => () => window.clearTimeout(settle.current), []);

  useChatEvents((event) => {
    if (event.type === "message" && !event.message.parentId) return;
    if (event.type === "read") return;
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(reload, SETTLE_MS);
  });

  function more() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    chatApi
      .threads(next)
      .then((page) => {
        receive(page.threads, appendCards);
        setNext(page.next);
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setLoadingMore(false));
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-line-subtle flex h-[52px] shrink-0 items-center gap-2 border-b px-5 max-md:h-auto max-md:border-border max-md:px-3 max-md:py-2.5">
        <PhoneBack label="Chat" onClick={back} />
        <h2 className="max-md:flex-1 max-md:text-center">Threads</h2>
        <span aria-hidden className="size-11 shrink-0 md:hidden" />
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
        {cards === null && !error && (
          <p role="status" className="caption-style text-subtle py-10 text-center">
            Loading threads…
          </p>
        )}
        {cards?.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <h3>No threads yet</h3>
            <p className="text-soft max-w-[24em]">Threads you start, reply to or are mentioned in show here.</p>
          </div>
        )}
        {cards?.map((card) => <Card key={card.root.id} card={card} open={expanded.has(card.root.id)} />)}
        {next && (
          <Button variant="secondary" size="sm" onClick={more} disabled={loadingMore} className="hit self-center max-md:h-11">
            {loadingMore ? "Loading…" : "Show more"}
          </Button>
        )}
      </div>
    </div>
  );
}
