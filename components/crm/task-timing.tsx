"use client";

import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { scheduleChoicesAction } from "@/app/(crm)/task-schedule";
import { DURATION_CHOICES, durationLabel, isTaskDuration, MAX_TASK_DURATION, MIN_TASK_DURATION, scheduleChoices, type ScheduleChoice } from "@/lib/crm/task-time";
import { requestReminderPermission } from "@/lib/reminder-alerts";
import { dateTimeInputValue } from "@/lib/time";
import { cn } from "@/lib/utils";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import ClockIcon from "@/public/assets/images/tasks/clock.svg";
import EditIcon from "@/public/assets/images/workflows/edit.svg";

const PHONE_QUERY = "(max-width: 639px)";
export const SCHEDULE_EVENT = "orbit:task-schedule";

function subscribePhone(onChange: () => void) {
  const list = window.matchMedia(PHONE_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function usePhone() {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}

export function requestSchedule(taskId: string) {
  const event = new CustomEvent(SCHEDULE_EVENT, { detail: taskId, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const OPTION =
  "ui-style text-soft hover:text-foreground focus-visible:bg-white/5 focus-visible:text-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-white/5 [@media(pointer:coarse)]:min-h-11";

function DurationButtons({ value, onPick }: { value: number; onPick: (minutes: number) => void }) {
  return (
    <div role="group" aria-label="Duration" className="grid grid-cols-6 gap-1 max-sm:grid-cols-3">
      {DURATION_CHOICES.map((minutes) => (
        <button
          key={minutes}
          type="button"
          aria-pressed={minutes === value}
          onClick={() => onPick(minutes)}
          className={cn(
            "ui-style ease-power3-out h-8 cursor-pointer rounded-lg tabular-nums outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 [@media(pointer:coarse)]:h-11",
            minutes === value ? "bg-primary text-primary-foreground" : "text-soft hover:text-foreground bg-white/[0.06] hover:bg-white/10",
          )}
        >
          {durationLabel(minutes)}
        </button>
      ))}
    </div>
  );
}

function CustomDuration({ value, onSet }: { value: number; onSet: (minutes: number) => void }) {
  const id = useId();
  const [text, setText] = useState(DURATION_CHOICES.includes(value as (typeof DURATION_CHOICES)[number]) ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  function set() {
    const minutes = Number(text.trim());
    if (!isTaskDuration(minutes)) {
      setError(`Enter ${MIN_TASK_DURATION} to ${MAX_TASK_DURATION} minutes.`);
      return;
    }
    setError(null);
    onSet(minutes);
  }
  return (
    <div className="flex flex-col gap-1">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          set();
        }}
      >
        <Input
          id={id}
          inputMode="numeric"
          value={text}
          placeholder="90"
          aria-label="Custom duration in minutes"
          aria-invalid={error ? true : undefined}
          onChange={(event) => setText(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
          className="h-8 w-20 [@media(pointer:coarse)]:h-11"
        />
        <span className="caption-style text-subtle flex-1">minutes</span>
        <Button variant="secondary" size="sm" type="submit" className="[@media(pointer:coarse)]:h-11">
          Set
        </Button>
      </form>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function DurationMenu({ value, onChange, className }: { value: number; onChange: (minutes: number) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const pick = (minutes: number) => {
    setOpen(false);
    if (minutes !== value) onChange(minutes);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Duration ${durationLabel(value)}. Change`} className={cn("inline-flex cursor-pointer items-center", className)}>
          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="tabular-nums">{durationLabel(value)}</span>
          <ChevronDownIcon aria-hidden className="text-subtle size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-[min(16rem,calc(100vw-2rem))] flex-col gap-2 p-2">
        <span className="eyebrow-style text-subtle px-1 pt-1">Duration</span>
        <DurationButtons value={value} onPick={pick} />
        <div className="bg-line-strong -mx-2 h-px" />
        {open && <CustomDuration value={value} onSet={pick} />}
      </PopoverContent>
    </Popover>
  );
}

type ScheduleTask = { id: string; title: string; dueAt: string | null; dueHasTime: boolean; durationMinutes: number };

function useChoices(open: boolean, durationMinutes: number, now: number) {
  const [fetched, setFetched] = useState<{ duration: number; now: number; choices: ScheduleChoice[] } | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void scheduleChoicesAction(durationMinutes)
      .then((result) => {
        if (!cancelled && result.choices) setFetched({ duration: durationMinutes, now, choices: result.choices });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, durationMinutes, now]);
  if (fetched && fetched.duration === durationMinutes && fetched.now === now) return fetched.choices;
  return scheduleChoices({ durationMinutes, now });
}

function PickDateTime({ task, onSave, onCancel }: { task: ScheduleTask; onSave: (local: string) => void; onCancel: () => void }) {
  const id = useId();
  const start = task.dueAt ? dateTimeInputValue(task.dueAt) : "";
  const [date, setDate] = useState(start.slice(0, 10));
  const [time, setTime] = useState(task.dueHasTime ? start.slice(11, 16) : "09:00");
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time);
  return (
    <form
      className="flex flex-col gap-2.5 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSave(`${date}T${time}`);
      }}
    >
      <span className="ui-style font-medium">Pick a date and time</span>
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-date`} className="sr-only">
          Date
        </label>
        <Input id={`${id}-date`} type="date" value={date} onChange={(event) => setDate(event.target.value)} className="h-8 min-w-0 flex-1 [@media(pointer:coarse)]:h-11" />
        <label htmlFor={`${id}-time`} className="sr-only">
          Time
        </label>
        <Input id={`${id}-time`} type="time" step={300} value={time} onChange={(event) => setTime(event.target.value)} className="h-8 w-28 [@media(pointer:coarse)]:h-11" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" type="button" onClick={onCancel} className="[@media(pointer:coarse)]:h-11">
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={!ready} className="[@media(pointer:coarse)]:h-11">
          Save
        </Button>
      </div>
    </form>
  );
}

function ScheduleOptions({
  task,
  choices,
  onChoose,
  onPick,
  onRemoveTime,
}: {
  task: ScheduleTask;
  choices: ScheduleChoice[];
  onChoose: (at: string) => void;
  onPick: () => void;
  onRemoveTime: () => void;
}) {
  return (
    <>
      {choices.map((choice) => (
        <button key={choice.id} type="button" role="menuitem" onClick={() => onChoose(choice.at)} className={OPTION}>
          {choice.id === "next-free" ? <ClockIcon aria-hidden className="text-subtle size-3.5 shrink-0" /> : <CalendarIcon aria-hidden className="text-subtle size-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{choice.label}</span>
          <span className="caption-style text-subtle shrink-0 tabular-nums">{choice.detail}</span>
        </button>
      ))}
      <div role="separator" className="bg-line-strong mx-1 my-1 h-px" />
      <button type="button" role="menuitem" onClick={onPick} className={OPTION}>
        <EditIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Pick a date and time</span>
        <ChevronRightIcon aria-hidden className="text-subtle size-3 shrink-0" />
      </button>
      {task.dueHasTime && (
        <>
          <div role="separator" className="bg-line-strong mx-1 my-1 h-px" />
          <button type="button" role="menuitem" onClick={onRemoveTime} className={OPTION}>
            <XIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Remove the time</span>
            <span className="caption-style text-subtle shrink-0">Keeps the day</span>
          </button>
        </>
      )}
    </>
  );
}

export function ScheduleMenu({
  task,
  onSchedule,
  onRemoveTime,
  onDuration,
  className,
  children,
}: {
  task: ScheduleTask;
  onSchedule: (local: string) => void;
  onRemoveTime: () => void;
  onDuration: (minutes: number) => void;
  className?: string;
  children?: ReactNode;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const choices = useChoices(open, task.durationMinutes, now);

  useEffect(() => {
    const listen = (event: Event) => {
      if (event.defaultPrevented || (event as CustomEvent<string>).detail !== task.id) return;
      event.preventDefault();
      setPicking(false);
      setNow(Date.now());
      setOpen(true);
    };
    window.addEventListener(SCHEDULE_EVENT, listen);
    return () => window.removeEventListener(SCHEDULE_EVENT, listen);
  }, [task.id]);

  function change(next: boolean) {
    if (next && !open) setNow(Date.now());
    setOpen(next);
    if (!next) setPicking(false);
  }
  function choose(at: string) {
    change(false);
    onSchedule(dateTimeInputValue(at));
  }
  function save(local: string) {
    change(false);
    onSchedule(local);
  }
  function removeTime() {
    change(false);
    onRemoveTime();
  }

  const trigger = (
    <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label="Schedule" onClick={phone ? () => change(true) : undefined} className={cn("inline-flex cursor-pointer items-center", className)}>
      {children ?? (
        <>
          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
          <span>Schedule</span>
          <ChevronDownIcon aria-hidden className="text-subtle size-3 shrink-0" />
        </>
      )}
    </button>
  );
  const options = picking ? (
    <PickDateTime task={task} onSave={save} onCancel={() => setPicking(false)} />
  ) : (
    <div role="menu" aria-label="Schedule" className="flex flex-col">
      <ScheduleOptions task={task} choices={choices} onChoose={choose} onPick={() => setPicking(true)} onRemoveTime={removeTime} />
    </div>
  );

  if (phone) {
    return (
      <Sheet open={open} onOpenChange={change}>
        {trigger}
        <SheetContent side="bottom" className="overflow-y-auto">
          <SheetHeader className="h-auto min-h-14 px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <SheetTitle>Schedule</SheetTitle>
              <SheetDescription className="truncate">{task.title}</SheetDescription>
            </div>
            <SheetCloseButton />
          </SheetHeader>
          <div className="flex flex-col p-2">{options}</div>
          {!picking && (
            <div className="border-line-strong flex flex-col gap-2 border-t px-4 pt-3.5 pb-6">
              <span className="eyebrow-style text-subtle">Duration</span>
              <DurationButtons value={task.durationMinutes} onPick={(minutes) => minutes !== task.durationMinutes && onDuration(minutes)} />
              <CustomDuration value={task.durationMinutes} onSet={(minutes) => minutes !== task.durationMinutes && onDuration(minutes)} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[min(19rem,calc(100vw-2rem))] p-1">
        {!picking && <span className="eyebrow-style text-subtle block px-2.5 pt-2 pb-1">Schedule · {durationLabel(task.durationMinutes)}</span>}
        {options}
      </PopoverContent>
    </Popover>
  );
}

const QUICK_TIMES = ["09:00", "11:00", "14:00", "16:00"];

export function ReminderTimePrompt({
  title,
  onSave,
  className,
  label = "Remind me",
}: {
  title: string;
  onSave: (time: string) => void;
  className?: string;
  label?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(QUICK_TIMES[0]);
  const ready = /^\d{2}:\d{2}$/.test(time);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setTime(QUICK_TIMES[0]);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${label}. Pick a time first`} className={cn("inline-flex cursor-pointer items-center", className)}>
          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(19rem,calc(100vw-2rem))] p-3">
        <form
          aria-labelledby={`${id}-title`}
          className="flex flex-col gap-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            setOpen(false);
            requestReminderPermission();
            onSave(time);
          }}
        >
          <span id={`${id}-title`} className="ui-style font-medium">
            Pick a time for the reminder
          </span>
          <span className="caption-style text-subtle">{title} has a day but no time. The reminder makes it timed.</span>
          <div role="group" aria-label="Times" className="flex flex-wrap gap-1.5">
            {QUICK_TIMES.map((quick) => (
              <button
                key={quick}
                type="button"
                aria-pressed={time === quick}
                onClick={() => setTime(quick)}
                className={cn(
                  "ui-style ease-power3-out h-7 cursor-pointer rounded-full px-2.5 tabular-nums outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 [@media(pointer:coarse)]:h-11",
                  time === quick ? "bg-primary text-primary-foreground" : "text-soft hover:text-foreground bg-white/[0.06] hover:bg-white/10",
                )}
              >
                {quick}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={`${id}-time`} className="sr-only">
              Time
            </label>
            <Input id={`${id}-time`} type="time" step={300} value={time} onChange={(event) => setTime(event.target.value)} className="h-8 w-28 [@media(pointer:coarse)]:h-11" />
            <span className="flex-1" />
            <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)} className="[@media(pointer:coarse)]:h-11">
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!ready} className="[@media(pointer:coarse)]:h-11">
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
