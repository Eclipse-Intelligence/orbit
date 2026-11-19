"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listDayRemindersAction } from "@/app/(crm)/reminders";
import { ReminderTick } from "@/components/reminders/reminder-row";
import { ReminderUndoToast, useReminderTicks } from "@/components/reminders/use-reminder-ticks";
import type { Reminder } from "@/lib/crm/reminders";
import { dayReminderRows, type DayReminderRow } from "@/lib/reminder-calendar";
import { dayLabel, remindersToday, repeatWords } from "@/lib/reminders-card";
import { useCompaniesStore } from "@/stores/companies-store";
import { cn } from "@/lib/utils";

function RowMeta({ row, today }: { row: DayReminderRow; today: string }) {
  const { reminder } = row;
  const repeats = row.done ? null : repeatWords(reminder);
  const pieces: { key: string; text: string; late: boolean }[] = [];
  if (row.overdue && !row.done && reminder.dueOn) pieces.push({ key: "day", text: dayLabel(reminder.dueOn, today), late: true });
  if (reminder.time) pieces.push({ key: "time", text: reminder.time, late: false });
  if (repeats) pieces.push({ key: "repeat", text: repeats, late: false });
  if (pieces.length === 0) return null;
  return (
    <span className="caption-style text-subtle flex flex-wrap items-center gap-x-1.5">
      {pieces.map((piece) => (
        <span key={piece.key} className={cn("tabular-nums", piece.late && "text-danger")}>
          {piece.text}
        </span>
      ))}
    </span>
  );
}

export default function DayReminders({ day, wrap }: { day: string; wrap: (count: number | undefined, children: ReactNode) => ReactNode }) {
  const [today] = useState(() => remindersToday());
  const [loaded, setLoaded] = useState<{ day: string; reminders: Reminder[] } | null>(null);
  const openReminder = useCompaniesStore((state) => state.openReminder);
  const stamp = useCompaniesStore((state) => state.remindersStamp);
  const loads = useRef(0);

  const load = useCallback(async () => {
    const id = (loads.current += 1);
    const result = await listDayRemindersAction(day).catch(() => null);
    if (id !== loads.current || !result || "error" in result) return;
    setLoaded({ day, reminders: result.reminders });
  }, [day]);

  const ticks = useReminderTicks({ by: "daily", onChanged: () => void load() });
  const { settle } = ticks;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (stamp.count > 0 && stamp.by !== "daily") void load();
  }, [stamp, load]);

  const reminders = loaded?.day === day ? loaded.reminders : null;

  useEffect(() => {
    if (reminders) settle(reminders);
  }, [reminders, settle]);

  if (!reminders) return null;
  const rows = dayReminderRows(reminders, ticks.held, day, today);
  if (rows.length === 0) return null;
  const open = rows.filter((row) => !row.done).length;

  function toggle(row: DayReminderRow) {
    if (row.held) {
      void ticks.undo(row.reminder.id);
      return;
    }
    if (row.done) {
      void ticks.reopen(row.reminder.id);
      return;
    }
    ticks.tick(row.reminder);
  }

  return wrap(
    open > 0 ? open : undefined,
    <>
      {ticks.error && (
        <p role="alert" className="caption-style text-danger">
          {ticks.error}
        </p>
      )}
      <ul className="-mx-2 flex flex-col" data-day-reminders={day}>
        {rows.map((row) => (
          <li key={row.key} data-reminder-row={row.reminder.title} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.04] [@media(pointer:coarse)]:py-3.5">
            <ReminderTick reminder={row.reminder} done={row.done} large={false} onToggle={() => toggle(row)} />
            <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
              {!row.done && (
                <button
                  type="button"
                  aria-label={`Open “${row.reminder.title}”`}
                  onClick={() => openReminder(row.reminder.id)}
                  className="focus-visible:ring-ring/60 absolute -inset-y-1 -right-2 left-1 cursor-pointer rounded-md outline-none focus-visible:ring-2"
                />
              )}
              <span className={cn("pointer-events-none relative text-[13px] leading-4 break-words", row.done ? "text-subtle line-through decoration-white/25" : "text-foreground")}>{row.reminder.title}</span>
              <span className="pointer-events-none relative">
                <RowMeta row={row} today={today} />
              </span>
            </div>
          </li>
        ))}
      </ul>
      <ReminderUndoToast toast={ticks.toast} onUndo={(id) => void ticks.undo(id)} />
    </>,
  );
}
