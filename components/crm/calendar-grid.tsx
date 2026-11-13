"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/_ui/popover";
import CalendarEventDetails, {
  eventTitle,
  formatTime,
  formatTimeRange,
  type CalendarMeta,
} from "@/components/crm/calendar-event-details";
import {
  allDayKeys,
  dateKey,
  DAY_MINUTES,
  daySpan,
  packColumns,
  wallMinutes,
} from "@/lib/calendar-view";
import { GridTaskBlock, type TaskBlockDrag, type TaskBlockHandlers } from "@/components/crm/calendar-task-block";
import type { TaskDrag } from "@/hooks/use-task-drag";
import { snapTime } from "@/lib/invite-rules";
import type { CalendarItem } from "@/lib/crm/calendars";
import { durationLabel } from "@/lib/crm/task-time";
import { runLabel, type PreviewRun } from "@/lib/plan-preview";
import type { TaskBlock } from "@/lib/task-blocks";
import { slotDayLabel, slotRange, type GridSlot } from "@/lib/task-drag";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const MIN_HOUR_HEIGHT = 64;
const MAX_HOUR_HEIGHT = 120;
const FOCUS_START_HOUR = 8;
const FOCUS_HOURS = 12;
const MIN_MINUTES = 20;
const MIN_TASK_MINUTES = 15;
const COMPACT_BELOW_PX = 44;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function eventStyle(
  color: string,
  showAs: string | null,
): CSSProperties {
  if (showAs === "free") {
    return {
      backgroundColor: `${color}14`,
      borderColor: `${color}80`,
      borderStyle: "dashed",
    };
  }
  if (showAs === "tentative") {
    return {
      backgroundImage: `repeating-linear-gradient(135deg, ${color}26 0 6px, ${color}10 6px 12px)`,
      borderColor: color,
      borderStyle: "dashed",
    };
  }
  return { backgroundColor: `${color}33`, borderColor: color };
}

function dayHeading(key: string) {
  const date = new Date(`${key}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      timeZone: "UTC",
    }).format(date),
    day: date.getUTCDate(),
  };
}

function hourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

const SLOT_LABEL_PX = 30;
const MINUTE_MS = 60_000;

function DropSlot({ slot, mode, perMinute, last }: { slot: GridSlot; mode: TaskDrag["mode"]; perMinute: number; last: boolean }) {
  const top = slot.minutes * perMinute + 1;
  const height = slot.durationMinutes * perMinute - 2;
  const below = top + height + 4;
  const labelTop = mode === "resize" ? below : top - SLOT_LABEL_PX >= 0 ? top - SLOT_LABEL_PX : below;
  return (
    <>
      {mode === "move" && (
        <div
          aria-hidden
          data-drop-slot=""
          className="border-violet pointer-events-none absolute right-[3px] left-0.5 z-[4] rounded-md border-[1.5px] bg-[color-mix(in_srgb,var(--violet)_12%,transparent)]"
          style={{ top, height }}
        />
      )}
      <span
        data-drop-label=""
        className={cn(
          "bg-popover border-line-strong shadow-overlay pointer-events-none absolute z-[25] inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium whitespace-nowrap tabular-nums",
          last ? "right-1" : "left-1",
        )}
        style={{ top: labelTop }}
      >
        {mode === "resize" ? (
          <>
            {durationLabel(slot.durationMinutes)}
            <span className="text-subtle font-normal">· {slotRange(slot)}</span>
          </>
        ) : (
          <>
            <span>
              {slotDayLabel(slot.day)} {slotRange(slot)}
            </span>
            <span className="text-subtle font-normal">· {durationLabel(slot.durationMinutes)}</span>
          </>
        )}
      </span>
    </>
  );
}

function EdgeScroll({ direction }: { direction: -1 | 1 }) {
  return (
    <div aria-hidden className={cn("pointer-events-none sticky z-[15] h-0", direction > 0 ? "bottom-0" : "top-0")} data-drag-edge={direction > 0 ? "bottom" : "top"}>
      <div
        className={cn(
          "absolute inset-x-0 flex h-11 items-center justify-center gap-1.5 text-[#cfc8ff]",
          direction > 0
            ? "bottom-0 bg-linear-to-t from-[color-mix(in_srgb,var(--violet)_26%,transparent)] to-transparent"
            : "top-0 bg-linear-to-b from-[color-mix(in_srgb,var(--violet)_26%,transparent)] to-transparent",
        )}
      >
        <ChevronDownIcon className={cn("size-3", direction < 0 && "rotate-180")} />
        <ChevronDownIcon className={cn("size-3", direction < 0 && "rotate-180")} />
      </div>
    </div>
  );
}

function resizedBlock(block: TaskBlock, drag: TaskDrag | null) {
  if (drag?.mode !== "resize" || drag.task.id !== block.task.id || !drag.slot) return block;
  const endsAt = new Date(new Date(block.startsAt).getTime() + drag.slot.durationMinutes * MINUTE_MS).toISOString();
  return { ...block, durationMinutes: drag.slot.durationMinutes, endsAt };
}

function EventBlock({
  item,
  calendar,
  others,
  style,
  compact,
  allDay,
  onOpenChange,
}: {
  item: CalendarItem;
  calendar: CalendarMeta | null;
  others: CalendarMeta[];
  style: CSSProperties;
  compact: boolean;
  allDay?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const color = calendar?.color ?? "#9aa1ab";
  const muted = item.showAs === "free" || item.showAs === "tentative";
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !onOpenChange) return;
    onOpenChange(true);
    return () => onOpenChange(false);
  }, [open, onOpenChange]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-list-row=""
          aria-label={`${eventTitle(item)}, ${formatTimeRange(item)}${calendar ? `, ${calendar.name}` : ""}`}
          className={cn(
            "focus-visible:ring-ring/60 flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-md border-l-[3px] px-1.5 text-left outline-none focus-visible:ring-2",
            allDay ? "h-6 justify-center" : "absolute",
            !allDay && (compact ? "py-0.5" : "py-1"),
            muted ? "text-soft" : "text-foreground",
          )}
          style={{
            ...eventStyle(color, item.showAs),
            ...(others.length > 0
              ? {
                  boxShadow: others
                    .map(
                      (other, index) =>
                        `inset -${(index + 1) * 3}px 0 0 ${other.color}`,
                    )
                    .join(", "),
                }
              : {}),
            ...style,
          }}
        >
          <span className="truncate text-[13px] leading-[18px] font-medium">
            {eventTitle(item)}
            {compact && !allDay && (
              <span className="text-soft font-normal">
                {" "}
                {formatTime(item.startsAt)}
              </span>
            )}
          </span>
          {!allDay && !compact && (
            <span className="text-soft truncate text-[12px] leading-4">
              {formatTimeRange(item)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        className="max-h-[min(70dvh,560px)] w-[360px] overflow-y-auto p-4"
      >
        <CalendarEventDetails item={item} calendar={calendar} others={others} />
      </PopoverContent>
    </Popover>
  );
}

export default function CalendarGrid({
  days,
  today,
  items,
  calendars,
  now,
  onSlot,
  blocks = [],
  taskHandlers,
  drag = null,
  blockDrag,
  proposals = [],
  proposalDrag,
  runs = [],
}: {
  days: string[];
  today: string;
  items: CalendarItem[];
  calendars: Map<string, CalendarMeta>;
  now: number;
  onSlot?: (day: string, time: string) => void;
  blocks?: TaskBlock[];
  taskHandlers?: TaskBlockHandlers;
  drag?: TaskDrag | null;
  blockDrag?: TaskBlockDrag;
  proposals?: TaskBlock[];
  proposalDrag?: TaskBlockDrag;
  runs?: PreviewRun[];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const openPopovers = useRef(0);
  const dismissing = useRef(false);
  const trackPopover = useCallback((open: boolean) => {
    openPopovers.current = Math.max(0, openPopovers.current + (open ? 1 : -1));
  }, []);
  const [current, setCurrent] = useState(now);
  const [hourHeight, setHourHeight] = useState(MIN_HOUR_HEIGHT);
  const perMinute = hourHeight / 60;
  useEffect(() => {
    const timer = window.setInterval(() => setCurrent(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const fitted = Math.floor(element.clientHeight / FOCUS_HOURS);
      const next = Math.min(MAX_HOUR_HEIGHT, Math.max(MIN_HOUR_HEIGHT, fitted));
      setHourHeight(next);
      if (!scrolled.current && element.clientHeight > 0) {
        scrolled.current = true;
        requestAnimationFrame(() => {
          element.scrollTop = FOCUS_START_HOUR * next - 8;
        });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const allDay = new Map<string, CalendarItem[]>();
  const timed = new Map<
    string,
    { item: CalendarItem; top: number; bottom: number }[]
  >();
  const tasked = new Map<string, { block: TaskBlock; top: number; bottom: number }[]>();
  for (const key of days) {
    allDay.set(key, []);
    timed.set(key, []);
    tasked.set(key, []);
  }
  for (const shownBlock of taskHandlers ? [...blocks, ...proposals] : []) {
    const block = resizedBlock(shownBlock, drag);
    for (const key of days) {
      const span = daySpan(block.startsAt, block.endsAt, key);
      if (span) tasked.get(key)!.push({ block, ...span });
    }
  }
  for (const item of items) {
    if (item.isAllDay) {
      for (const key of allDayKeys(item.startsAt, item.endsAt))
        allDay.get(key)?.push(item);
      continue;
    }
    for (const key of days) {
      const span = daySpan(item.startsAt, item.endsAt, key);
      if (span) timed.get(key)!.push({ item, ...span });
    }
  }
  const hasAllDay = days.some((key) => (allDay.get(key)?.length ?? 0) > 0);
  const nowMinutes = wallMinutes(current);
  const columns = {
    gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))`,
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="border-border grid shrink-0 overflow-y-hidden border-b [scrollbar-gutter:stable]"
        style={columns}
      >
        <div aria-hidden />
        {days.map((key) => {
          const heading = dayHeading(key);
          const isToday = key === today;
          return (
            <div
              key={key}
              className="border-border flex items-center gap-1.5 border-l px-2 py-2.5"
            >
              <span className="caption-style text-subtle">
                {heading.weekday}
              </span>
              <span
                className={cn(
                  "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[14px] leading-none",
                  isToday
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground",
                )}
              >
                {heading.day}
              </span>
            </div>
          );
        })}
        {hasAllDay && (
          <>
            <div className="caption-style text-subtle border-border flex items-start justify-end border-t px-2 py-1.5">
              All day
            </div>
            {days.map((key) => (
              <div
                key={key}
                className="border-border flex min-w-0 flex-col gap-1 border-t border-l p-1"
              >
                {(allDay.get(key) ?? []).map((item) => (
                  <EventBlock
                    key={item.id}
                    item={item}
                    calendar={calendars.get(item.calendarId) ?? null}
                    others={item.alsoIn.flatMap(
                      (id) => calendars.get(id) ?? [],
                    )}
                    style={{}}
                    compact
                    allDay
                    onOpenChange={trackPopover}
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto pb-20 outline-none [scrollbar-gutter:stable]"
        tabIndex={-1}
        data-calendar-scroller=""
      >
        {drag?.scrolling === -1 && <EdgeScroll direction={-1} />}
        <div
          className="relative grid"
          style={{ ...columns, height: DAY_MINUTES * perMinute }}
        >
          <div className="relative">
            {HOURS.map((hour) =>
              hour === 0 ? null : (
                <span
                  key={hour}
                  className="caption-style text-subtle absolute right-2 -translate-y-1/2 tabular-nums"
                  style={{ top: hour * hourHeight }}
                >
                  {hourLabel(hour)}
                </span>
              ),
            )}
          </div>
          {days.map((key) => {
            const entries = timed.get(key) ?? [];
            const taskEntries = tasked.get(key) ?? [];
            const slots = packColumns(
              [
                ...entries.map((entry) => ({
                  id: entry.item.id,
                  top: entry.top,
                  bottom: Math.max(entry.bottom, entry.top + MIN_MINUTES),
                })),
                ...taskEntries.map((entry) => ({
                  id: entry.block.id,
                  top: entry.top,
                  bottom: Math.max(entry.bottom, entry.top + MIN_TASK_MINUTES),
                })),
              ],
              0,
            );
            return (
              <div
                key={key}
                className={cn(
                  "border-border relative border-l",
                  onSlot && "cursor-copy",
                )}
                data-day={key}
                onPointerDownCapture={() => {
                  dismissing.current = openPopovers.current > 0;
                }}
                onClick={
                  onSlot
                    ? (event) => {
                        if (
                          dismissing.current ||
                          (event.target as HTMLElement).closest(
                            "button, a, [data-task-block]",
                          )
                        )
                          return;
                        const box = event.currentTarget.getBoundingClientRect();
                        onSlot(
                          key,
                          snapTime((event.clientY - box.top) / perMinute),
                        );
                      }
                    : undefined
                }
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    aria-hidden
                    className="absolute inset-x-0"
                    style={{ top: hour * hourHeight }}
                  >
                    <div
                      className={cn(
                        "border-border border-t",
                        hour === 0 && "border-transparent",
                      )}
                    />
                    <div
                      className="border-border/60 border-t border-dashed"
                      style={{ marginTop: hourHeight / 2 - 1 }}
                    />
                  </div>
                ))}
                {entries.map((entry) => {
                  const slot = slots.get(entry.item.id) ?? {
                    column: 0,
                    columns: 1,
                  };
                  const minutes = Math.max(
                    entry.bottom - entry.top,
                    MIN_MINUTES,
                  );
                  const height = minutes * perMinute - 2;
                  return (
                    <EventBlock
                      key={entry.item.id}
                      item={entry.item}
                      calendar={calendars.get(entry.item.calendarId) ?? null}
                      others={entry.item.alsoIn.flatMap(
                        (id) => calendars.get(id) ?? [],
                      )}
                      compact={height < COMPACT_BELOW_PX}
                      onOpenChange={trackPopover}
                      style={{
                        top: entry.top * perMinute + 1,
                        height,
                        left: `calc(${(slot.column / slot.columns) * 100}% + 2px)`,
                        width: `calc(${100 / slot.columns}% - 4px)`,
                      }}
                    />
                  );
                })}
                {runs
                  .filter((run) => run.day === key)
                  .map((run) => {
                    const top = wallMinutes(run.startsAt) * perMinute - 3;
                    const height = ((new Date(run.endsAt).getTime() - new Date(run.startsAt).getTime()) / MINUTE_MS) * perMinute + 4;
                    return (
                      <div
                        key={run.id}
                        aria-hidden
                        data-plan-run=""
                        className="pointer-events-none absolute inset-x-0.5 rounded-lg border border-dashed border-[color-mix(in_srgb,var(--violet)_45%,transparent)] bg-[color-mix(in_srgb,var(--violet)_4%,transparent)]"
                        style={{ top, height }}
                      >
                        <span className="absolute -top-2 right-1.5 z-[2] h-4 rounded-full bg-[color-mix(in_srgb,var(--violet)_28%,var(--background))] px-1.5 text-[10.5px] leading-4 font-medium whitespace-nowrap text-foreground tabular-nums">
                          {runLabel(run)}
                        </span>
                      </div>
                    );
                  })}
                {taskHandlers &&
                  taskEntries.map((entry) => {
                    const slot = slots.get(entry.block.id) ?? {
                      column: 0,
                      columns: 1,
                    };
                    const height =
                      Math.max(entry.bottom - entry.top, MIN_TASK_MINUTES) *
                        perMinute -
                      2;
                    return (
                      <GridTaskBlock
                        key={entry.block.id}
                        block={entry.block}
                        height={height}
                        onOpen={taskHandlers.onOpen}
                        onComplete={taskHandlers.onComplete}
                        drag={entry.block.proposed ? proposalDrag : blockDrag}
                        lifted={drag?.mode === "move" && drag.task.id === entry.block.task.id}
                        resizing={drag?.mode === "resize" && drag.task.id === entry.block.task.id}
                        resizable={dateKey(new Date(entry.block.endsAt).getTime() - 1) === key}
                        style={{
                          top: entry.top * perMinute + 1,
                          height,
                          left: `calc(${(slot.column / slot.columns) * 100}% + 2px)`,
                          width: `calc(${100 / slot.columns}% - 4px)`,
                        }}
                      />
                    );
                  })}
                {drag?.slot?.day === key && (
                  <DropSlot slot={drag.slot} mode={drag.mode} perMinute={perMinute} last={days.length > 1 && key === days[days.length - 1]} />
                )}
                {key === today && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                    style={{ top: nowMinutes * perMinute }}
                    data-now-line=""
                  >
                    <span className="bg-danger -ml-1 size-2 rounded-full" />
                    <span className="bg-danger h-px flex-1" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {drag?.scrolling === 1 && <EdgeScroll direction={1} />}
      </div>
    </div>
  );
}
