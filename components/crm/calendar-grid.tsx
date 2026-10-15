"use client";

import {
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
  DAY_MINUTES,
  daySpan,
  packColumns,
  wallMinutes,
} from "@/lib/calendar-view";
import { snapTime } from "@/lib/invite-rules";
import type { CalendarItem } from "@/lib/crm/calendars";
import { cn } from "@/lib/utils";

const MIN_HOUR_HEIGHT = 64;
const MAX_HOUR_HEIGHT = 120;
const FOCUS_START_HOUR = 8;
const FOCUS_HOURS = 12;
const MIN_MINUTES = 20;
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
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
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
}: {
  days: string[];
  today: string;
  items: CalendarItem[];
  calendars: Map<string, CalendarMeta>;
  now: number;
  onSlot?: (day: string, time: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const openPopovers = useRef(0);
  const dismissing = useRef(false);
  const trackPopover = (open: boolean) => {
    openPopovers.current = Math.max(0, openPopovers.current + (open ? 1 : -1));
  };
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
  for (const key of days) {
    allDay.set(key, []);
    timed.set(key, []);
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
        className="min-h-0 flex-1 overflow-y-auto pb-20 [scrollbar-gutter:stable]"
        data-calendar-scroller=""
      >
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
            const slots = packColumns(
              entries.map((entry) => ({
                id: entry.item.id,
                top: entry.top,
                bottom: entry.bottom,
              })),
              MIN_MINUTES,
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
                          (event.target as HTMLElement).closest("button, a")
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
      </div>
    </div>
  );
}
