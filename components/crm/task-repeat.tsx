"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
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
import { clockLabel } from "@/lib/crm/task-time";
import type { Task } from "@/lib/crm/types";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import {
  checkEnds,
  checkRule,
  DAY_NAMES,
  isLastWeekOfMonth,
  monthWeekOf,
  normalRule,
  occurrenceDays,
  repeatInputOf,
  repeatPresets,
  repeatSummary,
  shortDay,
  WEEKDAYS,
  type RepeatEnds,
  type RepeatFreq,
  type RepeatPattern,
  type RepeatRule,
} from "@/lib/task-repeat";
import {
  anchorOf,
  countLeft,
  dayWithYear,
  DELETE_FAILED,
  draftOf,
  END_FAILED,
  endsOf,
  endsOnFirst,
  ENDS_ON_FIRST,
  isRepeating,
  keptMonthly,
  menuFocus,
  monthlyLabel,
  newActionKey,
  nextDetail,
  nextLabel,
  ownsRepeat,
  patternInputOf,
  changeWarning,
  laterReplaced,
  lostOnChange,
  REPEAT_SAVE_FAILED,
  repeatSavedMessage,
  ruleOf,
  SCOPE_LATER,
  runsSeries,
  sameEnds,
  sameRepeat,
  scopeTexts,
  SKIP_FAILED,
  skippedMessage,
  STOP_FAILED,
  type Draft,
  type ScopeAnswer,
  type ScopeChange,
} from "@/lib/task-repeat-menu";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import RepeatIcon from "@/public/assets/images/workflows/repeat.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

export { RepeatIcon };

export { isRepeating, nextLabel, ownsRepeat, REPEAT_SAVE_FAILED, runsSeries, SCOPE_LATER, type ScopeAnswer, type ScopeChange };

export type RepeatScope = "this" | "all";

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const UNITS: { freq: RepeatFreq; one: string; many: string }[] = [
  { freq: "daily", one: "day", many: "days" },
  { freq: "weekly", one: "week", many: "weeks" },
  { freq: "monthly", one: "month", many: "months" },
  { freq: "yearly", one: "year", many: "years" },
];

export function doneMessage(task: Task) {
  const next = task.repeat?.current ? nextLabel(task.repeat.next) : null;
  return next ? `Done. Next: ${next}.` : "Task done.";
}

function atOf(task: Task) {
  return task.dueHasTime && task.dueAt ? clockLabel(task.dueAt) : null;
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

export function useUndoToast() {
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

export function useRepeatActions(task: Task, onDeleted?: () => void) {
  const composer = useComposer();
  const router = useRouter();
  const toast = useUndoToast();
  const [busy, setBusy] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const act = useCallback(
    (work: (key: string) => Promise<RepeatActionResult>, message: (result: RepeatActionResult) => string, failed: string, saved?: (result: RepeatActionResult) => void) => {
      pending.current += 1;
      setBusy(true);
      const run = queue.current.then(async () => {
        const key = newActionKey();
        const result = await work(key).catch((): RepeatActionResult => ({ error: failed }));
        if (result.error) {
          composer.showToast({ message: result.error, tone: "alert" });
          return false;
        }
        toast(result.task?.id ?? task.id, message(result), result.undo);
        saved?.(result);
        router.refresh();
        return true;
      });
      queue.current = run.finally(() => {
        pending.current -= 1;
        if (pending.current === 0) setBusy(false);
      });
      return run;
    },
    [composer, router, task.id, toast],
  );
  return {
    busy,
    skip: () => act((key) => skipOccurrenceAction(task.id, task.occursOn, key), (result) => skippedMessage(result.task), SKIP_FAILED),
    stop: () => act((key) => setRepeatAction(task.id, null, key), () => "Stopped repeating.", STOP_FAILED),
    end: (until: string) => act((key) => endSeriesAction(task.id, until, key), () => "Saved", END_FAILED),
    remove: () =>
      act(
        (key) => deleteSeriesAction(task.id, key),
        () => "Deleted the series.",
        DELETE_FAILED,
        (result) => {
          if (result.task?.id === task.id && result.task.archivedAt) onDeleted?.();
        },
      ),
    set: (rule: RepeatRule, ends?: RepeatEnds) => {
      const lost = lostOnChange(task, rule);
      const later = laterReplaced(task, rule);
      return act((key) => setRepeatAction(task.id, ends ? repeatInputOf(rule, ends) : patternInputOf(rule), key), (result) => repeatSavedMessage(task, result.task, lost, later), REPEAT_SAVE_FAILED);
    },
  };
}

type View = "menu" | "custom" | "stop" | "end" | "delete" | "resets";

function MenuOption({
  checked,
  onSelect,
  children,
  detail,
  danger,
  icon,
  active = false,
}: {
  checked?: boolean;
  onSelect: () => void;
  children: ReactNode;
  detail?: string | null;
  danger?: boolean;
  icon?: ReactNode;
  active?: boolean;
}) {
  return (
    <Button
      variant="item"
      size="none"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "ui-style flex min-h-8 items-center gap-2 px-2 py-1.5 leading-snug hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:ring-0 [@media(pointer:coarse)]:min-h-11",
        danger ? "text-danger" : "text-foreground",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon ?? (checked ? <CheckIcon aria-hidden className="size-3.5" /> : null)}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {detail && <span className="caption-style text-subtle shrink-0">{detail}</span>}
    </Button>
  );
}

function Panel({ title, onClose, onEnter, children, footer }: { title: string; onClose: () => void; onEnter?: () => void; children: ReactNode; footer: ReactNode }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input, select, button[aria-pressed], [role='radio'], button:not([aria-label='Close'])")?.focus({ preventScroll: true });
  }, []);
  const enter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onEnter || event.key !== "Enter" || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement) || event.target.type !== "text") return;
    event.preventDefault();
    event.stopPropagation();
    onEnter();
  };
  return (
    <div ref={root} role="group" aria-labelledby={id} onKeyDown={enter} className="flex flex-col gap-3 p-3.5">
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

type CustomFrom = { start: { rule: RepeatRule; ends: RepeatEnds } | null | undefined; kept: RepeatRule | null; at: string | null; left?: { ends: RepeatEnds; end: string } | null };

function pickAll(field: HTMLInputElement) {
  field.select();
  field.dataset.picked = "";
}

function keepPicked(event: MouseEvent<HTMLInputElement>) {
  if (event.currentTarget.dataset.picked === undefined) return;
  delete event.currentTarget.dataset.picked;
  event.preventDefault();
}

function CustomRepeat({
  from,
  anchor,
  onCancel,
  onSave,
  busy = false,
  resets,
}: {
  from: CustomFrom;
  anchor: string;
  onCancel: () => void;
  onSave: (rule: RepeatRule, ends: RepeatEnds) => void;
  busy?: boolean;
  resets?: (rule: RepeatRule) => string | null;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(from.start, anchor));
  const [shown, setShown] = useState<string | null>(null);
  const update = (change: Partial<Draft>) => {
    setShown(null);
    setDraft((current) => ({ ...current, ...change }));
  };
  const rule = ruleOf(draft, anchor, from.kept);
  const ends = endsOf(draft);
  const ruleProblem = checkRule(rule);
  const problem =
    ruleProblem ??
    (draft.ends === "until" && !draft.until ? "Choose an end date." : checkEnds(ends, anchor, dayKeyAt(new Date()))) ??
    (!from.left && endsOnFirst(ends, anchor) ? ENDS_ON_FIRST : null);
  const pattern: RepeatPattern = { startsOn: anchor, at: from.at, rule: normalRule({ ...rule, interval: Math.max(1, rule.interval || 1) }), ends: problem ? { never: true } : ends };
  const interval = Math.max(1, rule.interval || 1);
  const week = monthWeekOf(anchor);
  const kept = keptMonthly(from.kept);
  const left = draft.ends === "count" ? countLeft(from.left, draft.count) : null;
  const times = "count" in ends && ends.count === 1 ? "time" : "times";
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
      onEnter={save}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel} className="hit">
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={save} className="hit">
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
            onFocus={(event) => pickAll(event.currentTarget)}
            onMouseUp={keepPicked}
            onChange={(event) => update({ interval: event.target.value })}
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
          <div className="flex flex-wrap gap-1.5 [@media(pointer:coarse)]:gap-3">
            {WEEKDAYS.map((day, index) => {
              const on = draft.weekdays.includes(day);
              return (
                <Button
                  key={day}
                  variant="ghost"
                  size="none"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[index]}
                  onClick={() => update({ weekdays: on ? draft.weekdays.filter((item) => item !== day) : [...draft.weekdays, day] })}
                  className={cn(
                    "caption-style hit size-8 font-medium focus-visible:ring-(--primary) active:scale-100",
                    on ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground" : "border-line-strong text-soft border hover:bg-white/[0.06] hover:text-soft",
                  )}
                >
                  {DAY_LETTERS[index]}
                </Button>
              );
            })}
          </div>
        </div>
      )}
      {draft.freq === "monthly" && (
        <fieldset className="flex flex-col gap-2 [@media(pointer:coarse)]:gap-4">
          <legend className="caption-style text-subtle mb-1.5">Monthly on</legend>
          <label className="ui-style hit flex items-center gap-2">
            <Radio name={`${id}-monthly`} checked={draft.monthly === "day"} onChange={() => update({ monthly: "day" })} />
            {monthlyLabel("day", anchor, from.kept)}
          </label>
          {(week.n !== -1 || kept === "week") && (
            <label className="ui-style hit flex items-center gap-2">
              <Radio name={`${id}-monthly`} checked={draft.monthly === "week"} onChange={() => update({ monthly: "week" })} />
              {monthlyLabel("week", anchor, from.kept)}
            </label>
          )}
          {(isLastWeekOfMonth(anchor) || kept === "last") && (
            <label className="ui-style hit flex items-center gap-2">
              <Radio name={`${id}-monthly`} checked={draft.monthly === "last"} onChange={() => update({ monthly: "last" })} />
              {monthlyLabel("last", anchor, from.kept)}
            </label>
          )}
        </fieldset>
      )}
      <fieldset className="flex flex-col gap-2 [@media(pointer:coarse)]:gap-3">
        <legend className="caption-style text-subtle mb-1.5">Ends</legend>
        <label className="ui-style hit flex min-h-8 items-center gap-2">
          <Radio name={`${id}-ends`} checked={draft.ends === "never"} onChange={() => update({ ends: "never" })} />
          Never
        </label>
        <div className="ui-style flex min-h-8 items-center gap-2">
          <label className="hit flex items-center gap-2">
            <Radio name={`${id}-ends`} checked={draft.ends === "count"} onChange={() => update({ ends: "count" })} />
            After
          </label>
          <Input
            aria-label="Times"
            inputMode="numeric"
            value={draft.count}
            onFocus={(event) => pickAll(event.currentTarget)}
            onMouseUp={keepPicked}
            onChange={(event) => update({ ends: "count", count: event.target.value })}
            className="w-16 tabular-nums"
          />
          <span>{times}</span>
          {left !== null && <span className="caption-style text-subtle">{left} more</span>}
        </div>
        <div className="ui-style flex min-h-8 items-center gap-2">
          <label className="hit flex items-center gap-2">
            <Radio name={`${id}-ends`} checked={draft.ends === "until"} onChange={() => update({ ends: "until" })} />
            On
          </label>
          <DatePicker id={`${id}-until-date`} aria-label="End date" placeholder="Choose a date" value={draft.until} onChange={(value) => update({ ends: "until", until: value })} className="w-auto" />
        </div>
      </fieldset>
      {!ruleProblem && (
        <p className="caption-style text-soft flex items-start gap-2 rounded-lg bg-white/[0.04] px-2.5 py-2">
          <RepeatIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-purple-text)" />
          <span>{[repeatSummary(pattern), resets ? resets(pattern.rule) : null].filter(Boolean).join(" ")}</span>
        </p>
      )}
      {shown && (
        <p role="alert" className="caption-style text-danger">
          {shown}
        </p>
      )}
    </Panel>
  );
}

function EndOnDate({ task, onCancel, onSave, busy = false }: { task: Task; onCancel: () => void; onSave: (until: string) => void; busy?: boolean }) {
  const id = useId();
  const repeat = task.repeat!;
  const [until, setUntil] = useState(() => ("until" in repeat.ends ? repeat.ends.until : ""));
  const from = task.occursOn ?? anchorOf(task);
  const pattern: RepeatPattern = { startsOn: repeat.startsOn, at: repeat.at, rule: repeat.rule, ends: until ? { until } : { never: true } };
  const days = until && until >= from ? occurrenceDays(pattern, shiftDay(from, 1), until, 5000).filter((day) => !repeat.skippedDates.includes(day)) : null;
  const left = days ? days.length : null;
  const lastDay = days && days.length > 0 ? days[days.length - 1] : from;
  const problem = until && until < from ? "The end date is before this one." : null;
  return (
    <Panel
      title="End on a date"
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel} className="hit">
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={busy || !until || Boolean(problem)} onClick={() => onSave(until)} className="hit">
            Save
          </Button>
        </>
      }
    >
      <DatePicker id={`${id}-until`} aria-label="Last day" placeholder="Choose a date" value={until} onChange={setUntil} />
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

function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']")];
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  for (const item of items) item.tabIndex = -1;
  items[next].tabIndex = 0;
  items[next].focus();
}

function RepeatChoices({
  presets,
  current,
  repeating,
  onDontRepeat,
  onPick,
  onCustom,
  summary,
  children,
}: {
  presets: ReturnType<typeof repeatPresets>;
  current: RepeatRule | null;
  repeating: boolean;
  onDontRepeat: () => void;
  onPick: (rule: RepeatRule) => void;
  onCustom: () => void;
  summary?: string | null;
  children?: ReactNode;
}) {
  const matched = current ? presets.find((preset) => sameRepeat(preset.rule, current)) : null;
  const custom = Boolean(current && !matched);
  const active = menuFocus(repeating, matched?.id ?? null, custom);
  return (
    <>
      {summary && <p className="caption-style text-soft px-3 pt-2.5 pb-1 md:hidden">{summary}</p>}
      <div role="menu" aria-label="Repeat" onKeyDown={moveFocus} className="flex flex-col p-1">
      <MenuOption checked={!repeating} active={active === "none"} onSelect={onDontRepeat}>
        Don&apos;t repeat
      </MenuOption>
      {presets.map((preset) => (
        <MenuOption key={preset.id} checked={matched?.id === preset.id} active={active === preset.id} onSelect={() => onPick(preset.rule)}>
          {preset.label}
        </MenuOption>
      ))}
      <span aria-hidden className="bg-line-strong mx-1 my-1 h-px" />
      <MenuOption checked={custom} active={active === "custom"} onSelect={onCustom} detail={null} icon={custom ? <CheckIcon aria-hidden className="size-3.5" /> : null}>
        <span className="flex items-center justify-between gap-2">
          Custom
          <ChevronRightIcon aria-hidden className="text-subtle size-3" />
        </span>
      </MenuOption>
      {children}
      </div>
    </>
  );
}

export type RepeatDraft = { rule: RepeatRule; ends: RepeatEnds };

export function RepeatPicker({
  anchor,
  at,
  value,
  onChange,
  trigger,
  align = "start",
  onClosed,
}: {
  anchor: string;
  at: string | null;
  value: RepeatDraft | null;
  onChange: (value: RepeatDraft | null) => void;
  trigger: ReactNode;
  align?: "start" | "end";
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "custom">("menu");
  const close = () => setOpen(false);
  const choose = (next: RepeatDraft | null) => {
    close();
    onChange(next);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setView("menu");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        className="max-h-[min(var(--radix-popover-content-available-height),36rem)] w-[min(19rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain [@media(pointer:coarse)]:w-[min(22rem,calc(100vw-2rem))]"
        onCloseAutoFocus={(event) => {
          if (!onClosed) return;
          event.preventDefault();
          onClosed();
        }}
      >
        {view === "menu" && (
          <RepeatChoices
            presets={repeatPresets(anchor, value ? { rule: value.rule, startsOn: anchor } : null)}
            current={value?.rule ?? null}
            repeating={Boolean(value)}
            onDontRepeat={() => choose(null)}
            onPick={(rule) => choose({ rule, ends: value?.ends ?? { never: true } })}
            onCustom={() => setView("custom")}
            summary={value ? repeatSummary({ startsOn: anchor, at, rule: value.rule, ends: value.ends }) : null}
          />
        )}
        {view === "custom" && <CustomRepeat from={{ start: value, kept: value?.rule ?? null, at }} anchor={anchor} onCancel={close} onSave={(rule, ends) => choose({ rule, ends })} />}
      </PopoverContent>
    </Popover>
  );
}

function repeatWords(task: Task) {
  const repeat = task.repeat;
  return repeat ? `${repeat.text}${repeat.end ? `, ${repeat.end}` : ""}` : "";
}

export function RepeatMenu({ task, trigger, align = "start", onDeleted }: { task: Task; trigger: ReactNode; align?: "start" | "end"; onDeleted?: () => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [picked, setPicked] = useState<{ rule: RepeatRule; label: string } | null>(null);
  const shownAt = useRef(0);
  const actions = useRepeatActions(task, onDeleted);
  const anchor = anchorOf(task);
  const repeating = isRepeating(task);
  const series = Boolean(task.repeat?.current && !task.completedAt);
  const presets = repeatPresets(anchor, task.repeat && !task.repeat.ended ? { rule: task.repeat.rule, startsOn: task.repeat.startsOn } : null);
  const current = task.repeat && !task.repeat.ended ? task.repeat.rule : null;
  const keptEnds: RepeatEnds = task.repeat && !task.repeat.ended ? task.repeat.ends : { never: true };
  const show = (next: View) => {
    shownAt.current += 1;
    setView(next);
  };
  const close = () => {
    shownAt.current += 1;
    setOpen(false);
  };
  const settle = async (work: () => Promise<boolean>) => {
    const shown = shownAt.current;
    if ((await work()) && shownAt.current === shown) close();
  };
  const pick = (rule: RepeatRule) => {
    if (current && sameRepeat(current, rule)) {
      close();
      return;
    }
    if (changeWarning(task, rule)) {
      setPicked({ rule, label: presets.find((preset) => sameRepeat(preset.rule, rule))?.label ?? "Repeat" });
      show("resets");
      return;
    }
    void settle(() => actions.set(rule));
  };
  const saveCustom = (rule: RepeatRule, ends: RepeatEnds) => {
    const keepsEnd = Boolean(current) && sameEnds(keptEnds, ends);
    if (current && keepsEnd && sameRepeat(current, rule)) {
      close();
      return;
    }
    const kept = current && sameRepeat(current, rule) ? current : rule;
    void settle(() => actions.set(kept, keepsEnd ? undefined : ends));
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        shownAt.current += 1;
        setOpen(next);
        if (next) setView("menu");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="max-h-[min(var(--radix-popover-content-available-height),36rem)] w-[min(19rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain [@media(pointer:coarse)]:w-[min(22rem,calc(100vw-2rem))]">
        {view === "menu" && (
          <RepeatChoices
            presets={presets}
            current={current}
            repeating={repeating}
            onDontRepeat={() => (repeating ? show("stop") : close())}
            onPick={pick}
            onCustom={() => show("custom")}
          >
            {repeating && series && (
              <>
                <span aria-hidden className="bg-line-strong mx-1 my-1 h-px" />
                <MenuOption
                  icon={<RepeatIcon aria-hidden className="text-subtle size-3.5" />}
                  detail={nextDetail(task.repeat?.next)}
                  onSelect={() => {
                    close();
                    void actions.skip();
                  }}
                >
                  Skip this one
                </MenuOption>
                <MenuOption icon={<XIcon aria-hidden className="text-subtle size-3" />} onSelect={() => show("stop")}>
                  Stop repeating
                </MenuOption>
                <MenuOption icon={<CalendarIcon aria-hidden className="text-subtle size-3.5" />} onSelect={() => show("end")}>
                  End on a date
                </MenuOption>
                <MenuOption danger onSelect={() => show("delete")}>
                  Delete the series
                </MenuOption>
              </>
            )}
          </RepeatChoices>
        )}
        {view === "custom" && (
          <CustomRepeat
            from={{ start: task.repeat, kept: task.repeat && !task.repeat.ended ? task.repeat.rule : null, at: atOf(task), left: task.repeat && !task.repeat.ended ? task.repeat : null }}
            anchor={anchor}
            busy={actions.busy}
            onCancel={close}
            onSave={saveCustom}
            resets={(rule) => changeWarning(task, rule)}
          />
        )}
        {view === "resets" && picked && (
          <Panel
            title={picked.label}
            onClose={close}
            footer={
              <>
                <Button variant="secondary" size="sm" onClick={close} className="hit">
                  Cancel
                </Button>
                <Button variant="primary" size="sm" disabled={actions.busy} onClick={() => void settle(() => actions.set(picked.rule))} className="hit">
                  Save
                </Button>
              </>
            }
          >
            <p className="ui-style text-soft">{changeWarning(task, picked.rule)}</p>
          </Panel>
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
                <Button variant="primary" size="sm" disabled={actions.busy} onClick={() => void settle(actions.stop)} className="hit">
                  Stop repeating
                </Button>
              </>
            }
          >
            <p className="ui-style text-soft">This one stays. Nothing after it.</p>
          </Panel>
        )}
        {view === "end" && task.repeat && (
          <EndOnDate task={task} busy={actions.busy} onCancel={close} onSave={(until) => void settle(() => actions.end(until))} />
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
                <HoldButton onConfirm={() => void settle(actions.remove)} className="[@media(pointer:coarse)]:h-11">
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

export function RepeatField({ task, canChange, layout, onDeleted }: { task: Task; canChange: boolean; layout: "panel" | "row"; onDeleted?: () => void }) {
  const repeat = task.repeat;
  const live = Boolean(repeat && repeat.current && !task.completedAt);
  const stopped = live && repeat!.ended && !repeat!.next;
  const halted = stopped && !("never" in repeat!.ends) && !repeat!.end;
  const words = live && !stopped ? repeatWords(task) : null;
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
    <Button
      variant="chip"
      size="none"
      aria-label={words ? `Repeat: ${words}. Change` : "Repeat"}
      className={cn(CHIP, "hit", !words && "text-subtle", words && "h-auto min-h-7 py-1.5 text-left leading-snug whitespace-normal")}
    >
      <RepeatIcon aria-hidden className={cn("size-3.5 shrink-0", words && "text-(--tag-purple-text)")} />
      {words ? <span className="min-w-0">{words}</span> : layout === "panel" && <span>Repeat</span>}
    </Button>
  );
  return (
    <>
      <RepeatMenu task={task} trigger={trigger} onDeleted={onDeleted} />
      {next && <span className="caption-style text-subtle">Next: {next}</span>}
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

export function useRepeatScope(task: Task) {
  const [asking, setAsking] = useState<{ change: ScopeChange; resolve: (scope: ScopeAnswer<RepeatScope>) => void } | null>(null);
  const [choice, setChoice] = useState<RepeatScope>("this");
  const latest = useRef(asking);
  useEffect(
    () => () => {
      latest.current?.resolve(SCOPE_LATER);
      latest.current = null;
    },
    [],
  );
  const home = useRef<HTMLSpanElement>(null);
  const ask = useCallback((change: ScopeChange) => {
    latest.current?.resolve(null);
    setChoice("this");
    return new Promise<ScopeAnswer<RepeatScope>>((resolve) => {
      const pending = { change, resolve };
      latest.current = pending;
      setAsking(pending);
    });
  }, []);
  const finish = (scope: RepeatScope | null) => {
    asking?.resolve(scope);
    if (latest.current === asking) latest.current = null;
    setAsking(null);
  };
  const texts = asking ? scopeTexts(task, asking.change) : null;
  const name = useId();
  const dialog = (
    <Dialog open={Boolean(asking)} onOpenChange={(open) => !open && finish(null)}>
      <DialogContent
        className="max-w-[420px]"
        onCloseAutoFocus={() => {
          window.requestAnimationFrame(() => {
            const active = document.activeElement;
            if (active && active !== document.body) return;
            const area = home.current?.parentElement?.closest<HTMLElement>("[role='dialog'], [data-task-id]");
            const target = area?.querySelector<HTMLElement>("button[aria-label='Edit title']") ?? area;
            target?.focus({ preventScroll: true });
          });
        }}
      >
        <DialogHeader className="pr-12">
          <DialogTitle className="flex min-w-0 gap-1">
            <span className="truncate">{task.title}</span>
            <span className="shrink-0">repeats</span>
          </DialogTitle>
          <DialogDescription>{texts?.line}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            finish(choice);
          }}
        >
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
          <Button type="submit" variant="primary" size="md" className="hit">
            Save
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
      <span ref={home} hidden />
    </Dialog>
  );
  return { ask, dialog };
}
