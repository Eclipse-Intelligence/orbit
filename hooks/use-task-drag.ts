"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { dateKey, DAY_MINUTES, wallMinutes } from "@/lib/calendar-view";
import type { Task } from "@/lib/crm/types";
import { startPointerGesture, type GestureResult } from "@/lib/pointer-gesture";
import type { TaskBlock } from "@/lib/task-blocks";
import {
  blockDuration,
  DRAG_STEP_MINUTES,
  edgeScrollSpeed,
  placementFor,
  samePlace,
  snapDuration,
  snapStart,
  type DropPlacement,
  type GridSlot,
} from "@/lib/task-drag";

const GRID_QUERY = "(min-width: 768px)";
const DRAGGING_CLASSES = ["select-none", "cursor-grabbing"];

export type TaskDrag = {
  task: Task;
  source: "list" | "block";
  mode: "move" | "resize";
  durationMinutes: number;
  x: number;
  y: number;
  slot: GridSlot | null;
  overList: boolean;
  scrolling: -1 | 0 | 1;
};

export type TaskPress = { x: number; y: number };

type Pickup = {
  task: Task;
  source: TaskDrag["source"];
  mode: TaskDrag["mode"];
  durationMinutes: number;
  grab: number;
  day: string | null;
  start: number;
};

function subscribeGrid(onChange: () => void) {
  const list = window.matchMedia(GRID_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

export function useGridDrag() {
  return useSyncExternalStore(
    subscribeGrid,
    () => window.matchMedia(GRID_QUERY).matches,
    () => false,
  );
}

function shown(node: Element) {
  const box = node.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function gridScroller() {
  return (
    [
      ...document.querySelectorAll<HTMLElement>("[data-calendar-scroller]"),
    ].find(shown) ?? null
  );
}

function gridColumns(scroller: HTMLElement | null) {
  return scroller
    ? [...scroller.querySelectorAll<HTMLElement>("[data-day]")]
    : [];
}

function minuteIn(column: HTMLElement, y: number) {
  const box = column.getBoundingClientRect();
  return box.height > 0 ? ((y - box.top) / box.height) * DAY_MINUTES : 0;
}

function columnAt(columns: HTMLElement[], x: number) {
  return (
    columns.find((column) => {
      const box = column.getBoundingClientRect();
      return x >= box.left && x < box.right;
    }) ?? null
  );
}

function overDropZone(x: number, y: number) {
  return [...document.querySelectorAll<HTMLElement>("[data-task-drop]")].some(
    (zone) => {
      const box = zone.getBoundingClientRect();
      return (
        box.width > 0 &&
        x >= box.left &&
        x <= box.right &&
        y >= box.top &&
        y <= box.bottom
      );
    },
  );
}

function swallowNextClick() {
  const swallow = (click: MouseEvent) => {
    click.stopPropagation();
    click.preventDefault();
    stop();
  };
  const timer = window.setTimeout(stop, 600);
  function stop() {
    window.clearTimeout(timer);
    window.removeEventListener("click", swallow, true);
  }
  window.addEventListener("click", swallow, true);
}

export function useTaskDrag({
  onPlace,
  onCarry,
}: {
  onPlace: (task: Task, placement: DropPlacement) => void;
  onCarry?: () => void;
}) {
  const [drag, setDrag] = useState<TaskDrag | null>(null);
  const [press, setPress] = useState<TaskPress | null>(null);
  const live = useRef<TaskDrag | null>(null);
  const latest = useRef({ onPlace, onCarry });
  useEffect(() => {
    latest.current = { onPlace, onCarry };
  });
  useEffect(
    () => () => {
      document.body.classList.remove(...DRAGGING_CLASSES);
    },
    [],
  );

  const begin = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      pickup: Pickup,
      options: { carry?: boolean } = {},
    ) => {
      if (live.current || (event.pointerType === "mouse" && event.button !== 0))
        return;
      let x = event.clientX;
      let y = event.clientY;
      let frame = 0;
      let active = false;
      const touch = event.pointerType === "touch";
      if (touch) setPress({ x, y });

      function slotAt(): GridSlot | null {
        const scroller = gridScroller();
        if (!scroller) return null;
        const area = scroller.getBoundingClientRect();
        if (y < area.top || y > area.bottom || x < area.left || x > area.right)
          return pickup.mode === "resize" ? (live.current?.slot ?? null) : null;
        const columns = gridColumns(scroller);
        if (pickup.mode === "resize") {
          const column = columns.find(
            (item) => item.dataset.day === pickup.day,
          );
          if (!column || !pickup.day) return null;
          return {
            day: pickup.day,
            minutes: pickup.start,
            durationMinutes: snapDuration(pickup.start, minuteIn(column, y)),
          };
        }
        const column = columnAt(columns, x);
        const day = column?.dataset.day;
        if (!column || !day) return null;
        return {
          day,
          minutes: snapStart(
            minuteIn(column, y) - pickup.grab,
            pickup.durationMinutes,
          ),
          durationMinutes: pickup.durationMinutes,
        };
      }

      function scrollSpeed() {
        const scroller = gridScroller();
        if (!scroller) return 0;
        const area = scroller.getBoundingClientRect();
        if (x < area.left || x > area.right) return 0;
        return edgeScrollSpeed(y, area.top, area.bottom);
      }

      function update(scrolling: -1 | 0 | 1) {
        const overList = pickup.mode === "move" && overDropZone(x, y);
        const next: TaskDrag = {
          task: pickup.task,
          source: pickup.source,
          mode: pickup.mode,
          durationMinutes: pickup.durationMinutes,
          x,
          y,
          slot: overList ? null : slotAt(),
          overList,
          scrolling,
        };
        live.current = next;
        setDrag(next);
      }

      function tick() {
        if (!active) return;
        const speed = scrollSpeed();
        const scroller = gridScroller();
        if (speed !== 0 && scroller) {
          const before = scroller.scrollTop;
          scroller.scrollTop = before + speed;
          const moved = scroller.scrollTop !== before;
          update(moved ? (speed > 0 ? 1 : -1) : 0);
        } else if (live.current?.scrolling) update(0);
        frame = window.requestAnimationFrame(tick);
      }

      function end(result: GestureResult) {
        window.cancelAnimationFrame(frame);
        setPress(null);
        const final = live.current;
        live.current = null;
        active = false;
        document.body.classList.remove(...DRAGGING_CLASSES);
        setDrag(null);
        if (result !== "drop" || !final) return;
        swallowNextClick();
        if (final.overList) {
          if (
            pickup.source === "block" &&
            pickup.task.dueHasTime &&
            pickup.task.dueAt
          )
            latest.current.onPlace(pickup.task, { dateOnly: true });
          return;
        }
        if (!final.slot || samePlace(pickup.task, final.slot)) return;
        latest.current.onPlace(pickup.task, placementFor(final.slot));
      }

      startPointerGesture(
        event,
        {
          start() {
            active = true;
            setPress(null);
            if (!touch) document.body.classList.add(...DRAGGING_CLASSES);
            if (options.carry) latest.current.onCarry?.();
            update(0);
            frame = window.requestAnimationFrame(tick);
          },
          move(clientX, clientY) {
            x = clientX;
            y = clientY;
            if (active) update(live.current?.scrolling ?? 0);
          },
          end,
        },
        { touchTarget: event.target },
      );
    },
    [],
  );

  const pickUpFromList = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      task: Task,
      options: { carry?: boolean } = {},
    ) => {
      if (task.completedAt) return;
      begin(
        event,
        {
          task,
          source: "list",
          mode: "move",
          durationMinutes: blockDuration(task.durationMinutes),
          grab: DRAG_STEP_MINUTES / 2,
          day: null,
          start: 0,
        },
        options,
      );
    },
    [begin],
  );

  const pickUpBlock = useCallback(
    (event: ReactPointerEvent<HTMLElement>, block: TaskBlock) => {
      if (
        block.done ||
        (event.target as HTMLElement).closest("[data-task-circle]")
      )
        return;
      const day = dateKey(block.startsAt);
      const start = wallMinutes(block.startsAt);
      const column = gridColumns(gridScroller()).find(
        (item) => item.dataset.day === day,
      );
      const grab = column
        ? Math.max(0, minuteIn(column, event.clientY) - start)
        : 0;
      begin(event, {
        task: block.task,
        source: "block",
        mode: "move",
        durationMinutes: blockDuration(block.durationMinutes),
        grab,
        day,
        start,
      });
    },
    [begin],
  );

  const resizeBlock = useCallback(
    (event: ReactPointerEvent<HTMLElement>, block: TaskBlock) => {
      if (block.done) return;
      event.stopPropagation();
      begin(event, {
        task: block.task,
        source: "block",
        mode: "resize",
        durationMinutes: blockDuration(block.durationMinutes),
        grab: 0,
        day: dateKey(block.startsAt),
        start: wallMinutes(block.startsAt),
      });
    },
    [begin],
  );

  return { drag, press, pickUpFromList, pickUpBlock, resizeBlock };
}
