"use client";

import { formatTime } from "@/components/crm/calendar-event-details";
import type { Reminder } from "@/lib/crm/reminders";
import type { ReminderChip, ReminderMarker } from "@/lib/reminder-calendar";
import { cn } from "@/lib/utils";

export type ReminderHandlers = {
  onTick: (reminder: Reminder) => void;
  onOpen: (reminder: Reminder) => void;
};

function chipLabel(chip: ReminderChip) {
  return [chip.reminder.title, "reminder", chip.reminder.time, chip.overdue ? "overdue" : null].filter(Boolean).join(", ");
}

function RoundTick({ reminder, large, onTick }: { reminder: Reminder; large?: boolean; onTick: ReminderHandlers["onTick"] }) {
  return (
    <button
      type="button"
      data-reminder-tick=""
      aria-label={`Mark “${reminder.title}” done`}
      title="Done"
      onClick={() => onTick(reminder)}
      className={cn(
        "group/tick focus-visible:ring-ring/60 flex shrink-0 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2",
        large ? "hit size-[22px]" : "size-5 [@media(pointer:coarse)]:size-8",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "ease-power2-out rounded-full shadow-[inset_0_0_0_1.25px_#777] transition-[background-color,box-shadow] duration-150 group-hover/tick:bg-primary group-hover/tick:shadow-none",
          large ? "size-4" : "size-[11px]",
        )}
      />
    </button>
  );
}

export function ReminderChipView({ chip, onTick, onOpen }: ReminderHandlers & { chip: ReminderChip }) {
  const { reminder } = chip;
  return (
    <div data-reminder-chip={reminder.id} className="bg-surface-raised @container flex h-5 w-full min-w-0 items-center rounded-md pr-1.5 text-[12px] leading-5 [@media(pointer:coarse)]:h-8">
      <RoundTick reminder={reminder} onTick={onTick} />
      <button
        type="button"
        data-list-row=""
        aria-label={chipLabel(chip)}
        title={chipLabel(chip)}
        onClick={() => onOpen(reminder)}
        className="focus-visible:ring-ring/60 flex min-w-0 flex-1 cursor-pointer items-center gap-1 self-stretch rounded-md text-left outline-none focus-visible:ring-2"
      >
        <span className="text-foreground min-w-0 truncate">{reminder.title}</span>
        {chip.overdue && <span className="text-danger shrink-0 text-[11px] @max-[7rem]:hidden">· overdue</span>}
      </button>
    </div>
  );
}

export function ReminderMarkerView({ marker, top, onOpen }: { marker: ReminderMarker; top: number; onOpen: ReminderHandlers["onOpen"] }) {
  const { reminder } = marker;
  return (
    <div data-reminder-marker={reminder.id} className="pointer-events-none absolute inset-x-0 z-[8] flex -translate-y-1/2 items-center" style={{ top }}>
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-[color-mix(in_srgb,var(--warning)_45%,transparent)]" />
      <button
        type="button"
        data-list-row=""
        aria-label={`${reminder.title}, ${reminder.time ?? formatTime(reminder.dueAt!)}, reminder`}
        title={`${reminder.title}, ${reminder.time ?? ""}`}
        onClick={() => onOpen(reminder)}
        className="focus-visible:ring-ring/60 pointer-events-auto relative flex max-w-[calc(100%-6px)] min-w-0 cursor-pointer items-center gap-1 outline-none focus-visible:ring-2"
      >
        <span aria-hidden className="bg-warning -ml-[3px] size-[7px] shrink-0 rounded-full" />
        <span className="min-w-0 truncate rounded-[5px] bg-[color-mix(in_srgb,var(--warning)_14%,#1b1b1b)] px-1.5 text-[11px] leading-4 text-[color-mix(in_srgb,var(--warning)_80%,white)]">
          {reminder.title}
        </span>
      </button>
    </div>
  );
}

export function AgendaReminderChip({ chip, onTick, onOpen }: ReminderHandlers & { chip: ReminderChip }) {
  const { reminder } = chip;
  return (
    <div data-reminder-chip={reminder.id} className="bg-surface-raised flex w-full items-center gap-2.5 rounded-xl py-2.5 pr-3 pl-[15px]">
      <button
        type="button"
        data-list-row=""
        aria-label={chipLabel(chip)}
        onClick={() => onOpen(reminder)}
        className="focus-visible:ring-ring/60 flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2"
      >
        <span className="caption-style text-soft w-[76px] shrink-0 tabular-nums">{chip.overdue && reminder.time ? reminder.time : "All day"}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[14px] leading-5">{reminder.title}</span>
          <span className={cn("caption-style truncate", chip.overdue ? "text-danger" : "text-subtle")}>{chip.overdue ? "Reminder · Overdue" : "Reminder"}</span>
        </span>
      </button>
      <RoundTick reminder={reminder} large onTick={onTick} />
    </div>
  );
}

export function AgendaReminderMarker({ marker, onOpen }: { marker: ReminderMarker; onOpen: ReminderHandlers["onOpen"] }) {
  const { reminder } = marker;
  return (
    <button
      type="button"
      data-list-row=""
      data-reminder-marker={reminder.id}
      aria-label={`${reminder.title}, ${reminder.time}, reminder`}
      onClick={() => onOpen(reminder)}
      className="focus-visible:ring-ring/60 flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl py-1 pr-3 pl-[15px] text-left outline-none focus-visible:ring-2"
    >
      <span className="caption-style w-[76px] shrink-0 text-[color-mix(in_srgb,var(--warning)_80%,white)] tabular-nums">{reminder.time}</span>
      <span aria-hidden className="bg-warning -ml-1 size-[7px] shrink-0 rounded-full" />
      <span className="min-w-0 flex-1 truncate text-[14px] leading-5 text-[color-mix(in_srgb,var(--warning)_80%,white)]">{reminder.title}</span>
    </button>
  );
}
