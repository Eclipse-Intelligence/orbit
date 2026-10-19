"use client";

import { useEffect, useRef } from "react";
import { tagBase } from "@/components/beautifui/record-marks";
import { mailListWhen, personName, recipientList } from "@/lib/mail/format";
import type { ThreadSummary } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";

function Row({
  thread,
  active,
  outgoing,
  showAccount,
  own,
  now,
  onOpen,
  onHover,
}: {
  thread: ThreadSummary;
  active: boolean;
  outgoing: boolean;
  showAccount: boolean;
  own: string[];
  now: number;
  onOpen: () => void;
  onHover: () => void;
}) {
  const people = outgoing || thread.draft ? `To ${recipientList(thread.to, own) || "no one yet"}` : personName(thread.from);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={onHover}
        onFocus={onHover}
        data-mail-row={thread.key}
        aria-current={active ? "true" : undefined}
        className={cn(
          "ease-power3-out group relative flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          active ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", thread.unread ? "bg-primary shadow-[0_0_0_3px_rgba(65,36,251,0.18)]" : "bg-transparent")}
          />
          <span className={cn("min-w-0 truncate text-[14px]", thread.unread ? "text-foreground font-medium" : "text-soft")}>
            {thread.draft && <span className="text-danger mr-1">Draft</span>}
            {people}
          </span>
          {thread.count > 1 && <span className="text-subtle shrink-0 text-[12px] tabular-nums">{thread.count}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {thread.hasAttachments && <PaperclipIcon aria-label="Has attachments" className="text-subtle size-3" />}
            {thread.flagged && <FlagIcon aria-label="Flagged" className="text-warning size-3" />}
            {showAccount && (
              <span
                aria-hidden
                title={thread.account}
                className="size-1.5 rounded-full"
                style={{ background: tagBase(thread.account) }}
              />
            )}
            <span className={cn("text-[12px] tabular-nums", thread.unread ? "text-foreground" : "text-subtle")}>
              {mailListWhen(thread.latestAt, now)}
            </span>
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 pl-3.5 text-[13px]">
          <span className={cn("max-w-[70%] shrink-0 truncate", thread.unread ? "text-foreground" : "text-soft")}>
            {thread.subject?.trim() || "(no subject)"}
          </span>
          <span className="text-subtle min-w-0 truncate">{thread.snippet}</span>
        </span>
        <span className="sr-only">
          {[thread.unread && "Unread", thread.flagged && "Flagged", showAccount && thread.account].filter(Boolean).join(", ")}
        </span>
      </button>
    </li>
  );
}

export default function ThreadList({
  threads,
  cursor,
  outgoing,
  showAccount,
  own,
  now,
  loading,
  more,
  empty,
  onOpen,
  onHover,
  onMore,
}: {
  threads: ThreadSummary[];
  cursor: string | null;
  outgoing: boolean;
  showAccount: boolean;
  own: string[];
  now: number;
  loading: boolean;
  more: boolean;
  empty: string;
  onOpen: (key: string) => void;
  onHover: (key: string) => void;
  onMore: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(onMore);

  useEffect(() => {
    loadMore.current = onMore;
  });

  useEffect(() => {
    const element = sentinel.current;
    if (!element || !more) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore.current();
    }, { rootMargin: "600px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, threads.length]);

  useEffect(() => {
    if (!cursor) return;
    document.querySelector(`[data-mail-row="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (threads.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        {loading ? (
          <ul aria-label="Loading mail" className="flex w-full flex-col gap-3">
            {Array.from({ length: 7 }, (_, index) => (
              <li key={index} className="flex flex-col gap-2 px-3 py-2">
                <span className="bg-white/[0.05] h-3 w-1/3 animate-pulse rounded-full" />
                <span className="bg-white/[0.035] h-3 w-4/5 animate-pulse rounded-full" />
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="text-subtle text-center">
            {empty}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-6">
      <ul aria-label="Conversations" className="flex flex-col gap-px px-2">
        {threads.map((thread) => (
          <Row
            key={thread.key}
            thread={thread}
            active={thread.key === cursor}
            outgoing={outgoing}
            showAccount={showAccount}
            own={own}
            now={now}
            onOpen={() => onOpen(thread.key)}
            onHover={() => onHover(thread.key)}
          />
        ))}
      </ul>
      {more && (
        <div ref={sentinel} className="flex justify-center py-4">
          <span role="status" className="caption-style text-subtle">
            {loading ? "Loading older mail…" : ""}
          </span>
        </div>
      )}
    </div>
  );
}
