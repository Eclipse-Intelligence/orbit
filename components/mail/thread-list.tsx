"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { tagBase } from "@/components/beautifui/record-marks";
import { mailListWhen, personName, recipientList } from "@/lib/mail/format";
import { laterDetail } from "@/lib/mail/later";
import type { ThreadSummary } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import EyeIcon from "@/public/assets/images/mail/eye.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";

export type SwipeActions = {
  leftLabel: string;
  restore: boolean;
  rightLabel: string | null;
  onLeft: (key: string) => void;
  onRight: (key: string) => void;
};

type Drag = { pointer: number; x: number; y: number; axis: "x" | "y" | null };

function Row({
  thread,
  active,
  outgoing,
  showAccount,
  own,
  now,
  onOpen,
  onHover,
  swipe,
}: {
  thread: ThreadSummary;
  active: boolean;
  outgoing: boolean;
  showAccount: boolean;
  own: string[];
  now: number;
  onOpen: () => void;
  onHover: () => void;
  swipe: SwipeActions | null;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const swiped = useRef(false);
  const row = useRef<HTMLLIElement>(null);

  function down(event: PointerEvent<HTMLButtonElement>) {
    if (!swipe || event.pointerType !== "touch") return;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, axis: null };
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (state.axis === "x") {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }
    }
    if (state.axis === "x") setOffset(dx > 0 && !swipe?.rightLabel ? Math.min(dx, 24) : dx);
  }

  function up(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    drag.current = null;
    if (!state || state.pointer !== event.pointerId || state.axis !== "x" || !swipe) {
      setDragging(false);
      return;
    }
    swiped.current = true;
    window.setTimeout(() => (swiped.current = false), 50);
    setDragging(false);
    const width = row.current?.offsetWidth ?? 360;
    const threshold = Math.min(110, width * 0.28);
    const dx = event.clientX - state.x;
    if (dx < -threshold) {
      setOffset(-width);
      window.setTimeout(() => swipe.onLeft(thread.key), 160);
      return;
    }
    setOffset(0);
    if (dx > threshold && swipe.rightLabel) swipe.onRight(thread.key);
  }

  function cancel() {
    drag.current = null;
    setDragging(false);
    setOffset(0);
  }

  const reveal = Math.min(1, Math.abs(offset) / 110);
  const LeftIcon = swipe?.restore ? InboxIcon : ArchiveIcon;
  const people = outgoing || thread.draft ? `To ${recipientList(thread.to, own) || "no one yet"}` : personName(thread.from);
  return (
    <li ref={row} className="relative overflow-hidden rounded-xl">
      {offset !== 0 && swipe && (
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center rounded-xl px-5 text-[13px] font-medium",
            offset < 0 ? "text-success justify-end bg-[color-mix(in_srgb,var(--success)_16%,transparent)]" : "text-primary-foreground justify-start bg-[color-mix(in_srgb,var(--primary)_30%,transparent)]",
          )}
          style={{ opacity: 0.4 + reveal * 0.6 }}
        >
          {offset < 0 ? (
            <span className="flex items-center gap-2">
              {swipe.leftLabel}
              <LeftIcon className="size-4" />
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <ClockIcon className="size-4" />
              {swipe.rightLabel}
            </span>
          )}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          if (!swiped.current) onOpen();
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onMouseEnter={onHover}
        onFocus={onHover}
        data-mail-row={thread.key}
        aria-current={active ? "true" : undefined}
        className={cn(
          "ease-power3-out group relative flex w-full cursor-pointer touch-pan-y flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          dragging ? "transition-none" : "transition-[background-color,transform] duration-200",
          offset !== 0 ? "bg-background" : active ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
        )}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
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
            {thread.reads && thread.reads.count > 0 && (
              <EyeIcon aria-label={thread.reads.count === 1 ? "Read once" : `Read ${thread.reads.count} times`} className="text-status size-3" />
            )}
            {showAccount && (
              <span
                aria-hidden
                title={thread.account}
                className="size-1.5 rounded-full"
                style={{ background: tagBase(thread.account) }}
              />
            )}
            {thread.snoozedUntil ? (
              <span className="text-primary-foreground flex items-center gap-1 text-[12px] tabular-nums" title="Comes back to your inbox">
                <ClockIcon aria-hidden className="size-3" />
                {laterDetail(thread.snoozedUntil, now)}
              </span>
            ) : (
              <span className={cn("text-[12px] tabular-nums", thread.unread ? "text-foreground" : "text-subtle")}>
                {mailListWhen(thread.latestAt, now)}
              </span>
            )}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 pl-3.5 text-[13px]">
          {thread.reminder && (
            <span className="text-primary-foreground shrink-0 rounded-full bg-[color-mix(in_srgb,var(--primary)_30%,transparent)] px-1.5 text-[11px] leading-[18px] font-medium">
              {thread.reminder.kind === "follow_up" ? "No reply" : "Reminder"}
            </span>
          )}
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
  swipe,
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
  swipe: SwipeActions | null;
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
            swipe={swipe}
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
