"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { nextFreeAction } from "@/app/(crm)/task-schedule";
import {
  DURATION_CHOICES,
  durationLabel,
  durationWords,
  isPastTime,
  isTaskDuration,
  MAX_TASK_DURATION,
  MIN_TASK_DURATION,
  nextFreeStart,
  pickTimeFor,
  reminderBlock,
  reminderBlockText,
  reminderTimeFor,
  scheduleChoices,
  type ScheduleChoice,
} from "@/lib/crm/task-time";
import { requestReminderPermission } from "@/lib/reminder-alerts";
import { dateTimeInputValue, dayKeyIn } from "@/lib/time";
import { cn } from "@/lib/utils";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import ClockIcon from "@/public/assets/images/tasks/clock.svg";
import EditIcon from "@/public/assets/images/workflows/edit.svg";

const PHONE_QUERY = "(max-width: 639px)";
export const SCHEDULE_EVENT = "orbit:task-schedule";
const DURATION_ERROR = `Choose a duration between ${MIN_TASK_DURATION} and ${MAX_TASK_DURATION} minutes.`;
const CALENDAR_ERROR = "Couldn't read your calendar. Try again.";

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
  "ui-style text-soft hover:text-foreground focus-visible:bg-white/5 focus-visible:text-foreground disabled:text-subtle h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left font-normal focus-visible:ring-0 active:scale-100 disabled:opacity-100 hover:bg-white/5 [@media(pointer:coarse)]:min-h-11";

const PILL = "ui-style tabular-nums font-normal disabled:opacity-40";

const TRIGGER = "inline-flex cursor-pointer items-center";

function DurationButtons({ value, onPick }: { value: number; onPick: (minutes: number) => void }) {
  return (
    <div role="group" aria-label="Duration" className="grid grid-cols-6 gap-1 max-sm:grid-cols-3">
      {DURATION_CHOICES.map((minutes) => (
        <Button
          key={minutes}
          variant="ghost"
          size="none"
          aria-pressed={minutes === value}
          onClick={() => onPick(minutes)}
          className={cn(
            PILL,
            "h-8 rounded-lg [@media(pointer:coarse)]:h-11",
            minutes === value ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground" : "text-soft hover:text-foreground bg-white/[0.06] hover:bg-white/10",
          )}
        >
          {durationLabel(minutes)}
        </Button>
      ))}
    </div>
  );
}

function customText(value: number) {
  return DURATION_CHOICES.includes(value as (typeof DURATION_CHOICES)[number]) ? "" : String(value);
}

function CustomDuration({ value, onSet }: { value: number; onSet: (minutes: number) => void }) {
  const id = useId();
  const [seen, setSeen] = useState(value);
  const [text, setText] = useState(customText(value));
  const [error, setError] = useState<string | null>(null);
  if (seen !== value) {
    setSeen(value);
    setText(customText(value));
    setError(null);
  }
  function set() {
    const minutes = Number(text.trim());
    if (!isTaskDuration(minutes)) {
      setError(DURATION_ERROR);
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
          event.stopPropagation();
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
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setText(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
          className="h-8 w-[5em] [@media(pointer:coarse)]:h-11"
        />
        <span className="caption-style text-subtle flex-1">minutes</span>
        <Button variant="secondary" size="sm" type="submit" className="[@media(pointer:coarse)]:h-11">
          Set
        </Button>
      </form>
      {error && (
        <p id={`${id}-error`} role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function DurationMenu({ value, onChange, className, compact = false }: { value: number; onChange: (minutes: number) => void; className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const pick = (minutes: number) => {
    setOpen(false);
    if (minutes !== value) onChange(minutes);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="chip" size="none" aria-label={`Duration ${durationLabel(value)}. Change`} className={cn(TRIGGER, className)}>
          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="tabular-nums">{durationLabel(value)}</span>
          {!compact && <ChevronDownIcon aria-hidden className="text-subtle size-3 shrink-0" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-[min(17em,calc(100vw-2rem))] flex-col gap-2 p-2">
        <span className="eyebrow-style text-subtle px-1 pt-1">Duration</span>
        <DurationButtons value={value} onPick={pick} />
        <div className="bg-line-strong -mx-2 h-px" />
        {open && <CustomDuration value={value} onSet={pick} />}
      </PopoverContent>
    </Popover>
  );
}

type ScheduleTask = { id: string; title: string; dueAt: string | null; dueHasTime: boolean; durationMinutes: number };

type FreeState = { kind: "loading" } | { kind: "slot"; choice: ScheduleChoice } | { kind: "none" } | { kind: "outside" } | { kind: "error" };

function useNextFree(open: boolean, durationMinutes: number, now: number): FreeState {
  const [fetched, setFetched] = useState<{ key: string; state: FreeState } | null>(null);
  const key = `${durationMinutes}|${now}`;
  const possible = nextFreeStart(now, durationMinutes, []) !== null;
  useEffect(() => {
    if (!open || !possible) return;
    let cancelled = false;
    void nextFreeAction(durationMinutes)
      .catch(() => ({ error: CALENDAR_ERROR }))
      .then((result) => {
        if (cancelled) return;
        if ("error" in result) setFetched({ key, state: { kind: "error" } });
        else setFetched({ key, state: result.free ? { kind: "slot", choice: result.free } : { kind: "none" } });
      });
    return () => {
      cancelled = true;
    };
  }, [open, possible, durationMinutes, key]);
  if (!possible) return { kind: "outside" };
  if (!fetched || fetched.key !== key) return { kind: "loading" };
  return fetched.state;
}

function PickDateTime({ task, onSave, onCancel }: { task: ScheduleTask; onSave: (local: string) => void; onCancel: () => void }) {
  const id = useId();
  const [now] = useState(() => Date.now());
  const start = task.dueAt ? dateTimeInputValue(task.dueAt) : "";
  const [date, setDate] = useState(() => start.slice(0, 10) || dayKeyIn(new Date(now)));
  const [time, setTime] = useState(() => (task.dueHasTime ? start.slice(11, 16) : pickTimeFor(start.slice(0, 10) || dayKeyIn(new Date(now)), now)));
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time);
  return (
    <form
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2.5 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (ready) onSave(`${date}T${time}`);
      }}
    >
      <span id={`${id}-title`} className="ui-style font-medium">
        Pick a date and time
      </span>
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-date`} className="sr-only">
          Date
        </label>
        <Input id={`${id}-date`} type="date" autoFocus value={date} onChange={(event) => setDate(event.target.value)} className="h-8 min-w-0 flex-1 [@media(pointer:coarse)]:h-11" />
        <label htmlFor={`${id}-time`} className="sr-only">
          Time
        </label>
        <Input id={`${id}-time`} type="time" value={time} onChange={(event) => setTime(event.target.value)} className="h-8 w-[7em] [@media(pointer:coarse)]:h-11" />
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

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
  items[next].focus();
}

function freeDetail(free: FreeState) {
  if (free.kind === "slot") return free.choice.detail;
  if (free.kind === "none") return "Full";
  if (free.kind === "error") return "";
  return "…";
}

function ScheduleOptions({
  task,
  free,
  fixed,
  menu,
  onChoose,
  onPick,
  onRemoveTime,
}: {
  task: ScheduleTask;
  free: FreeState;
  fixed: ScheduleChoice[];
  menu: boolean;
  onChoose: (at: string) => void;
  onPick: () => void;
  onRemoveTime: () => void;
}) {
  const role = menu ? "menuitem" : undefined;
  const separator = <div role={menu ? "separator" : undefined} aria-hidden={menu ? undefined : true} className="bg-line-strong mx-1 my-1 h-px" />;
  return (
    <>
      {free.kind !== "outside" && (
        <Button
          variant="ghost"
          size="none"
          role={role}
          disabled={free.kind !== "slot"}
          aria-busy={free.kind === "loading" || undefined}
          onClick={() => free.kind === "slot" && onChoose(free.choice.at)}
          className={OPTION}
        >
          <ClockIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className={cn("min-w-0 flex-1 truncate", free.kind === "error" && "text-danger")}>
            {free.kind === "error" ? CALENDAR_ERROR : `Next free ${durationWords(task.durationMinutes)}`}
          </span>
          <span className="caption-style text-subtle w-[3.5em] shrink-0 text-right tabular-nums">{freeDetail(free)}</span>
        </Button>
      )}
      {fixed.map((choice) => (
        <Button key={choice.id} variant="ghost" size="none" role={role} onClick={() => onChoose(choice.at)} className={OPTION}>
          <CalendarIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{choice.label}</span>
          <span className="caption-style text-subtle shrink-0 tabular-nums">{choice.detail}</span>
        </Button>
      ))}
      {separator}
      <Button variant="ghost" size="none" role={role} onClick={onPick} className={OPTION}>
        <EditIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Pick a date and time</span>
        <ChevronRightIcon aria-hidden className="text-subtle size-3 shrink-0" />
      </Button>
      {task.dueHasTime && (
        <>
          {separator}
          <Button variant="ghost" size="none" role={role} onClick={onRemoveTime} className={OPTION}>
            <XIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Remove the time</span>
            <span className="caption-style text-subtle shrink-0">Keeps the day</span>
          </Button>
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const free = useNextFree(open, task.durationMinutes, now);
  const fixed = scheduleChoices({ durationMinutes: task.durationMinutes, now }).filter((choice) => choice.id !== "next-free");

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
  function setDuration(minutes: number) {
    if (minutes !== task.durationMinutes) onDuration(minutes);
  }

  const trigger = (
    <Button
      variant="chip"
      size="none"
      aria-haspopup={phone ? "dialog" : "menu"}
      aria-expanded={open}
      aria-label="Schedule"
      onClick={phone ? () => change(true) : undefined}
      className={cn(TRIGGER, className)}
    >
      {children ?? (
        <>
          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
          <span>Schedule</span>
          <ChevronDownIcon aria-hidden className="text-subtle size-3 shrink-0" />
        </>
      )}
    </Button>
  );
  const options = (menu: boolean) => (
    <ScheduleOptions task={task} free={free} fixed={fixed} menu={menu} onChoose={choose} onPick={() => setPicking(true)} onRemoveTime={removeTime} />
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
          {picking ? (
            <PickDateTime task={task} onSave={save} onCancel={() => setPicking(false)} />
          ) : (
            <>
              <div className="flex flex-col p-2">{options(false)}</div>
              <div className="border-line-strong flex flex-col gap-2 border-t px-4 pt-3.5 pb-6">
                <span className="eyebrow-style text-subtle">Duration</span>
                <DurationButtons value={task.durationMinutes} onPick={setDuration} />
                <CustomDuration value={task.durationMinutes} onSet={setDuration} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(21em,calc(100vw-2rem))] p-1"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
        }}
      >
        {picking ? (
          <PickDateTime task={task} onSave={save} onCancel={() => setPicking(false)} />
        ) : (
          <>
            <span className="eyebrow-style text-subtle block px-2.5 pt-2 pb-1">Schedule · {durationLabel(task.durationMinutes)}</span>
            <div ref={menuRef} role="menu" aria-label="Schedule" onKeyDown={moveFocus} className="flex flex-col">
              {options(true)}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

const QUICK_TIMES = ["09:00", "11:00", "14:00", "16:00"];

type PromptProps = {
  title: string;
  day: string;
  lead?: number;
  onSave: (time: string) => void;
  onRemove?: () => void;
};

function ReminderForm({ title, day, lead = 0, onSave, onRemove, onClose }: PromptProps & { onClose: () => void }) {
  const id = useId();
  const [now] = useState(() => Date.now());
  const [time, setTime] = useState(() => reminderTimeFor(day, lead, now) ?? "");
  const block = reminderBlock(day, lead, now);
  const ready = /^\d{2}:\d{2}$/.test(time) && !block;
  const dismiss = onRemove ? (
    <Button
      variant="secondary"
      size="sm"
      type="button"
      onClick={() => {
        onClose();
        onRemove();
      }}
      className="[@media(pointer:coarse)]:h-11"
    >
      No reminder
    </Button>
  ) : (
    <Button variant="secondary" size="sm" type="button" onClick={onClose} className="[@media(pointer:coarse)]:h-11">
      Cancel
    </Button>
  );
  if (block) {
    return (
      <div className="flex flex-col gap-2.5">
        <span className="ui-style font-medium">Pick a time for the reminder</span>
        <p role="status" className="caption-style text-soft">
          {reminderBlockText(block, lead)}
        </p>
        <div className="flex justify-end">{dismiss}</div>
      </div>
    );
  }
  return (
    <form
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!ready) return;
        onClose();
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
          <Button
            key={quick}
            variant="ghost"
            size="none"
            aria-pressed={time === quick}
            disabled={isPastTime(day, quick, now, undefined, lead)}
            onClick={() => setTime(quick)}
            className={cn(
              PILL,
              "h-7 rounded-full px-2.5 [@media(pointer:coarse)]:h-11",
              time === quick ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground" : "text-soft hover:text-foreground bg-white/[0.06] hover:bg-white/10",
            )}
          >
            {quick}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-time`} className="sr-only">
          Time
        </label>
        <Input
          id={`${id}-time`}
          data-reminder-time=""
          type="time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          className="h-8 w-[7em] [@media(pointer:coarse)]:h-11"
        />
        <span className="flex-1" />
        {dismiss}
        <Button variant="primary" size="sm" type="submit" disabled={!ready} className="[@media(pointer:coarse)]:h-11">
          Save
        </Button>
      </div>
    </form>
  );
}

export function ReminderTimePrompt({
  open: controlled,
  onOpenChange,
  className,
  label = "Remind me",
  needed = false,
  ...props
}: PromptProps & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  label?: string;
  needed?: boolean;
}) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  function change(next: boolean) {
    setInner(next);
    onOpenChange?.(next);
  }
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <Button
          variant="chip"
          size="none"
          aria-label={needed ? "Pick a time for the reminder" : `${label}. Pick a time first`}
          className={cn(TRIGGER, needed && "text-warning", className)}
        >
          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{needed ? "Pick a time" : label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(20em,calc(100vw-2rem))] p-3"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = event.currentTarget as HTMLElement | null;
          (content?.querySelector<HTMLElement>("[data-reminder-time]") ?? content?.querySelector<HTMLElement>("button"))?.focus();
        }}
      >
        <ReminderForm {...props} onClose={() => change(false)} />
      </PopoverContent>
    </Popover>
  );
}
