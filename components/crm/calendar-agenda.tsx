"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/_ui/sheet";
import CalendarEventDetails, {
  eventTitle,
  formatTimeRange,
  showAsLabel,
  type CalendarMeta,
} from "@/components/crm/calendar-event-details";
import { eventStyle } from "@/components/crm/calendar-grid";
import { allDayKeys, daySpan } from "@/lib/calendar-view";
import type { CalendarItem } from "@/lib/crm/calendars";
import { cn } from "@/lib/utils";

export default function CalendarAgenda({
  date,
  today,
  items,
  calendars,
  now,
  onNew,
}: {
  date: string;
  today: string;
  items: CalendarItem[];
  calendars: Map<string, CalendarMeta>;
  now: number;
  onNew?: () => void;
}) {
  const [open, setOpen] = useState<CalendarItem | null>(null);
  const allDay = items.filter((item) => item.isAllDay && allDayKeys(item.startsAt, item.endsAt).includes(date));
  const timed = items
    .filter((item) => !item.isAllDay && daySpan(item.startsAt, item.endsAt, date))
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || right.endsAt.localeCompare(left.endsAt));
  const list = [...allDay, ...timed];
  const openCalendar = open ? (calendars.get(open.calendarId) ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <p className="caption-style text-subtle text-center">Nothing on this day.</p>
          {onNew && date >= today && (
            <Button variant="secondary" size="sm" onClick={onNew}>
              New event
            </Button>
          )}
        </div>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Events">
          {list.map((item) => {
            const calendar = calendars.get(item.calendarId) ?? null;
            const color = calendar?.color ?? "#9aa1ab";
            const past = date < today || (date === today && !item.isAllDay && new Date(item.endsAt).getTime() <= now);
            const status = showAsLabel(item.showAs);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setOpen(item)}
                  className={cn(
                    "focus-visible:ring-ring/60 flex w-full cursor-pointer items-stretch gap-3 rounded-xl border-l-[3px] p-3 text-left outline-none focus-visible:ring-2",
                    past && "opacity-60",
                  )}
                  style={eventStyle(color, item.showAs)}
                >
                  <span className="caption-style text-soft w-[88px] shrink-0 pt-0.5 tabular-nums">
                    {formatTimeRange(item)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[14px] leading-5">{eventTitle(item)}</span>
                    <span className="caption-style text-subtle truncate">
                      {[calendar?.name, item.location, status].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent side="bottom" className="overflow-y-auto px-5 pt-5 pb-8">
          <SheetTitle className="sr-only">{open ? eventTitle(open) : "Event"}</SheetTitle>
          <SheetDescription className="sr-only">Event details</SheetDescription>
          {open && <CalendarEventDetails item={open} calendar={openCalendar} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
