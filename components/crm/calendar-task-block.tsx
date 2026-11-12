"use client";

import type { CSSProperties } from "react";
import { formatTime } from "@/components/crm/calendar-event-details";
import { durationLabel } from "@/lib/crm/task-time";
import type { TaskBlock } from "@/lib/task-blocks";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import CloseIcon from "@/public/assets/images/mail/close.svg";

const TWO_LINES_PX = 28;
const OWN_HIT_PX = 44;

export type TaskBlockHandlers = {
  onOpen: (block: TaskBlock) => void;
  onComplete: (block: TaskBlock) => void;
};

function tone(block: TaskBlock) {
  if (block.done) return "bg-white/[0.035] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]";
  if (block.overdue)
    return "bg-[color-mix(in_srgb,var(--danger)_11%,#1b1b1b)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--danger)_40%,transparent)]";
  if (block.clash)
    return "bg-[color-mix(in_srgb,var(--violet)_15%,#1b1b1b)] shadow-[inset_3px_0_0_var(--warning),inset_0_0_0_1px_color-mix(in_srgb,var(--warning)_45%,transparent)]";
  return "bg-[color-mix(in_srgb,var(--violet)_15%,#1b1b1b)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--violet)_42%,transparent)]";
}

export function taskBlockLabel(block: TaskBlock) {
  return [
    block.title,
    `${formatTime(block.startsAt)} to ${formatTime(block.endsAt)}`,
    "task",
    block.done ? "done" : null,
    block.overdue ? "overdue" : null,
    block.clash ? `clashes with ${block.clash}` : null,
    block.person,
    block.workspaceName,
  ]
    .filter(Boolean)
    .join(", ");
}

function DoneCircle({ block, onComplete, size, hit }: { block: TaskBlock; onComplete: (block: TaskBlock) => void; size: "sm" | "lg"; hit: boolean }) {
  return (
    <button
      type="button"
      disabled={block.done}
      aria-label={block.done ? "Done" : `Mark “${block.title}” done`}
      title={block.done ? "Done" : "Mark done"}
      onClick={() => onComplete(block)}
      className={cn(
        "group/circle flex shrink-0 items-center justify-center rounded-full transition-colors duration-150 enabled:cursor-pointer disabled:cursor-default",
        hit && "hit",
        size === "sm" ? "size-3" : "size-[22px]",
        block.done
          ? "bg-success text-white"
          : block.overdue
            ? "bg-danger enabled:hover:bg-success text-white"
            : size === "sm"
              ? "enabled:hover:bg-success text-white shadow-[inset_0_0_0_1.25px_color-mix(in_srgb,var(--violet)_80%,white_10%)] enabled:hover:shadow-none"
              : "enabled:hover:bg-success text-white shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--violet)_80%,white_10%)] enabled:hover:shadow-none",
      )}
    >
      {block.done ? (
        <CheckIcon aria-hidden className={size === "sm" ? "size-2.5" : "size-3"} />
      ) : block.overdue ? (
        <>
          <CloseIcon aria-hidden className={cn(size === "sm" ? "size-2" : "size-2.5", "group-enabled/circle:group-hover/circle:hidden")} />
          <CheckIcon aria-hidden className={cn(size === "sm" ? "size-2.5" : "size-3", "hidden group-enabled/circle:group-hover/circle:block")} />
        </>
      ) : (
        <CheckIcon aria-hidden className={cn(size === "sm" ? "size-2.5" : "size-3", "hidden group-enabled/circle:group-hover/circle:block")} />
      )}
    </button>
  );
}

function Detail({ block }: { block: TaskBlock }) {
  const parts = [
    block.overdue ? (
      <span key="overdue" className="text-danger font-medium">
        Overdue
      </span>
    ) : null,
    block.clash ? (
      <span key="clash" className="text-(--tag-amber-text)">
        Clashes with {block.clash}
      </span>
    ) : null,
    block.person ? <span key="person">{block.person}</span> : null,
    block.workspaceName ? <span key="workspace">{block.workspaceName}</span> : null,
    <span key="duration" className="tabular-nums">
      {durationLabel(block.durationMinutes)}
    </span>,
  ].filter(Boolean);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && " · "}
          {part}
        </span>
      ))}
    </>
  );
}

export function GridTaskBlock({ block, style, height, onOpen, onComplete }: TaskBlockHandlers & { block: TaskBlock; style: CSSProperties; height: number }) {
  const two = height >= TWO_LINES_PX;
  const edged = Boolean(block.clash) && !block.done && !block.overdue;
  return (
    <div className={cn("absolute rounded-md", tone(block))} style={style} data-task-block={block.task.id}>
      <button
        type="button"
        data-list-row=""
        data-task-id={block.task.id}
        aria-label={taskBlockLabel(block)}
        title={taskBlockLabel(block)}
        onClick={() => onOpen(block)}
        className={cn(
          "focus-visible:ring-ring/60 absolute inset-0 flex min-w-0 cursor-pointer overflow-hidden rounded-md pr-1.5 text-left outline-none focus-visible:ring-2",
          edged ? "pl-[24px]" : "pl-[21px]",
          two ? "flex-col pt-0.5" : "items-center gap-1.5",
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate text-[12px] font-medium",
            two ? "leading-[15px]" : "flex-1 leading-[18px]",
            block.done ? "text-subtle decoration-white/25 line-through" : "text-foreground",
          )}
        >
          {block.title}
        </span>
        {two ? (
          <span className="text-soft min-w-0 truncate text-[11px] leading-[13px]">
            <Detail block={block} />
          </span>
        ) : block.overdue ? (
          <span className="text-danger shrink-0 text-[11px] leading-[18px] font-medium">Overdue</span>
        ) : (
          <span className={cn("shrink-0 text-[11px] leading-[18px] tabular-nums", block.done ? "text-faint" : "text-soft")}>{durationLabel(block.durationMinutes)}</span>
        )}
      </button>
      <span className={cn("absolute z-[1] flex", edged ? "left-[7px]" : "left-1", two ? "top-1" : "top-1/2 -translate-y-1/2")}>
        <DoneCircle block={block} onComplete={onComplete} size="sm" hit={height >= OWN_HIT_PX} />
      </span>
    </div>
  );
}

export function AgendaTaskBlock({ block, past, onOpen, onComplete }: TaskBlockHandlers & { block: TaskBlock; past: boolean }) {
  return (
    <div
      className={cn("flex w-full items-center gap-2.5 rounded-xl py-2.5 pr-3 pl-[15px]", tone(block), past && !block.overdue && !block.done && "opacity-60")}
      data-task-block={block.task.id}
    >
      <button
        type="button"
        data-list-row=""
        data-task-id={block.task.id}
        aria-label={taskBlockLabel(block)}
        onClick={() => onOpen(block)}
        className="focus-visible:ring-ring/60 flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2"
      >
        <span className="caption-style text-soft w-[76px] shrink-0 tabular-nums">{formatTime(block.startsAt)}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn("truncate text-[14px] leading-5", block.done && "text-subtle decoration-white/25 line-through")}>{block.title}</span>
          <span className="caption-style text-subtle truncate">
            <Detail block={block} />
          </span>
        </span>
      </button>
      <DoneCircle block={block} onComplete={onComplete} size="lg" hit />
    </div>
  );
}
