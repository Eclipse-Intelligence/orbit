"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { Monogram } from "@/components/beautifui/record-marks";
import EmailFrame from "@/components/mail/email-frame";
import MessageAttachments from "@/components/mail/message-attachments";
import { PeopleStack, PersonAvatar } from "@/components/mail/share-control";
import { fetchSharedThread, ShareRequestError } from "@/components/mail/share-client";
import { useMailShareEvents } from "@/components/mail/share-live";
import ThreadNotes, { useNotesLayout } from "@/components/mail/thread-notes";
import { TextBody, When } from "@/components/mail/thread-reader";
import type { ChatPerson } from "@/lib/chat/types";
import { personName, recipientList, snippetCore } from "@/lib/mail/format";
import type { SharedMessage, SharedThread, SharedThreadSummary } from "@/lib/mail/share-types";
import { peopleLine, removedLine, sharedByLabel } from "@/lib/mail/share-view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";

const FOCUS_GAP_MS = 5_000;

type Loaded = { shareId: string; thread: SharedThread | null; error: string | null; removed: boolean };

function SharedMessageCard({
  shareId,
  message,
  expanded,
  collapsible,
  hideQuotes,
  onToggle,
}: {
  shareId: string;
  message: SharedMessage;
  expanded: boolean;
  collapsible: boolean;
  hideQuotes: boolean;
  onToggle: () => void;
}) {
  const sender = personName(message.from);
  const to = recipientList(message.to, []);
  const cc = recipientList(message.cc, []);
  const headingId = `shared-email-${message.id}`;
  const header = (
    <>
      <Monogram name={sender} className="mt-0.5 size-7 rounded-full text-[11px]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-foreground truncate text-[14px]">{sender}</span>
          {expanded && message.from && message.from.address !== sender && (
            <span className="text-subtle hidden min-w-0 truncate text-[12px] sm:inline">{message.from.address}</span>
          )}
          <When at={message.at} className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums" />
        </span>
        {expanded ? (
          <span className="text-subtle truncate text-[12px]">
            {to ? `To ${to}` : "No recipients"}
            {cc ? ` · Cc ${cc}` : ""}
          </span>
        ) : (
          <span className="text-subtle truncate text-[13px]">{snippetCore(message.snippet)}</span>
        )}
      </span>
    </>
  );
  return (
    <article aria-labelledby={headingId} className={cn("rounded-2xl", expanded ? "bg-surface-panel" : "hover:bg-surface-hover")}>
      <h3 id={headingId} className="sr-only">
        Email from {sender}
      </h3>
      <div className="flex items-start">
        {collapsible || !expanded ? (
          <Button
            variant="item"
            size="none"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${sender}'s email` : `Open ${sender}'s email`}
            className="min-w-0 flex-1 rounded-2xl px-4 py-3 leading-normal hover:bg-transparent"
          >
            {header}
            {expanded && <ChevronDownIcon aria-hidden className="text-subtle mt-1 size-3.5 shrink-0 rotate-180" />}
          </Button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left">{header}</div>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-14">
          {message.html ? (
            <EmailFrame html={message.html} rich={message.rich} title={`Email from ${sender}`} hideQuotes={hideQuotes} />
          ) : message.text ? (
            <TextBody text={message.text} hideQuotes={hideQuotes} />
          ) : (
            <p className="text-subtle">{message.snippet || "This email has no text."}</p>
          )}
          {message.truncated && <p className="caption-style text-subtle">Only the start of this email is shown.</p>}
          {message.hasAttachments && <MessageAttachments messageId={message.id} shareId={shareId} />}
        </div>
      )}
    </article>
  );
}

function SharedMessages({ thread }: { thread: SharedThread }) {
  const messages = thread.messages;
  const last = messages.length - 1;
  const [open, setOpen] = useState<Set<string>>(() => new Set(last >= 0 ? [messages[last].id] : []));
  const [showAll, setShowAll] = useState(messages.length <= 4);
  const hidden = showAll ? 0 : messages.length - 3;
  const visible = showAll ? messages : [messages[0], ...messages.slice(-2)];
  if (messages.length === 0) return <p className="text-subtle px-4">Nothing to show in this thread yet.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((message, index) => (
        <div key={message.id} className="flex flex-col gap-1.5">
          <SharedMessageCard
            shareId={thread.shareId}
            message={message}
            expanded={open.has(message.id)}
            collapsible={messages.length > 1}
            hideQuotes={message.id !== messages[0].id}
            onToggle={() =>
              setOpen((current) => {
                const next = new Set(current);
                if (next.has(message.id)) next.delete(message.id);
                else next.add(message.id);
                return next;
              })
            }
          />
          {!showAll && index === 0 && hidden > 0 && (
            <Button variant="chip" size="chip" onClick={() => setShowAll(true)} className="mx-4 self-start pointer-coarse:h-11">
              {hidden} more {hidden === 1 ? "email" : "emails"}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function SharedReader({
  shareId,
  summary,
  viewer,
  notes = false,
  onBack,
  onOwner,
  onGone,
}: {
  notes?: boolean;
  shareId: string;
  summary: SharedThreadSummary | null;
  viewer: ChatPerson;
  onBack: () => void;
  onOwner: (threadKey: string) => void;
  onGone: () => void;
}) {
  const [state, setState] = useState<Loaded | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const loaded = state?.shareId === shareId ? state : null;
  const thread = loaded?.thread ?? null;
  const removed = Boolean(loaded?.removed);
  const layout = useNotesLayout(body, Boolean(thread) && !removed);
  const owner = thread?.owner ?? summary?.owner ?? null;
  const latest = useRef({ onOwner, onGone, loaded });
  useEffect(() => {
    latest.current = { onOwner, onGone, loaded };
  });

  const load = useCallback(() => {
    const asked = shareId;
    fetchSharedThread(asked)
      .then((fresh) => {
        if (fresh.viewerIsOwner && fresh.threadKey) {
          latest.current.onOwner(fresh.threadKey);
          return;
        }
        setState({ shareId: asked, thread: fresh, error: null, removed: false });
      })
      .catch((error: unknown) => {
        const status = error instanceof ShareRequestError ? error.status : 0;
        const had = latest.current.loaded?.shareId === asked && Boolean(latest.current.loaded.thread);
        if (status === 404 && had) {
          setState((current) => (current?.shareId === asked ? { ...current, removed: true } : current));
          latest.current.onGone();
          return;
        }
        setState((current) =>
          current?.shareId === asked && current.thread
            ? current
            : { shareId: asked, thread: null, error: error instanceof Error ? error.message : "Couldn't load the thread. Try again.", removed: false },
        );
      });
  }, [shareId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < FOCUS_GAP_MS || latest.current.loaded?.removed) return;
      last = Date.now();
      load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  useMailShareEvents((event) => {
    if (event.shareId !== shareId) return;
    if (event.type === "removed") {
      setState((current) => (current?.shareId === shareId ? { ...current, removed: true } : { shareId, thread: null, error: null, removed: true }));
      latest.current.onGone();
      return;
    }
    if (!removed) load();
  });

  const subject = thread?.subject ?? summary?.subject ?? null;
  const people = thread?.people ?? [];
  const others = people.filter((person) => person.id !== viewer.id && !person.owner);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div role="group" aria-label="Shared thread" className="flex min-h-[46px] shrink-0 items-center gap-2 px-3 py-2 sm:px-5">
        <Button variant="ghost" size="icon" aria-label="Back to the list" title="Back (Esc)" onClick={onBack} className="pointer-coarse:size-11 md:hidden">
          <ChevronLeftIcon aria-hidden className="size-3.5" />
        </Button>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {owner && <PersonAvatar person={owner} viewerId={viewer.id} size="sm" />}
          <span className="ui-style text-foreground truncate">{owner ? sharedByLabel(owner) : "Shared"}</span>
          <span aria-hidden className="text-faint">
            ·
          </span>
          <span className="ui-style text-subtle shrink-0">Read only</span>
        </span>
        {people.length > 0 && !removed && (
          <span className="caption-style text-subtle flex min-w-0 shrink items-center gap-1.5">
            <PeopleStack people={[...others, ...people.filter((person) => person.id === viewer.id)]} viewerId={viewer.id} />
            <span className="truncate max-sm:sr-only">{peopleLine(people, viewer.id)}</span>
          </span>
        )}
      </div>
      <div ref={body} className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-x-none">
          <div className="mx-auto flex w-full max-w-[52em] flex-col gap-4 px-3 pt-3 pb-[var(--floating-clearance)] sm:px-6">
            <h2 className="px-4 text-pretty">{subject?.trim() || "(no subject)"}</h2>
            {removed ? (
              <p role="status" className="text-soft px-4">
                {owner ? removedLine(owner) : "You were removed from this thread."}
              </p>
            ) : thread ? (
              <>
                <SharedMessages key={`${thread.shareId}:${thread.messages.length}:${thread.messages.at(-1)?.id ?? ""}`} thread={thread} />
                {layout === "below" && <ThreadNotes shareId={shareId} viewer={viewer} layout="below" reveal={notes} />}
              </>
            ) : loaded?.error ? (
              <div className="flex flex-col items-start gap-3 px-4">
                <p role="alert" className="text-danger">
                  {loaded.error}
                </p>
                <Button variant="secondary" onClick={load} className="pointer-coarse:h-11">
                  Try again
                </Button>
              </div>
            ) : (
              <div role="status" aria-busy="true" className="flex flex-col gap-3 px-4">
                <span className="sr-only">Loading the conversation</span>
                <span aria-hidden className="bg-surface-raised h-3 w-1/4 animate-pulse rounded-full" />
                <span aria-hidden className="bg-surface-hover h-24 w-full animate-pulse rounded-2xl" />
              </div>
            )}
          </div>
        </div>
        {thread && !removed && layout === "side" && <ThreadNotes shareId={shareId} viewer={viewer} layout="side" reveal={notes} />}
      </div>
    </div>
  );
}
