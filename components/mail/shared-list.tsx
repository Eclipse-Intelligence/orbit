"use client";

import { useEffect, useRef } from "react";
import Button from "@/components/_ui/button";
import { PersonAvatar } from "@/components/mail/share-control";
import { mailFullWhen, mailListWhen, snippetCore } from "@/lib/mail/format";
import type { SharedThreadSummary } from "@/lib/mail/share-types";
import { sharedByLabel, sharedListPerson } from "@/lib/mail/share-view";
import { cn } from "@/lib/utils";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";

export default function SharedList({
  threads,
  cursor,
  viewerId,
  now,
  error,
  onOpen,
  onRetry,
}: {
  threads: SharedThreadSummary[] | null;
  cursor: string | null;
  viewerId: string;
  now: number;
  error: string | null;
  onOpen: (shareId: string) => void;
  onRetry: () => void;
}) {
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!cursor) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-mail-row="${CSS.escape(cursor)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    if (list.current?.contains(document.activeElement) && document.activeElement !== row) row.focus({ preventScroll: true });
  }, [cursor]);

  if (error && !threads?.length) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <p role="alert" className="text-danger">
          {error}
        </p>
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (!threads) {
    return (
      <div role="status" aria-busy="true" className="flex w-full flex-col px-6 py-16">
        <span className="sr-only">Loading shared threads…</span>
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <p role="status" className="text-subtle text-center">
          Nothing is shared with you.
        </p>
      </div>
    );
  }

  const focusKey = threads.some((thread) => thread.shareId === cursor) ? cursor : threads[0].shareId;

  return (
    <div className="flex flex-col pb-24 max-md:pb-[var(--floating-clearance)]">
      <ul ref={list} role="listbox" aria-label="Shared conversations" className="flex flex-col gap-px px-2">
        {threads.map((thread) => {
          const active = thread.shareId === cursor;
          const shared = sharedByLabel(thread.owner);
          return (
            <li key={thread.shareId} role="none" className="rounded-xl">
              <button
                type="button"
                role="option"
                aria-selected={active}
                aria-current={active ? "true" : undefined}
                tabIndex={thread.shareId === focusKey ? 0 : -1}
                data-mail-row={thread.shareId}
                onClick={() => onOpen(thread.shareId)}
                className={cn(
                  "ease-power3-out flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60",
                  active ? "bg-surface-active" : "hover:bg-surface-hover",
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <PersonAvatar person={thread.owner} viewerId={viewerId} size="xs" className="-ml-[5px] -mr-px" />
                  <span className="text-foreground min-w-0 truncate text-[14px]">{sharedListPerson(thread)}</span>
                  {thread.count > 1 && <span className="text-subtle shrink-0 text-[12px] tabular-nums">{thread.count}</span>}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {thread.hasAttachments && <PaperclipIcon aria-label="Has attachments" className="text-subtle size-3" />}
                    <time dateTime={thread.latestAt ?? undefined} title={mailFullWhen(thread.latestAt)} className="text-subtle text-[12px] tabular-nums">
                      {mailListWhen(thread.latestAt, now)}
                    </time>
                  </span>
                </span>
                <span className="flex min-w-0 items-baseline gap-1.5 pl-3.5 text-[13px]">
                  <span className="text-foreground max-w-[70%] shrink-0 truncate">{thread.subject?.trim() || "(no subject)"}</span>
                  <span className="text-subtle min-w-0 truncate">{snippetCore(thread.snippet)}</span>
                </span>
                <span className="caption-style text-subtle pl-3.5">{shared}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
