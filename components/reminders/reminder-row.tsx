"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { swipeCommit, watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import type { Reminder } from "@/lib/crm/reminders";
import { dayLabel, REMINDER_LINK_LABEL, repeatWords, type ReminderRow } from "@/lib/reminders-card";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";

const OUT_MS = 180;

export function ReminderTick({ reminder, done, large, onToggle }: { reminder: Reminder; done: boolean; large: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      aria-label={done ? `Undo “${reminder.title}”` : `Mark “${reminder.title}” done`}
      title={done ? "Undo" : "Done"}
      className={cn(
        "hit z-[1] focus-visible:ring-ring/60 ease-power3-out relative mt-px flex shrink-0 cursor-pointer items-center justify-center rounded-full text-white outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2",
        large ? "size-5" : "size-4",
        done ? "bg-primary" : "shadow-[inset_0_0_0_1.5px_#5a5a5a] hover:shadow-[inset_0_0_0_1.5px_var(--primary)]",
      )}
    >
      {done && <CheckIcon aria-hidden className={large ? "size-3" : "size-2.5"} />}
    </button>
  );
}

function Meta({ row, today, group }: { row: ReminderRow; today: string; group: "today" | "upcoming" | "noDate" | "done" }) {
  const { reminder } = row;
  const pieces: { key: string; text: string; tone?: "over" | "num" }[] = [];
  if (reminder.dueOn && (row.overdue || group !== "today")) pieces.push({ key: "day", text: dayLabel(reminder.dueOn, today), tone: row.overdue && !row.ticked ? "over" : undefined });
  if (reminder.time) pieces.push({ key: "time", text: reminder.time, tone: "num" });
  const repeats = repeatWords(reminder);
  if (repeats) pieces.push({ key: "repeat", text: repeats });
  if (reminder.blocksTime) pieces.push({ key: "block", text: "Blocks time" });
  if (pieces.length === 0) return null;
  return (
    <span className="caption-style text-subtle flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {pieces.map((piece, index) =>
        piece.tone === "over" ? (
          <span key={piece.key} className="rounded-full bg-danger/12 px-1.5 py-px text-danger">
            {piece.text}
          </span>
        ) : (
          <span key={piece.key} className={cn(piece.tone === "num" && "tabular-nums")}>
            {index > 0 && piece.key === "block" ? "· " : ""}
            {piece.text}
          </span>
        ),
      )}
    </span>
  );
}

export default function ReminderRowView({
  row,
  today,
  group,
  large,
  swipe,
  onTick,
  onOpen,
  onFollow,
}: {
  row: ReminderRow;
  today: string;
  group: "today" | "upcoming" | "noDate" | "done";
  large: boolean;
  swipe: boolean;
  onTick: (row: ReminderRow) => void;
  onOpen: (reminder: Reminder) => void;
  onFollow: () => void;
}) {
  const { reminder, ticked } = row;
  const done = ticked || Boolean(reminder.completedAt);
  const body = useRef<HTMLDivElement>(null);
  const item = useRef<HTMLLIElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const handlers = useRef<SwipeHandlers>({});
  const armedBefore = useRef(false);
  const timer = useRef<number | null>(null);
  const swipeable = swipe && !done;
  const [width, setWidth] = useState(360);
  const armed = offset > 0 && swipeCommit(offset, 0, width, { left: false, right: true }) !== null;

  useEffect(() => {
    handlers.current = {
      canRight: swipeable,
      canLeft: false,
      scroller: () => item.current?.closest<HTMLElement>("[data-reminders-scroll]") ?? null,
      width: () => item.current?.offsetWidth ?? window.innerWidth,
      onDrag: (dx) => {
        setDragging(true);
        const rowWidth = item.current?.offsetWidth ?? 360;
        setWidth(rowWidth);
        const nowArmed = dx > 0 && swipeCommit(dx, 0, rowWidth, { left: false, right: true }) !== null;
        if (nowArmed && !armedBefore.current) navigator.vibrate?.(8);
        armedBefore.current = nowArmed;
        setOffset(Math.max(0, dx));
      },
      onRelease: (commit) => {
        armedBefore.current = false;
        setDragging(false);
        if (commit === "right") {
          setOffset(item.current?.offsetWidth ?? 360);
          timer.current = window.setTimeout(() => {
            timer.current = null;
            setOffset(0);
            onTick(row);
          }, OUT_MS);
          return;
        }
        setOffset(0);
      },
    };
  });

  useEffect(() => {
    const element = body.current;
    const stop = element && swipeable ? watchSwipe(element, () => handlers.current) : undefined;
    return () => {
      stop?.();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [swipeable]);

  return (
    <li ref={item} data-reminder-row={reminder.title} className={cn("relative rounded-lg", offset !== 0 && "overflow-hidden")}>
      {offset > 0 && (
        <span
          aria-hidden
          className={cn(
            "ease-power3-out absolute inset-0 flex items-center px-4 text-[13px] font-medium transition-colors duration-150",
            armed ? "bg-[color-mix(in_srgb,var(--success)_78%,black)] text-white" : "text-soft bg-white/[0.06]",
          )}
        >
          <span className={cn("ease-power3-out flex items-center gap-2 transition-transform duration-150", armed ? "scale-100" : "scale-90")}>
            <CheckIcon className="size-[18px]" />
            Done
          </span>
        </span>
      )}
      <div
        ref={body}
        className={cn("relative touch-pan-y", offset !== 0 && "bg-popover", dragging ? "transition-none" : "ease-power3-out transition-transform duration-200")}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        <div className={cn("group/row flex items-start gap-2.5 rounded-lg hover:bg-surface-hover", large ? "px-2.5 py-2.5" : "px-2 py-[7px]")}>
          <ReminderTick reminder={reminder} done={done} large={large} onToggle={() => onTick(row)} />
          <div className="relative flex min-w-0 flex-1 flex-col gap-[3px]">
            {!done && (
              <button
                type="button"
                aria-label={`Open “${reminder.title}”`}
                onClick={() => onOpen(reminder)}
                className="focus-visible:ring-ring/60 absolute -inset-y-1.5 -right-2 left-1 cursor-pointer rounded-md outline-none focus-visible:ring-2"
              />
            )}
            <span className={cn("pointer-events-none relative break-words", large ? "text-[15px] leading-5" : "ui-style", done ? "text-faint line-through" : "text-foreground")}>{reminder.title}</span>
            <span className="pointer-events-none relative">
              <Meta row={row} today={today} group={group} />
            </span>
            {reminder.link && (
              <Link
                href={reminder.link}
                onClick={onFollow}
                className="caption-style text-soft hover:text-foreground focus-visible:ring-ring/60 hit relative z-[1] self-start rounded-sm underline decoration-white/35 underline-offset-[3px] outline-none focus-visible:ring-2"
              >
                {REMINDER_LINK_LABEL}
              </Link>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
