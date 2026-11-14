"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DatePicker } from "@/components/_ui/date-picker";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Radio } from "@/components/_ui/radio";
import { useComposer } from "@/components/mail/compose-dock";
import { deleteSeriesAction, endSeriesAction, repeatHistoryAction, setRepeatAction, skipOccurrenceAction, undoRepeatAction, type RepeatActionResult } from "@/app/(crm)/repeats";
import { clockLabel, taskDueDay } from "@/lib/crm/task-time";
import type { Task } from "@/lib/crm/types";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import {
  checkEnds,
  checkRule,
  isLastWeekOfMonth,
  monthWeekOf,
  normalRule,
  occurrenceDays,
  repeatInputOf,
  repeatPresets,
  repeatSummary,
  sameRule,
  shortDay,
  weekdayOf,
  WEEKDAYS,
  type RepeatEnds,
  type RepeatFreq,
  type RepeatPattern,
  type RepeatRule,
  type Weekday,
} from "@/lib/task-repeat";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import RepeatIcon from "@/public/assets/images/workflows/repeat.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

export { RepeatIcon };

export type RepeatScope = "this" | "all";

export const REPEAT_SAVE_FAILED = "Couldn't save the repeat. Try again.";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const ORDINAL_WORDS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };
const UNITS: { freq: RepeatFreq; one: string; many: string }[] = [
  { freq: "daily", one: "day", many: "days" },
  { freq: "weekly", one: "week", many: "weeks" },
  { freq: "monthly", one: "month", many: "months" },
  { freq: "yearly", one: "year", many: "years" },
];

export function nextLabel(next: { dueAt: string; dueHasTime: boolean; occursOn: string } | null | undefined) {
  if (!next) return null;
  const day = taskDueDay(next.dueAt) ?? next.occursOn;
  return next.dueHasTime ? `${shortDay(day)}, ${clockLabel(next.dueAt)}` : shortDay(day);
}

export function doneMessage(task: Task) {
  const next = task.repeat?.current ? nextLabel(task.repeat.next) : null;
  return next ? `Done. Next: ${next}` : "Task done.";
}

function anchorOf(task: Task) {
  return task.dueDate ?? taskDueDay(task.dueAt) ?? dayKeyAt(new Date());
}

function atOf(task: Task) {
  return task.dueHasTime && task.dueAt ? clockLabel(task.dueAt) : null;
}

export function isRepeating(task: Task) {
  return Boolean(task.repeat && task.repeat.current && !task.completedAt && !task.repeat.ended);
}

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

export function RepeatMark({ task, short = false, className }: { task: Task; short?: boolean; className?: string }) {
  if (!task.repeat || task.completedAt || !task.repeat.current || task.repeat.ended) return null;
  const words = short ? task.repeat.short : task.repeat.phrase;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <RepeatIcon aria-hidden className="size-3 shrink-0 text-(--tag-purple-text)" />
      <span className="truncate">{words}</span>
    </span>
  );
}

function useUndoToast() {
  const composer = useComposer();
  const router = useRouter();
  return useCallback(
    (taskId: string, message: string, undo: string[] | undefined) => {
      composer.showToast({
        message,
        duration: 8_000,
        ...(undo && undo.length > 0
          ? {
              action: {
                label: "Undo",
                run: () =>
                  void undoRepeatAction(taskId, undo)
                    .catch(() => ({ error: "Couldn't undo. Try again." }))
                    .then((result: { error?: string }) => {
                      if (result.error) composer.showToast({ message: result.error, tone: "alert" });
                      router.refresh();
                    }),
              },
            }
          : {}),
      });
    },
    [composer, router],
  );
}

export function useRepeatActions(task: Task) {
  const composer = useComposer();
  const router = useRouter();
  const toast = useUndoToast();
  const [busy, setBusy] = useState(false);
  const act = useCallback(
    async (work: () => Promise<RepeatActionResult>, message: (result: RepeatActionResult) => string) => {
      setBusy(true);
      const result = await work().catch((): RepeatActionResult => ({ error: REPEAT_SAVE_FAILED }));
      setBusy(false);
      if (result.error) {
        composer.showToast({ message: result.error, tone: "alert" });
        return false;
      }
      toast(task.id, message(result), result.undo);
      router.refresh();
      return true;
    },
    [composer, router, task.id, toast],
  );
  return {
    busy,
    skip: () => act(() => skipOccurrenceAction(task.id, task.occursOn), (result) => `Skipped. Next: ${nextLabel(result.task ? { dueAt: result.task.dueAt ?? "", dueHasTime: result.task.dueHasTime, occursOn: result.task.occursOn ?? "" } : null) ?? "none"}`),
    stop: () => act(() => setRepeatAction(task.id, null), () => "Stopped repeating."),
    end: (until: string) => act(() => endSeriesAction(task.id, until), () => "Saved."),
    remove: () => act(() => deleteSeriesAction(task.id), () => "Deleted the series."),
    set: (rule: RepeatRule, ends: RepeatEnds) => act(() => setRepeatAction(task.id, repeatInputOf(rule, ends)), () => "Saved."),
  };
}

type View = "menu" | "custom" | "stop" | "end" | "delete";

function MenuOption({ checked, onSelect, children, detail, danger, icon }: { checked?: boolean; onSelect: () => void; children: ReactNode; detail?: string | null; danger?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "ui-style hit flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/[0.06] focus-visible:bg-white/[0.06] [@media(pointer:coarse)]:min-h-11",
        danger ? "text-danger" : "text-foreground",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon ?? (checked ? <CheckIcon aria-hidden className="size-3.5" /> : null)}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {detail && <span className="caption-style text-subtle shrink-0">{detail}</span>}
    </button>
  );
}

function Panel({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input, select, button[aria-pressed], [role='radio'], button:not([aria-label='Close'])")?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={root} role="group" aria-labelledby={id} className="flex flex-col gap-3 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id={id}>{title}</h3>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className="hit">
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      {children}
      <div className="flex justify-end gap-2">{footer}</div>
    </div>
  );
}

type Draft = {
  interval: string;
  freq: RepeatFreq;
  weekdays: Weekday[];
  monthly: "day" | "week" | "last";
  ends: "never" | "count" | "until";
  count: string;
  until: string;
};

function draftOf(task: Task, anchor: string): Draft {
  const rule = task.repeat?.rule;
  const ends = task.repeat?.ends;
  return {
    interval: String(rule?.interval ?? 1),
    freq: rule?.freq ?? "weekly",
    weekdays: rule?.weekdays?.length ? [...rule.weekdays] : [weekdayOf(anchor)],
    monthly: rule?.monthWeek ? (rule.monthWeek.n === -1 ? "last" : "week") : "day",
    ends: ends && "count" in ends ? "count" : ends && "until" in ends ? "until" : "never",
    count: ends && "count" in ends ? String(ends.count) : "10",
    until: ends && "until" in ends ? ends.until : "",
  };
}

function ruleOf(draft: Draft, anchor: string, original: RepeatRule | null = null): RepeatRule {
  const interval = Number(draft.interval);
  const base: RepeatRule = { freq: draft.freq, interval: Number.isInteger(interval) ? interval : 0 };
  if (draft.freq === "weekly") base.weekdays = draft.weekdays;
  const kept = original?.freq === "monthly" ? (original.monthWeek ? (original.monthWeek.n === -1 ? "last" : "week") : "day") : null;
  if (draft.freq === "monthly" && kept === draft.monthly) {
    if (original?.monthWeek) base.monthWeek = original.monthWeek;
    else base.monthDay = original?.monthDay ?? Number(anchor.slice(8, 10));
  } else if (draft.freq === "monthly") {
    if (draft.monthly === "day") base.monthDay = Number(anchor.slice(8, 10));
    else base.monthWeek = draft.monthly === "last" ? { n: -1, weekday: weekdayOf(anchor) } : monthWeekOf(anchor).n === -1 ? { n: 4, weekday: weekdayOf(anchor) } : monthWeekOf(anchor);
  }
  return base;
}

function endsOf(draft: Draft): RepeatEnds {
  if (draft.ends === "count") return { count: Number(draft.count) };
  if (draft.ends === "until") return { until: draft.until };
  return { never: true };
}

function CustomRepeat({ task, anchor, onCancel, onSave }: { task: Task; anchor: string; onCancel: () => void; onSave: (rule: RepeatRule, ends: RepeatEnds) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(task, anchor));
  const [shown, setShown] = useState<string | null>(null);
  const update = (change: Partial<Draft>) => {
    setShown(null);
    setDraft((current) => ({ ...current, ...change }));
  };
  const rule = ruleOf(draft, anchor, task.repeat && !task.repeat.ended ? task.repeat.rule : null);
  const ends = endsOf(draft);
  const problem = checkRule(rule) ?? (draft.ends === "until" && !draft.until ? "Choose an end date." : checkEnds(ends, anchor, dayKeyAt(new Date())));
  const pattern: RepeatPattern = { startsOn: anchor, at: atOf(task), rule: normalRule({ ...rule, interval: Math.max(1, rule.interval || 1) }), ends: problem ? { never: true } : ends };
  const interval = Math.max(1, Number(draft.interval) || 1);
  const name = DAY_NAMES[WEEKDAYS.indexOf(weekdayOf(anchor))];
  const week = monthWeekOf(anchor);
  const save = () => {
    if (problem) {
      setShown(problem);
      return;
    }
    onSave(normalRule(rule), ends);
  };
  return (
    <Panel
      title="Custom repeat"
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel} className="hit">
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={save} className="hit">
            Save
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-1.5">
        <legend className="caption-style text-subtle mb-1.5">Repeat every</legend>
        <div className="flex items-center gap-2">
          <Input
            id={`${id}-interval`}
            aria-label="Repeat every"
            inputMode="numeric"
            value={draft.interval}
            onChange={(event) => update({ interval: event.target.value.replace(/\D/g, "").slice(0, 2) })}
            className="w-14 tabular-nums"
          />
          <NativeSelect aria-label="Unit" value={draft.freq} onChange={(event) => update({ freq: event.target.value as RepeatFreq })} className="w-auto">
            {UNITS.map((unit) => (
              <option key={unit.freq} value={unit.freq}>
                {plural(interval, unit.one, unit.many)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </fieldset>
      {draft.freq === "weekly" && (
        <div role="group" aria-labelledby={`${id}-on`} className="flex flex-col gap-1.5">
          <span id={`${id}-on`} className="caption-style text-subtle">
            On
          </span>
          <div className="flex flex-wrap gap-1.5 [@media(pointer:coarse)]:gap-2">
            {WEEKDAYS.map((day, index) => {
              const on = draft.weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[index]}
                  onClick={() => update({ weekdays: on ? draft.weekdays.filter((item) => item !== day) : [...draft.weekdays, day] })}
                  className={cn(
                    "hit flex size-8 items-center justify-center rounded-full text-[12px] font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-(--primary)",
                    on ? "bg-primary text-primary-foreground" : "border-line-strong text-soft border hover:bg-white/[0.06]",
                  )}
                >
                  {DAY_LETTERS[index]}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {draft.freq === "monthly" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="caption-style text-subtle mb-1.5">Monthly on</legend>
          <label className="ui-style flex items-center gap-2">
            <Radio name={`${id}-monthly`} checked={draft.monthly === "day"} onChange={() => update({ monthly: "day" })} />
            Day {Number(anchor.slice(8, 10))}
          </label>
          {week.n !== -1 && (
            <label className="ui-style flex items-center gap-2">
              <Radio name={`${id}-monthly`} checked={draft.monthly === "week"} onChange={() => update({ monthly: "week" })} />
              The {ORDINAL_WORDS[week.n]} {name}
            </label>
          )}
          {isLastWeekOfMonth(anchor) && (
            <label className="ui-style flex items-center gap-2">
              <Radio name={`${id}-monthly`} checked={draft.monthly === "last"} onChange={() => update({ monthly: "last" })} />
              The last {name}
            </label>
          )}
        </fieldset>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="caption-style text-subtle mb-1.5">Ends</legend>
        <label className="ui-style flex min-h-8 items-center gap-2">
          <Radio name={`${id}-ends`} checked={draft.ends === "never"} onChange={() => update({ ends: "never" })} />
          Never
        </label>
        <div className="ui-style flex min-h-8 items-center gap-2">
          <Radio id={`${id}-after`} name={`${id}-ends`} checked={draft.ends === "count"} onChange={() => update({ ends: "count" })} />
          <label htmlFor={`${id}-after`}>After</label>
          <Input
            aria-label="Times"
            inputMode="numeric"
            value={draft.count}
            onFocus={() => update({ ends: "count" })}
            onChange={(event) => update({ ends: "count", count: event.target.value.replace(/\D/g, "").slice(0, 3) })}
            className="w-16 tabular-nums"
          />
          <span>times</span>
        </div>
        <div className="ui-style flex min-h-8 items-center gap-2">
          <Radio id={`${id}-until`} name={`${id}-ends`} checked={draft.ends === "until"} onChange={() => update({ ends: "until" })} />
          <label htmlFor={`${id}-until`}>On</label>
          <DatePicker id={`${id}-until-date`} aria-label="End date" placeholder="Pick a date" value={draft.until} onChange={(value) => update({ ends: "until", until: value })} className="w-auto" />
        </div>
      </fieldset>
      <p className="caption-style text-soft flex items-start gap-2 rounded-lg bg-white/[0.04] px-2.5 py-2">
        <RepeatIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-purple-text)" />
        <span>{repeatSummary(pattern)}</span>
      </p>
      {shown && (
        <p role="alert" className="caption-style text-danger">
          {shown}
        </p>
      )}
    </Panel>
  );
}

function EndOnDate({ task, onCancel, onSave }: { task: Task; onCancel: () => void; onSave: (until: string) => void }) {
  const id = useId();
  const repeat = task.repeat!;
  const [until, setUntil] = useState(() => ("until" in repeat.ends ? repeat.ends.until : ""));
  const from = task.occursOn ?? anchorOf(task);
  const pattern: RepeatPattern = { startsOn: repeat.startsOn, at: repeat.at, rule: repeat.rule, ends: until ? { until } : { never: true } };
  const days = until && until >= from ? occurrenceDays(pattern, shiftDay(from, 1), until, 5000) : null;
  const left = days ? days.length : null;
  const lastDay = days && days.length > 0 ? days[days.length - 1] : from;
  const problem = until && until < from ? "The end date is before the first one." : null;
  return (
    <Panel
      title="End on a date"
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel} className="hit">
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!until || Boolean(problem)} onClick={() => onSave(until)} className="hit">
            Save
          </Button>
        </>
      }
    >
      <DatePicker id={`${id}-until`} aria-label="Last day" placeholder="Pick a date" value={until} onChange={setUntil} />
      {problem ? (
        <p role="alert" className="caption-style text-danger">
          {problem}
        </p>
      ) : (
        left !== null && (
          <p className="caption-style text-soft flex items-start gap-2 rounded-lg bg-white/[0.04] px-2.5 py-2">
            <RepeatIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-purple-text)" />
            <span>{left === 0 ? "This is the last one." : `${left} more. Last one: ${dayWithYear(lastDay)}.`}</span>
          </p>
        )
      )}
    </Panel>
  );
}

function dayWithYear(day: string) {
  return day.slice(0, 4) === dayKeyAt(new Date()).slice(0, 4) ? shortDay(day) : `${shortDay(day)} ${day.slice(0, 4)}`;
}

function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']")];
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

export function RepeatMenu({ task, trigger, align = "start" }: { task: Task; trigger: ReactNode; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const actions = useRepeatActions(task);
  const anchor = anchorOf(task);
  const repeating = isRepeating(task);
  const series = Boolean(task.repeat?.current && !task.completedAt);
  const presets = repeatPresets(anchor);
  const current = task.repeat && !task.repeat.ended ? task.repeat.rule : null;
  const keptEnds: RepeatEnds = task.repeat && !task.repeat.ended ? task.repeat.ends : { never: true };
  const close = () => {
    setOpen(false);
    setView("menu");
  };
  const pick = (rule: RepeatRule) => {
    close();
    if (current && sameRule(current, rule)) return;
    void actions.set(rule, keptEnds);
  };
  const matched = current ? presets.find((preset) => sameRule(preset.rule, current)) : null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView("menu");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="max-h-[min(var(--radix-popover-content-available-height),36rem)] w-[min(19rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain">
        {view === "menu" && (
          <div role="menu" aria-label="Repeat" onKeyDown={moveFocus} className="flex flex-col p-1">
            <MenuOption checked={!repeating} onSelect={() => (repeating ? setView("stop") : close())}>
              Don&apos;t repeat
            </MenuOption>
            {presets.map((preset) => (
              <MenuOption key={preset.id} checked={matched?.id === preset.id} onSelect={() => pick(preset.rule)}>
                {preset.label}
              </MenuOption>
            ))}
            <span aria-hidden className="bg-line-strong mx-1 my-1 h-px" />
            <MenuOption checked={Boolean(current && !matched)} onSelect={() => setView("custom")} detail={null} icon={current && !matched ? <CheckIcon aria-hidden className="size-3.5" /> : null}>
              <span className="flex items-center justify-between gap-2">
                Custom
                <ChevronRightIcon aria-hidden className="text-subtle size-3" />
              </span>
            </MenuOption>
            {repeating && series && (
              <>
                <span aria-hidden className="bg-line-strong mx-1 my-1 h-px" />
                <MenuOption
                  icon={<RepeatIcon aria-hidden className="text-subtle size-3.5" />}
                  detail={task.repeat?.next ? `Next: ${shortDay(task.repeat.next.occursOn)}` : null}
                  onSelect={() => {
                    close();
                    void actions.skip();
                  }}
                >
                  Skip this one
                </MenuOption>
                <MenuOption icon={<XIcon aria-hidden className="text-subtle size-3" />} onSelect={() => setView("stop")}>
                  Stop repeating
                </MenuOption>
                <MenuOption icon={<CalendarIcon aria-hidden className="text-subtle size-3.5" />} onSelect={() => setView("end")}>
                  End on a date
                </MenuOption>
                <MenuOption danger onSelect={() => setView("delete")}>
                  Delete the series
                </MenuOption>
              </>
            )}
          </div>
        )}
        {view === "custom" && (
          <CustomRepeat
            task={task}
            anchor={anchor}
            onCancel={close}
            onSave={(rule, ends) => {
              close();
              void actions.set(rule, ends);
            }}
          />
        )}
        {view === "stop" && (
          <Panel
            title="Stop repeating"
            onClose={close}
            footer={
              <>
                <Button variant="secondary" size="sm" onClick={close} className="hit">
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    close();
                    void actions.stop();
                  }}
                  className="hit"
                >
                  Stop repeating
                </Button>
              </>
            }
          >
            <p className="ui-style text-soft">This one stays. Nothing after it.</p>
          </Panel>
        )}
        {view === "end" && task.repeat && (
          <EndOnDate
            task={task}
            onCancel={close}
            onSave={(until) => {
              close();
              void actions.end(until);
            }}
          />
        )}
        {view === "delete" && (
          <Panel
            title="Delete the series"
            onClose={close}
            footer={
              <>
                <Button variant="secondary" size="sm" onClick={close} className="hit">
                  Cancel
                </Button>
                <HoldButton
                  onConfirm={() => {
                    close();
                    void actions.remove();
                  }}
                >
                  Hold to delete
                </HoldButton>
              </>
            }
          >
            <p className="ui-style text-soft">Deletes this one and every later one. Done ones stay.</p>
          </Panel>
        )}
      </PopoverContent>
    </Popover>
  );
}

const CHIP =
  "h-7 w-auto max-w-full min-w-0 gap-1.5 rounded-full border-transparent bg-white/[0.06] px-2.5 text-[12.5px] leading-none text-soft hover:bg-white/10 hover:text-foreground";

export function RepeatField({ task, canChange, layout }: { task: Task; canChange: boolean; layout: "panel" | "row" }) {
  const repeat = task.repeat;
  const live = Boolean(repeat && repeat.current && !task.completedAt);
  const stopped = live && repeat!.ended && !repeat!.next;
  const halted = stopped && !("never" in repeat!.ends) && !repeat!.end;
  const words = live && !stopped ? `${repeat!.text}${repeat!.end ? `, ${repeat!.end}` : ""}` : null;
  const next = live && !stopped ? nextLabel(repeat!.next) : null;
  if (!canChange || task.completedAt) {
    if (!words) return null;
    return (
      <span className="ui-style text-soft inline-flex items-center gap-1.5">
        <RepeatIcon aria-hidden className="size-3.5 shrink-0 text-(--tag-purple-text)" />
        {words}
      </span>
    );
  }
  const trigger = (
    <Button variant="chip" size="none" aria-label={words ? `Repeat: ${words}. Change` : "Repeat"} className={cn(CHIP, "hit", !words && "text-subtle")}>
      <RepeatIcon aria-hidden className={cn("size-3.5 shrink-0", words && "text-(--tag-purple-text)")} />
      {words ? <span className="truncate">{words}</span> : layout === "panel" && <span>Repeat</span>}
    </Button>
  );
  return (
    <>
      <RepeatMenu task={task} trigger={trigger} />
      {next && <span className="caption-style text-subtle">Next: {shortDay(repeat!.next!.occursOn)}</span>}
      {stopped && <span className="caption-style text-subtle">{halted || "never" in repeat!.ends ? "Stopped. This is the last one." : "This is the last one."}</span>}
    </>
  );
}

export function SkipButton({ task, variant = "ghost", size = "sm", className }: { task: Task; variant?: "ghost" | "secondary"; size?: "sm" | "md"; className?: string }) {
  const actions = useRepeatActions(task);
  if (!isRepeating(task)) return null;
  return (
    <Button variant={variant} size={size} disabled={actions.busy} onClick={() => void actions.skip()} className={cn("hit", className)}>
      <RepeatIcon aria-hidden className="size-3.5" />
      Skip this one
    </Button>
  );
}

const KIND_WORDS = { done: "Done", missed: "Missed", skipped: "Skipped" } as const;

export function RepeatEarlier({ task, section }: { task: Task; section: (children: ReactNode) => ReactNode }) {
  const [items, setItems] = useState<{ kind: "done" | "missed" | "skipped"; day: string }[] | null>(null);
  const key = `${task.id}|${task.occursOn}|${task.updatedAt}`;
  useEffect(() => {
    if (!task.seriesId) return;
    let cancelled = false;
    void repeatHistoryAction(task.id)
      .catch(() => ({ items: [] }))
      .then((result) => {
        if (!cancelled) setItems(result.items ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [key, task.id, task.seriesId]);
  if (!task.seriesId || !items || items.length === 0) return null;
  return section(
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li key={`${item.kind}-${item.day}`} className="ui-style text-soft flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-full",
              item.kind === "done" ? "bg-success text-white" : item.kind === "missed" ? "border-danger text-danger border" : "border-line-strong text-subtle border",
            )}
          >
            {item.kind === "done" ? <CheckIcon className="size-2.5" /> : item.kind === "missed" ? <XIcon className="size-2" /> : <RepeatIcon className="size-2.5" />}
          </span>
          {KIND_WORDS[item.kind]} {shortDay(item.day)}
        </li>
      ))}
    </ul>,
  );
}

export type ScopeChange = { kind: "time" | "title" | "description" | "assignee" | "duration" | "reminder"; to?: string };

const CHANGE_LINES: Record<ScopeChange["kind"], string> = {
  time: "Moving",
  title: "Renaming.",
  description: "Changing the description.",
  assignee: "Reassigning.",
  duration: "Changing the length.",
  reminder: "Changing the reminder.",
};

function scopeTexts(task: Task, change: ScopeChange) {
  const today = dayKeyAt(new Date());
  const day = taskDueDay(task.dueAt) ?? task.occursOn ?? anchorOf(task);
  const own = day === today ? "today's" : shortDay(day);
  const ownCapital = day === today ? "Today" : shortDay(day);
  const next = task.repeat?.next?.occursOn;
  const nextName = next ? (next === shiftDay(today, 1) ? "Tomorrow" : shortDay(next)) : null;
  const time = change.kind === "time";
  const resets = time && task.repeat && task.repeat.changedDates > 0 ? ` Resets ${task.repeat.changedDates} changed date${task.repeat.changedDates === 1 ? "" : "s"}.` : "";
  return {
    line: time ? `Moving ${own} to ${change.to}.` : CHANGE_LINES[change.kind],
    one: time ? `Only ${own} moves.${nextName && task.repeat?.at ? ` ${nextName} is back at ${task.repeat.at}.` : ""}` : `Only ${own} changes.`,
    all: time ? `${ownCapital} and every later one move to ${change.to}.${resets}` : `${ownCapital} and every later one change.`,
  };
}

export function useRepeatScope(task: Task) {
  const [asking, setAsking] = useState<{ change: ScopeChange; resolve: (scope: RepeatScope | null) => void } | null>(null);
  const [choice, setChoice] = useState<RepeatScope>("this");
  const latest = useRef(asking);
  useEffect(() => {
    latest.current = asking;
  });
  useEffect(() => () => latest.current?.resolve("this"), []);
  const ask = useCallback((change: ScopeChange) => {
    latest.current?.resolve(null);
    setChoice("this");
    return new Promise<RepeatScope | null>((resolve) => setAsking({ change, resolve }));
  }, []);
  const finish = (scope: RepeatScope | null) => {
    asking?.resolve(scope);
    setAsking(null);
  };
  const texts = asking ? scopeTexts(task, asking.change) : null;
  const name = useId();
  const dialog = (
    <Dialog open={Boolean(asking)} onOpenChange={(open) => !open && finish(null)}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader className="pr-12">
          <DialogTitle className="flex min-w-0 gap-1">
            <span className="truncate">{task.title}</span>
            <span className="shrink-0">repeats</span>
          </DialogTitle>
          <DialogDescription>{texts?.line}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-1 px-3 pb-2">
          <legend className="sr-only">Apply to</legend>
          {(["this", "all"] as const).map((scope) => (
            <label key={scope} className={cn("flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5", choice === scope && "bg-white/[0.05]")}>
              <Radio name={name} checked={choice === scope} onChange={() => setChoice(scope)} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="ui-style text-foreground">{scope === "this" ? "This one" : "All"}</span>
                <span className="caption-style text-subtle">{scope === "this" ? texts?.one : texts?.all}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="md" className="hit">
              Cancel
            </Button>
          </DialogClose>
          <Button variant="primary" size="md" onClick={() => finish(choice)} className="hit">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { ask, dialog };
}
