"use client";

import { useEffect, useRef, useState } from "react";
import { tagBase } from "@/components/beautifui/record-marks";
import { mailListWhen, personName, recipientList, snippetCore } from "@/lib/mail/format";
import { laterDetail } from "@/lib/mail/later";
import type { ThreadSummary } from "@/lib/mail/view";
import { swipeCommit, watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import { cn } from "@/lib/utils";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import EyeIcon from "@/public/assets/images/mail/eye.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";

type SwipeActions = {
  leftLabel: string;
  restore: boolean;
  rightLabel: string | null;
  onLeft: (key: string) => void;
  onRight: (key: string) => void;
};

const LONG_PRESS_MS = 450;

function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 800);
}
const OUT_MS = 180;
const COLLAPSE_MS = 220;

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
  selecting,
  selected,
  onToggle,
}: {
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
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
  const [height, setHeight] = useState<number | null>(null);
  const swiped = useRef(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const armedBefore = useRef(false);
  const row = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const handlers = useRef<SwipeHandlers>({});
  const timers = useRef<number[]>([]);
  const [width, setWidth] = useState(360);
  const allowed = { left: Boolean(swipe), right: Boolean(swipe?.rightLabel) };
  const armed = offset !== 0 && swipeCommit(offset, 0, width, allowed) !== null;

  useEffect(() => {
    const later = (run: () => void, ms: number) => timers.current.push(window.setTimeout(run, ms));
    handlers.current = {
      canLeft: allowed.left && height === null,
      canRight: allowed.right && height === null,
      scroller: () => row.current?.closest<HTMLElement>(".overflow-y-auto") ?? null,
      onDrag: (dx) => {
        if (!swipe || height !== null) return;
        const rowWidth = row.current?.offsetWidth ?? 360;
        setWidth(rowWidth);
        setDragging(true);
        const nowArmed = swipeCommit(dx, 0, rowWidth, allowed) !== null;
        if (nowArmed && !armedBefore.current) navigator.vibrate?.(8);
        armedBefore.current = nowArmed;
        setOffset(dx);
      },
      onRelease: (commit) => {
        armedBefore.current = false;
        setDragging(false);
        swiped.current = true;
        later(() => (swiped.current = false), 50);
        if (!swipe || !commit) {
          setOffset(0);
          return;
        }
        if (commit === "left") {
          const rowWidth = row.current?.offsetWidth ?? width;
          setOffset(-rowWidth);
          later(() => {
            setHeight(row.current?.offsetHeight ?? 64);
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => setHeight(0)));
          }, OUT_MS);
          later(() => swipe.onLeft(thread.key), OUT_MS + COLLAPSE_MS);
          return;
        }
        setOffset(0);
        swipe.onRight(thread.key);
      },
    };
  });

  useEffect(() => {
    const element = button.current;
    const pending = timers.current;
    const stop = element ? watchSwipe(element, () => handlers.current) : undefined;
    return () => {
      stop?.();
      pending.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const LeftIcon = swipe?.restore ? InboxIcon : ArchiveIcon;
  const people = outgoing || thread.draft ? `To ${recipientList(thread.to, own) || "no one yet"}` : personName(thread.from);
  return (
    <li
      ref={row}
      className={cn("relative overflow-hidden rounded-xl", height !== null && "ease-power3-in-out transition-[height,opacity] duration-200")}
      style={height !== null ? { height, opacity: height === 0 ? 0 : 1 } : undefined}
    >
      {offset !== 0 && swipe && (
        <span
          aria-hidden
          className={cn(
            "ease-power3-out absolute inset-0 flex items-center rounded-xl px-5 text-[13px] font-medium transition-colors duration-150",
            offset < 0 ? "justify-end" : "justify-start",
            !armed
              ? "text-soft bg-white/[0.06]"
              : offset < 0
                ? "bg-[color-mix(in_srgb,var(--success)_78%,black)] text-white"
                : "bg-primary text-white",
          )}
        >
          <span
            className={cn(
              "ease-power3-out flex items-center gap-2 transition-transform duration-150",
              armed ? "scale-100" : "scale-90",
              offset < 0 && "flex-row-reverse",
            )}
          >
            {offset < 0 ? <LeftIcon className="size-[18px]" /> : <ClockIcon className="size-[18px]" />}
            {offset < 0 ? swipe.leftLabel : swipe.rightLabel}
          </span>
        </span>
      )}
      <button
        type="button"
        onPointerDown={(event) => {
          if (event.pointerType !== "touch") return;
          const { clientX: x, clientY: y } = event;
          press.current = {
            x,
            y,
            timer: window.setTimeout(() => {
              press.current = null;
              pressed.current = true;
              swallowNextClick();
              navigator.vibrate?.(10);
              onToggle();
            }, LONG_PRESS_MS),
          };
        }}
        onPointerMove={(event) => {
          const start = press.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
            window.clearTimeout(start.timer);
            press.current = null;
          }
        }}
        onPointerUp={() => {
          if (press.current) window.clearTimeout(press.current.timer);
          press.current = null;
        }}
        onPointerCancel={() => {
          if (press.current) window.clearTimeout(press.current.timer);
          press.current = null;
        }}
        onContextMenu={(event) => {
          if (pressed.current || press.current) event.preventDefault();
        }}
        onClick={(event) => {
          if (pressed.current) {
            pressed.current = false;
            return;
          }
          if (swiped.current) return;
          if (selecting || event.metaKey || event.ctrlKey || event.shiftKey) onToggle();
          else onOpen();
        }}
        aria-pressed={selecting ? selected : undefined}
        ref={button}
        onMouseEnter={onHover}
        onFocus={onHover}
        data-mail-row={thread.key}
        aria-current={active ? "true" : undefined}
        className={cn(
          "ease-power3-out group relative flex w-full cursor-pointer touch-pan-y flex-col select-none [-webkit-touch-callout:none] gap-0.5 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          dragging ? "transition-none" : "transition-[background-color,transform] duration-200 ease-power3-out",
          offset !== 0
            ? "bg-background"
            : active
              ? "bg-white/[0.07]"
              : selected
                ? "bg-[color-mix(in_srgb,var(--primary)_12%,transparent)]"
                : "hover:bg-white/[0.035]",
        )}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selecting ? (
            <span
              aria-hidden
              className={cn(
                "-ml-1 flex size-3.5 shrink-0 items-center justify-center rounded-full",
                selected ? "bg-primary" : "shadow-[inset_0_0_0_1.5px_var(--line-strong)]",
              )}
            >
              {selected && (
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5 10 17.5 19 7.5" />
                </svg>
              )}
            </span>
          ) : (
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", thread.unread ? "bg-primary shadow-[0_0_0_3px_rgba(65,36,251,0.18)]" : "bg-transparent")}
            />
          )}
          <span className={cn("min-w-0 truncate text-[14px]", thread.unread ? "text-foreground font-medium" : "text-soft")}>
            {thread.draft && <span className="mr-1 text-[var(--tag-amber-text)]">Draft</span>}
            {people}
          </span>
          {thread.count > 1 && <span className="text-subtle shrink-0 text-[12px] tabular-nums">{thread.count}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {thread.prepared && <SparkleIcon aria-label="Reply ready" className="text-primary-foreground size-3" />}
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
          <span className="text-subtle min-w-0 truncate">{snippetCore(thread.snippet)}</span>
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
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (key: string) => void;
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
    <div className="flex flex-col pb-24">
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
            selecting={selected.size > 0}
            selected={selected.has(thread.key)}
            onToggle={() => onToggle(thread.key)}
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
