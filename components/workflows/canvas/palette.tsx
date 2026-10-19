"use client";

import type { DragEvent } from "react";
import { DRAG_TYPE } from "@/components/workflows/canvas/workflow-canvas";
import { GROUP_STYLE, PALETTE, STEP_META } from "@/components/workflows/canvas/node-meta";
import { STEP_HINTS, STEP_LABELS, type StepType } from "@/lib/workflows/definition";
import { cn } from "@/lib/utils";

export default function Palette({ onAdd, disabled }: { onAdd: (type: StepType) => void; disabled?: boolean }) {
  function start(event: DragEvent, type: StepType) {
    event.dataTransfer.setData(DRAG_TYPE, type);
    event.dataTransfer.effectAllowed = "move";
  }

  return (
    <nav aria-label="Nodes" className="flex flex-col gap-4">
      {PALETTE.map((group) => (
        <section key={group.label} className="flex flex-col gap-1">
          <h3 className="eyebrow-style text-faint px-2">{group.label}</h3>
          <ul className="flex flex-col">
            {group.types.map((type) => {
              const meta = STEP_META[type];
              return (
                <li key={type}>
                  <button
                    type="button"
                    draggable={!disabled}
                    disabled={disabled}
                    onDragStart={(event) => start(event, type)}
                    onClick={() => onAdd(type)}
                    title={STEP_HINTS[type]}
                    className="focus-visible:ring-ring/60 flex w-full cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/5 focus-visible:ring-2 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className={cn("grid size-7 shrink-0 place-items-center rounded-md", GROUP_STYLE[meta.group])}>
                      <meta.icon aria-hidden className="size-3.5" />
                    </span>
                    <span className="truncate text-[13.5px] leading-5">{STEP_LABELS[type]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="caption-style text-subtle px-2 leading-[1.45]">Click to add below the selected node, or drag onto the canvas. Connect nodes by dragging from the dot under a node to the next one.</p>
    </nav>
  );
}
