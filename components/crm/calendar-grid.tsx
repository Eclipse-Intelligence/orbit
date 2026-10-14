"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import CalendarEventDetails, {
  eventTitle,
  formatTime,
  formatTimeRange,
  type CalendarMeta,
} from "@/components/crm/calendar-event-details";
import { allDayKeys, DAY_MINUTES, daySpan, packColumns, wallMinutes } from "@/lib/calendar-view";
import type { CalendarItem } from "@/lib/crm/calendars";
import { cn } from "@/lib/utils";

const HOUR_HEIGHT = 48;
const PIXELS_PER_MINUTE = HOUR_HEIGHT / 60;
const MIN_MINUTES = 20;
const SCROLL_TO_HOUR = 7;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function eventStyle(color: string, showAs: string | null): CSSProperties {
  if (showAs === "free") {
    return { backgroundColor: `${color}14`, borderColor: `${color}80`, borderStyle: "dashed" };
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
    weekday: new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(date),
    day: date.getUTCDate(),
  };
}

function hourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function EventBlock({
  item,
  calendar,
  style,
  compact,
  allDay,
}: {
  item: CalendarItem;
  calendar: CalendarMeta | null;
  style: CSSProperties;
  compact: boolean;
  allDay?: boolean;
}) {
  const color = calendar?.color ?? "#9aa1ab";
  const muted = item.showAs === "free" || item.showAs === "tentative";
  return (
    <Popover>
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
          style={{ ...eventStyle(color, item.showAs), ...style }}
        >
          <span className="truncate text-[12px] leading-4 font-medium">
            {eventTitle(item)}
            {compact && !allDay && <span className="text-soft font-normal"> {formatTime(item.startsAt)}</span>}
          </span>
          {!allDay && !compact && (
            <span className="caption-style text-soft truncate leading-4">{formatTimeRange(item)}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="max-h-[min(70dvh,560px)] w-[360px] overflow-y-auto p-4">
        <CalendarEventDetails item={item} calendar={calendar} />
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
}: {
  days: string[];
  today: string;
  items: CalendarItem[];
  calendars: Map<string, CalendarMeta>;
  now: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(now);
  useEffect(() => {
    const timer = window.setInterval(() => setCurrent(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = SCROLL_TO_HOUR * HOUR_HEIGHT - HOUR_HEIGHT / 3;
  }, []);

  const allDay = new Map<string, CalendarItem[]>();
  const timed = new Map<string, { item: CalendarItem; top: number; bottom: number }[]>();
  for (const key of days) {
    allDay.set(key, []);
    timed.set(key, []);
  }
  for (const item of items) {
    if (item.isAllDay) {
      for (const key of allDayKeys(item.startsAt, item.endsAt)) allDay.get(key)?.push(item);
      continue;
    }
    for (const key of days) {
      const span = daySpan(item.startsAt, item.endsAt, key);
      if (span) timed.get(key)!.push({ item, ...span });
    }
  }
  const hasAllDay = days.some((key) => (allDay.get(key)?.length ?? 0) > 0);
  const nowMinutes = wallMinutes(current);
  const columns = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border grid shrink-0 overflow-y-hidden border-b [scrollbar-gutter:stable]" style={columns}>
        <div aria-hidden />
        {days.map((key) => {
          const heading = dayHeading(key);
          const isToday = key === today;
          return (
            <div key={key} className="border-border flex items-center gap-1.5 border-l px-2 py-2.5">
              <span className="caption-style text-subtle">{heading.weekday}</span>
              <span
                className={cn(
                  "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[14px] leading-none",
                  isToday ? "bg-primary text-primary-foreground" : "text-foreground",
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
              <div key={key} className="border-border flex min-w-0 flex-col gap-1 border-t border-l p-1">
                {(allDay.get(key) ?? []).map((item) => (
                  <EventBlock
                    key={item.id}
                    item={item}
                    calendar={calendars.get(item.calendarId) ?? null}
                    style={{}}
                    compact
                    allDay
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" data-calendar-scroller="">
        <div className="relative grid" style={{ ...columns, height: DAY_MINUTES * PIXELS_PER_MINUTE }}>
          <div className="relative">
            {HOURS.map((hour) =>
              hour === 0 ? null : (
                <span
                  key={hour}
                  className="caption-style text-subtle absolute right-2 -translate-y-1/2 tabular-nums"
                  style={{ top: hour * HOUR_HEIGHT }}
                >
                  {hourLabel(hour)}
                </span>
              ),
            )}
          </div>
          {days.map((key) => {
            const entries = timed.get(key) ?? [];
            const slots = packColumns(
              entries.map((entry) => ({ id: entry.item.id, top: entry.top, bottom: entry.bottom })),
              MIN_MINUTES,
            );
            return (
              <div key={key} className="border-border relative border-l" data-day={key}>
                {HOURS.map((hour) => (
                  <div key={hour} aria-hidden className="absolute inset-x-0" style={{ top: hour * HOUR_HEIGHT }}>
                    <div className={cn("border-border border-t", hour === 0 && "border-transparent")} />
                    <div className="border-border/60 border-t border-dashed" style={{ marginTop: HOUR_HEIGHT / 2 - 1 }} />
                  </div>
                ))}
                {entries.map((entry) => {
                  const slot = slots.get(entry.item.id) ?? { column: 0, columns: 1 };
                  const minutes = Math.max(entry.bottom - entry.top, MIN_MINUTES);
                  return (
                    <EventBlock
                      key={entry.item.id}
                      item={entry.item}
                      calendar={calendars.get(entry.item.calendarId) ?? null}
                      compact={minutes < 50}
                      style={{
                        top: entry.top * PIXELS_PER_MINUTE + 1,
                        height: minutes * PIXELS_PER_MINUTE - 2,
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
                    style={{ top: nowMinutes * PIXELS_PER_MINUTE }}
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
