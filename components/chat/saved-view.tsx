"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { MessageAttachments } from "@/components/chat/attachments";
import { ChatAvatar, useChat } from "@/components/chat/chat-context";
import { useChatEvents } from "@/components/chat/chat-live";
import { HookAvatar, HookCardBody } from "@/components/chat/hook-message";
import MessageLinks from "@/components/chat/link-previews";
import MessageBody from "@/components/chat/message-body";
import { PhoneBack } from "@/components/chat/room-view";
import { REMIND_CHOICES } from "@/components/chat/use-saved";
import { chatApi } from "@/lib/chat/client";
import { discussionHref } from "@/lib/chat/discussions";
import { fullTime, stampWhen } from "@/lib/chat/format";
import { savedPlace } from "@/lib/chat/saved";
import type { ChatSavedItem } from "@/lib/chat/types";
import { useChatSaved } from "@/stores/chat-saved-store";

function Row({ item }: { item: ChatSavedItem }) {
  const { go, viewer, now, memberNames, saved } = useChat();
  const router = useRouter();
  const { message, conversation, subject } = item;
  const author = { id: message.author.id ?? `former:${message.author.name}`, name: message.author.name };

  function open() {
    if (subject) {
      router.push(discussionHref(subject));
      return;
    }
    go({ view: { kind: "room", id: conversation.id }, thread: message.parentId, message: message.id });
  }

  return (
    <li className="border-border flex gap-3 border-b px-5 py-3 last:border-b-0 max-md:px-3.5">
      {message.hook ? <HookAvatar /> : <ChatAvatar person={author} size="lg" />}
      <article aria-label={`Saved message from ${message.author.name}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate text-[14px] font-medium">
            {message.author.name}
            {message.via && <span className="text-subtle font-normal"> via {message.via.name}</span>}
          </span>
          <span className="caption-style text-subtle min-w-0 truncate">{savedPlace(conversation)}</span>
          <time dateTime={message.createdAt} title={fullTime(message.createdAt)} className="caption-style text-subtle shrink-0 tabular-nums">
            {stampWhen(message.createdAt, now)}
          </time>
        </div>
        {message.hook ? (
          <HookCardBody card={message.hook} body={message.body} />
        ) : (
          <>
            {message.body && <MessageBody body={message.body} format={message.format} viewerId={viewer.id} names={memberNames} everyone={message.everyone} />}
            <MessageAttachments message={message} />
            <MessageLinks message={message} viewerId={viewer.id} canRemove={!conversation.archived} />
          </>
        )}
        <div className="-ml-2 flex flex-wrap items-center gap-1 pt-1">
          <Button variant="ghost" size="sm" onClick={open} className="hit max-md:h-11">
            Open
          </Button>
          <Button variant="ghost" size="sm" aria-label="Remove from Saved" onClick={() => saved.save(message, false)} className="hit max-md:h-11">
            Remove
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Remind me about this" className="hit max-md:h-11">
                Remind me
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[148px]">
              {REMIND_CHOICES.map((choice) => (
                <DropdownMenuItem key={choice.when} onSelect={() => saved.remind(message, choice.when)}>
                  {choice.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </article>
    </li>
  );
}

export default function SavedView() {
  const { back } = useChat();
  const [items, setItems] = useState<ChatSavedItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const ids = useChatSaved((store) => store.ids);

  const receive = useCallback((incoming: ChatSavedItem[], merge: (current: ChatSavedItem[], incoming: ChatSavedItem[]) => ChatSavedItem[]) => {
    for (const item of incoming) useChatSaved.getState().mark(item.message.id, true);
    setItems((current) => merge(current ?? [], incoming));
  }, []);

  const reload = useCallback(() => {
    chatApi
      .saved()
      .then((page) => {
        receive(page.items, (_, incoming) => incoming);
        setNext(page.next);
        setError(null);
      })
      .catch((failure: Error) => setError(failure.message));
    useChatSaved.getState().load();
  }, [receive]);

  useEffect(() => {
    reload();
  }, [reload]);

  useChatEvents((event) => {
    if (event.type === "delete") setItems((current) => current?.filter((item) => item.message.id !== event.messageId) ?? current);
    else if (event.type === "removed") setItems((current) => current?.filter((item) => item.conversation.id !== event.conversationId) ?? current);
    else if (event.type === "previews") setItems((current) => current?.map((item) => (item.message.id === event.messageId ? { ...item, message: { ...item.message, previews: event.previews } } : item)) ?? current);
    else if (event.type === "edit") setItems((current) => current?.map((item) => (item.message.id === event.message.id ? { ...item, message: event.message } : item)) ?? current);
  });

  function more() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    chatApi
      .saved(next)
      .then((page) => {
        receive(page.items, (current, incoming) => [...current, ...incoming.filter((item) => !current.some((known) => known.message.id === item.message.id))]);
        setNext(page.next);
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setLoadingMore(false));
  }

  const shown = items?.filter((item) => ids.has(item.message.id)) ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 px-5 max-md:h-auto max-md:px-3 max-md:py-2.5">
        <PhoneBack label="Chat" onClick={back} />
        <h2 className="max-md:flex-1 max-md:text-center">Saved</h2>
        <span aria-hidden className="size-11 shrink-0 md:hidden" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
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
        {shown === null && !error && (
          <p role="status" className="caption-style text-subtle py-10 text-center">
            Loading…
          </p>
        )}
        {shown?.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <h3>No saved messages</h3>
            <p className="text-soft max-w-[24em]">Only you can see what you save.</p>
          </div>
        )}
        {shown && shown.length > 0 && (
          <ul aria-label="Saved messages" className="flex flex-col">
            {shown.map((item) => (
              <Row key={item.message.id} item={item} />
            ))}
          </ul>
        )}
        {next && (
          <Button variant="secondary" size="sm" onClick={more} disabled={loadingMore} className="hit my-3 self-center max-md:h-11">
            {loadingMore ? "Loading…" : "Show more"}
          </Button>
        )}
      </div>
    </div>
  );
}
