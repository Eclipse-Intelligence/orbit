"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/_ui/sheet";
import CalendarEventDetails, {
  eventTitle,
  formatTimeRange,
  showAsLabel,
  type CalendarMeta,
} from "@/components/crm/calendar-event-details";
import { eventStyle } from "@/components/crm/calendar-grid";
import { AgendaTaskBlock, type TaskBlockHandlers } from "@/components/crm/calendar-task-block";
import { AgendaReminderChip, AgendaReminderMarker, type ReminderHandlers } from "@/components/reminders/calendar-reminders";
import { allDayKeys, daySpan } from "@/lib/calendar-view";
import type { CalendarItem } from "@/lib/crm/calendars";
import { dayChips, dayMarkers, type ReminderChip, type ReminderMarker } from "@/lib/reminder-calendar";
import { upcomingDayBlocks, type TaskBlock } from "@/lib/task-blocks";
import { cn } from "@/lib/utils";

export default function CalendarAgenda({
  date,
  today,
  items,
  calendars,
  now,
  onNew,
  blocks = [],
  chips = [],
  taskHandlers,
  reminderChips = [],
  markers = [],
  reminderHandlers,
}: {
  date: string;
  today: string;
  items: CalendarItem[];
  calendars: Map<string, CalendarMeta>;
  now: number;
  onNew?: () => void;
  blocks?: TaskBlock[];
  chips?: TaskBlock[];
  taskHandlers?: TaskBlockHandlers;
  reminderChips?: ReminderChip[];
  markers?: ReminderMarker[];
  reminderHandlers?: ReminderHandlers;
}) {
  const [open, setOpen] = useState<CalendarItem | null>(null);
  const allDay = items.filter(
    (item) =>
      item.isAllDay && allDayKeys(item.startsAt, item.endsAt).includes(date),
  );
  const timed = items
    .filter(
      (item) => !item.isAllDay && daySpan(item.startsAt, item.endsAt, date),
    )
    .sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) ||
        right.endsAt.localeCompare(left.endsAt),
    );
  const dayBlocks = taskHandlers ? blocks.filter((block) => daySpan(block.startsAt, block.endsAt, date)) : [];
  type Row =
    | { kind: "event"; item: CalendarItem }
    | { kind: "task"; block: TaskBlock }
    | { kind: "chip"; chip: ReminderChip }
    | { kind: "marker"; marker: ReminderMarker };
  const list: Row[] = [
    ...(reminderHandlers ? dayChips(reminderChips, date) : []).map((chip) => ({ kind: "chip" as const, chip })),
    ...(taskHandlers ? upcomingDayBlocks(chips, date) : []).map((block) => ({ kind: "task" as const, block })),
    ...allDay.map((item) => ({ kind: "event" as const, item })),
    ...[
      ...timed.map((item) => ({ kind: "event" as const, item, at: item.startsAt, until: item.endsAt })),
      ...dayBlocks.map((block) => ({ kind: "task" as const, block, at: block.startsAt, until: block.endsAt })),
      ...(reminderHandlers ? dayMarkers(markers, date) : []).map((marker) => ({ kind: "marker" as const, marker, at: marker.reminder.dueAt!, until: marker.reminder.dueAt! })),
    ].sort((left, right) => left.at.localeCompare(right.at) || (left.kind === right.kind ? right.until.localeCompare(left.until) : left.kind === "marker" ? -1 : right.kind === "marker" ? 1 : left.kind === "task" ? -1 : 1)),
  ];
  const openCalendar = open ? (calendars.get(open.calendarId) ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 pb-20">
      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <p className="caption-style text-subtle text-center">
            No events
          </p>
          {onNew && date >= today && (
            <Button variant="secondary" size="sm" onClick={onNew}>
              New event
            </Button>
          )}
        </div>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Events">
          {list.map((row) => {
            if (row.kind === "chip") {
              return (
                <li key={`reminder:${row.chip.id}`}>
                  <AgendaReminderChip chip={row.chip} onTick={reminderHandlers!.onTick} onOpen={reminderHandlers!.onOpen} />
                </li>
              );
            }
            if (row.kind === "marker") {
              return (
                <li key={`marker:${row.marker.id}`}>
                  <AgendaReminderMarker marker={row.marker} onOpen={reminderHandlers!.onOpen} />
                </li>
              );
            }
            if (row.kind === "task") {
              return (
                <li key={row.block.id}>
                  <AgendaTaskBlock
                    block={row.block}
                    past={date < today || (row.block.task.dueHasTime && new Date(row.block.endsAt).getTime() <= now)}
                    onOpen={taskHandlers!.onOpen}
                    onComplete={taskHandlers!.onComplete}
                  />
                </li>
              );
            }
            const item = row.item;
            const calendar = calendars.get(item.calendarId) ?? null;
            const color = calendar?.color ?? "#9aa1ab";
            const past =
              date < today ||
              (date === today &&
                !item.isAllDay &&
                new Date(item.endsAt).getTime() <= now);
            const status = showAsLabel(item.showAs);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-list-row=""
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
                    <span className="truncate text-[14px] leading-5">
                      {eventTitle(item)}
                    </span>
                    <span className="caption-style text-subtle truncate">
                      {[calendar?.name, item.location, status]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <Sheet
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
      >
        <SheetContent side="bottom" className="overflow-y-auto px-5 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom))]">
          <SheetCloseButton className="absolute top-3 right-4" />
          <SheetTitle className="sr-only">
            {open ? eventTitle(open) : "Event"}
          </SheetTitle>
          <SheetDescription className="sr-only">Event details</SheetDescription>
          {open && (
            <CalendarEventDetails
              item={open}
              calendar={openCalendar}
              others={open.alsoIn.flatMap((id) => calendars.get(id) ?? [])}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
