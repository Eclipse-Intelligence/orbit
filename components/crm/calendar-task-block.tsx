"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { formatTime } from "@/components/crm/calendar-event-details";
import { durationLabel } from "@/lib/crm/task-time";
import type { TaskBlock } from "@/lib/task-blocks";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import CloseIcon from "@/public/assets/images/mail/close.svg";

const TWO_LINES_PX = 28;

export type TaskBlockHandlers = {
  onOpen: (block: TaskBlock, opener: HTMLElement | null) => void;
  onComplete: (block: TaskBlock) => void;
};

export type TaskBlockDrag = {
  onPickUp: (event: ReactPointerEvent<HTMLElement>, block: TaskBlock) => void;
  onResize: (event: ReactPointerEvent<HTMLElement>, block: TaskBlock) => void;
};

function clashing(block: TaskBlock) {
  return Boolean(block.clash) && !block.done && !block.overdue;
}

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

function DoneCircle({ block, onOpen, onComplete, size }: TaskBlockHandlers & { block: TaskBlock; size: "sm" | "lg" }) {
  const icon = size === "sm" ? "size-2.5" : "size-3";
  const ring = size === "sm" ? "shadow-[inset_0_0_0_1.25px_color-mix(in_srgb,var(--violet)_80%,white_10%)]" : "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--violet)_80%,white_10%)]";
  return (
    <button
      type="button"
      data-task-circle=""
      aria-label={block.done ? `Done. Open “${block.title}”` : `Mark “${block.title}” done`}
      title={block.done ? "Done" : "Mark done"}
      onClick={(event) => (block.done ? onOpen(block, event.currentTarget) : onComplete(block))}
      className={cn(
        "group/circle ease-power2-out flex shrink-0 cursor-pointer items-center justify-center rounded-full text-white transition-colors duration-150",
        size === "sm" ? "pointer-events-auto size-3 [@media(pointer:coarse)]:pointer-events-none" : "hit size-[22px]",
        block.done ? "bg-success" : block.overdue ? "bg-danger hover:bg-success" : cn(ring, "hover:bg-success hover:shadow-none"),
      )}
    >
      {block.done ? (
        <CheckIcon aria-hidden className={icon} />
      ) : (
        <>
          {block.overdue && <CloseIcon aria-hidden className={cn(size === "sm" ? "size-2" : "size-2.5", "group-hover/circle:hidden")} />}
          <CheckIcon aria-hidden className={cn(icon, "hidden group-hover/circle:block")} />
        </>
      )}
    </button>
  );
}

function Detail({ block }: { block: TaskBlock }) {
  const parts: ReactNode[] = clashing(block)
    ? [<span key="clash" className="text-(--tag-amber-text)">Clashes with {block.clash}</span>]
    : [block.overdue ? <span key="overdue" className="text-danger font-medium">Overdue</span> : null, block.person, block.workspaceName];
  parts.push(<span key="duration" className="tabular-nums">{durationLabel(block.durationMinutes)}</span>);
  return (
    <>
      {parts.filter(Boolean).map((part, index) => (
        <span key={index}>
          {index > 0 && " · "}
          {part}
        </span>
      ))}
    </>
  );
}

export function GridTaskBlock({
  block,
  style,
  height,
  onOpen,
  onComplete,
  drag,
  lifted,
  resizing,
  resizable = true,
}: TaskBlockHandlers & {
  block: TaskBlock;
  style: CSSProperties;
  height: number;
  drag?: TaskBlockDrag;
  lifted?: boolean;
  resizing?: boolean;
  resizable?: boolean;
}) {
  const two = height >= TWO_LINES_PX;
  const edged = clashing(block);
  const movable = Boolean(drag) && !block.done;
  return (
    <div
      className={cn(
        "group/block absolute rounded-md",
        tone(block),
        movable && "touch-manipulation select-none [-webkit-touch-callout:none]",
        lifted && "outline-violet bg-transparent opacity-35 shadow-none outline-1 outline-offset-[-1px] outline-dashed",
        resizing && "z-[6] shadow-[inset_0_0_0_1px_var(--violet),0_6px_18px_rgba(0,0,0,0.4)]",
      )}
      style={style}
      data-task-block={block.task.id}
      data-task-lifted={lifted ? "" : undefined}
      onPointerDown={movable && drag ? (event) => drag.onPickUp(event, block) : undefined}
    >
      <button
        type="button"
        data-list-row=""
        data-task-id={block.task.id}
        aria-label={taskBlockLabel(block)}
        title={taskBlockLabel(block)}
        onClick={(event) => onOpen(block, event.currentTarget)}
        className={cn(
          "focus-visible:ring-ring/60 absolute inset-0 flex min-w-0 overflow-hidden rounded-md pr-1.5 text-left outline-none focus-visible:ring-2",
          movable ? "cursor-grab" : "cursor-pointer",
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
          <span data-task-detail="" className="text-soft min-w-0 truncate text-[11px] leading-[13px]">
            <Detail block={block} />
          </span>
        ) : block.overdue ? (
          <span className="text-danger shrink-0 text-[11px] leading-[18px] font-medium">Overdue</span>
        ) : (
          <span className={cn("shrink-0 text-[11px] leading-[18px] tabular-nums", block.done ? "text-faint" : "text-soft")}>{durationLabel(block.durationMinutes)}</span>
        )}
      </button>
      <span className={cn("pointer-events-none absolute inset-y-0 left-0 z-[1] flex justify-center", edged ? "w-6 pl-[3px]" : "w-5", two ? "items-start pt-1" : "items-center")}>
        <DoneCircle block={block} onOpen={onOpen} onComplete={onComplete} size="sm" />
      </span>
      {movable && drag && resizable && (
        <span
          aria-hidden
          data-task-resize=""
          onPointerDown={(event) => drag.onResize(event, block)}
          onClick={(event) => onOpen(block, event.currentTarget.parentElement?.querySelector<HTMLElement>("button[data-task-id]") ?? null)}
          className={cn(
            "absolute right-0 bottom-0 z-[2] flex h-1.5 cursor-ns-resize items-end justify-center pb-0.5",
            edged ? "left-6" : "left-5",
            "[@media(pointer:coarse)]:left-auto [@media(pointer:coarse)]:h-full [@media(pointer:coarse)]:max-h-7 [@media(pointer:coarse)]:w-8 [@media(pointer:coarse)]:justify-end [@media(pointer:coarse)]:rounded-br-md [@media(pointer:coarse)]:pr-1 [@media(pointer:coarse)]:pb-[3px]",
          )}
        >
          <span
            className={cn(
              "bg-violet ease-power2-out h-1 w-[22px] rounded-full opacity-0 transition-opacity duration-150 group-hover/block:opacity-100 [@media(pointer:coarse)]:w-3 [@media(pointer:coarse)]:opacity-70",
              resizing && "opacity-100",
            )}
          />
        </span>
      )}
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
        onClick={(event) => onOpen(block, event.currentTarget)}
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
      <DoneCircle block={block} onOpen={onOpen} onComplete={onComplete} size="lg" />
    </div>
  );
}
