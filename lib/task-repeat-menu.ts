import { clockLabel, taskDueDay } from "@/lib/crm/task-time";
import type { Task, TaskWrite } from "@/lib/crm/types";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { DAY_NAMES, monthWeekOf, repeatInputOf, sameRule, shortDay, weekdayOf, WEEKDAYS, type MonthWeek, type RepeatEnds, type RepeatFreq, type RepeatInput, type RepeatRule, type Weekday } from "@/lib/task-repeat";

export const REPEAT_SAVE_FAILED = "Couldn't save the repeat. Try again.";
export const SKIP_FAILED = "Couldn't skip this one. Try again.";
export const STOP_FAILED = "Couldn't stop repeating. Try again.";
export const END_FAILED = "Couldn't save the end date. Try again.";
export const DELETE_FAILED = "Couldn't delete the series. Try again.";
export const MOVE_FAILED = "Couldn't move it. Try again.";
export const ENDS_ON_FIRST = "That ends on the first one. Choose a later end.";
const ORDINAL_WORDS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

type NextDate = { dueAt: string; dueHasTime: boolean; occursOn: string };

export function nextDay(next: NextDate) {
  return taskDueDay(next.dueAt) ?? next.occursOn;
}

export function nextLabel(next: NextDate | null | undefined) {
  if (!next) return null;
  const day = nextDay(next);
  return next.dueHasTime ? `${shortDay(day)}, ${clockLabel(next.dueAt)}` : shortDay(day);
}

export function nextDetail(next: NextDate | null | undefined) {
  return next ? `Next: ${shortDay(nextDay(next))}` : null;
}

export function skippedMessage(task: Pick<Task, "dueAt" | "dueHasTime" | "occursOn"> | null | undefined) {
  const moved = task?.dueAt ? nextLabel({ dueAt: task.dueAt, dueHasTime: task.dueHasTime, occursOn: task.occursOn ?? "" }) : null;
  return moved ? `Skipped. Moved to ${moved}.` : "Skipped.";
}

export function isRepeating(task: Task) {
  return Boolean(task.repeat && task.repeat.current && !task.completedAt && !task.repeat.ended);
}

export function runsSeries(task: Task, viewerId: string | null | undefined) {
  return isRepeating(task) && !task.archivedAt && Boolean(viewerId) && (task.repeat?.ownerId === viewerId || task.repeat?.creatorId === viewerId);
}

export function ownsRepeat(task: Task, viewerId: string | null | undefined) {
  if (!task.repeat || task.repeat.ended) return true;
  return Boolean(viewerId) && (task.repeat.ownerId === viewerId || task.repeat.creatorId === viewerId);
}

export function skipsBesideRepeat(task: Task, viewerId: string | null | undefined, canChange: boolean) {
  return canChange && isRepeating(task) && !task.archivedAt && !ownsRepeat(task, viewerId);
}

export function anchorOf(task: Task) {
  if (task.repeat?.current && !task.completedAt && task.occursOn) return task.occursOn;
  return task.dueDate ?? taskDueDay(task.dueAt) ?? dayKeyAt(new Date());
}

export type Draft = {
  interval: string;
  freq: RepeatFreq;
  weekdays: Weekday[];
  monthly: "day" | "week" | "last";
  ends: "never" | "count" | "until";
  count: string;
  until: string;
};

export function draftOf(repeat: { rule: RepeatRule; ends: RepeatEnds } | null | undefined, anchor: string): Draft {
  const rule = repeat?.rule;
  const ends = repeat?.ends;
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

export function keptMonthly(original: RepeatRule | null) {
  if (original?.freq !== "monthly") return null;
  return original.monthWeek ? (original.monthWeek.n === -1 ? "last" : "week") : "day";
}

function anchorDay(anchor: string) {
  return Number(anchor.slice(8, 10));
}

export function monthlyChoice(kind: Draft["monthly"], anchor: string, original: RepeatRule | null): { monthDay: number } | { monthWeek: MonthWeek } {
  if (keptMonthly(original) === kind && original) {
    if (original.monthWeek) return { monthWeek: original.monthWeek };
    return { monthDay: original.monthDay ?? anchorDay(anchor) };
  }
  if (kind === "day") return { monthDay: anchorDay(anchor) };
  if (kind === "last") return { monthWeek: { n: -1, weekday: weekdayOf(anchor) } };
  const week = monthWeekOf(anchor);
  return { monthWeek: week.n === -1 ? { n: 4, weekday: weekdayOf(anchor) } : week };
}

export function monthlyLabel(kind: Draft["monthly"], anchor: string, original: RepeatRule | null) {
  const choice = monthlyChoice(kind, anchor, original);
  if ("monthDay" in choice) return `Day ${choice.monthDay}`;
  const name = DAY_NAMES[WEEKDAYS.indexOf(choice.monthWeek.weekday)];
  return `The ${ORDINAL_WORDS[choice.monthWeek.n]} ${name}`;
}

function wholeNumber(text: string) {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN;
}

export function ruleOf(draft: Draft, anchor: string, original: RepeatRule | null = null): RepeatRule {
  const interval = wholeNumber(draft.interval);
  const base: RepeatRule = { freq: draft.freq, interval: Number.isInteger(interval) ? interval : 0 };
  if (draft.freq === "weekly") base.weekdays = draft.weekdays;
  if (draft.freq === "monthly") Object.assign(base, monthlyChoice(draft.monthly, anchor, original));
  return base;
}

export function endsOf(draft: Draft): RepeatEnds {
  if (draft.ends === "count") return { count: wholeNumber(draft.count) };
  if (draft.ends === "until") return { until: draft.until };
  return { never: true };
}

export function patternInputOf(rule: RepeatRule): RepeatInput {
  const input = repeatInputOf(rule, { never: true });
  delete input.ends;
  return input;
}

export function sameEnds(left: RepeatEnds, right: RepeatEnds) {
  if ("never" in left || "never" in right) return "never" in left && "never" in right;
  if ("count" in left || "count" in right) return "count" in left && "count" in right && left.count === right.count;
  return left.until === right.until;
}

function everyDayOf(rule: RepeatRule): RepeatRule {
  return rule.freq === "weekly" && rule.interval === 1 && WEEKDAYS.every((day) => rule.weekdays?.includes(day)) ? { freq: "daily", interval: 1 } : rule;
}

export function sameRepeat(left: RepeatRule, right: RepeatRule) {
  return sameRule(everyDayOf(left), everyDayOf(right));
}

export function endsOnFirst(ends: RepeatEnds, anchor: string) {
  return ("count" in ends && ends.count === 1) || ("until" in ends && ends.until === anchor);
}

export function countLeft(repeat: { ends: RepeatEnds; end: string } | null | undefined, draftCount: string) {
  if (!repeat || !("count" in repeat.ends)) return null;
  const found = /^(\d+) more$/.exec(repeat.end);
  const wanted = wholeNumber(draftCount);
  if (!found || !Number.isInteger(wanted) || wanted < 1) return null;
  return Math.max(0, Number(found[1]) + wanted - repeat.ends.count);
}

export type ScopeChange = { kind: "time" | "untime" | "title" | "description" | "assignee" | "duration" | "reminder"; to?: string };

type DetailsWrite = Pick<TaskWrite, "title" | "description" | "dueAt" | "dueDate" | "dueHasTime" | "remindMinutes" | "durationMinutes">;

export function scopeChange(task: Task, write: DetailsWrite): ScopeChange | null {
  if (!isRepeating(task)) return null;
  if (write.title !== undefined) return { kind: "title" };
  if (write.description !== undefined) return { kind: "description" };
  const currentDay = task.dueDate ?? taskDueDay(task.dueAt);
  if (write.dueAt) {
    const sameDay = taskDueDay(write.dueAt) === currentDay;
    if (sameDay && (!task.dueHasTime || !task.dueAt || clockLabel(write.dueAt) !== clockLabel(task.dueAt))) return { kind: "time", to: clockLabel(write.dueAt) };
  }
  if (write.dueDate && write.dueAt === undefined && task.dueHasTime && write.dueDate === currentDay) return { kind: "untime" };
  if (write.durationMinutes !== undefined) return { kind: "duration" };
  if (write.remindMinutes !== undefined && write.dueAt === undefined && write.dueDate === undefined) return { kind: "reminder" };
  return null;
}

export function waitsForScope(task: Task, viewerId: string | null | undefined, write: DetailsWrite) {
  return ownsRepeat(task, viewerId) && scopeChange(task, write) !== null;
}

const CHANGE_LINES: Record<Exclude<ScopeChange["kind"], "time" | "untime">, string> = {
  title: "Renaming.",
  description: "Changing the description.",
  assignee: "Reassigning.",
  duration: "Changing the length.",
  reminder: "Changing the reminder.",
};

export function scopeTexts(task: Task, change: ScopeChange, today = dayKeyAt(new Date())) {
  const day = taskDueDay(task.dueAt) ?? task.occursOn ?? anchorOf(task);
  const own = day === today ? "today's" : shortDay(day);
  const ownCapital = day === today ? "Today" : shortDay(day);
  const next = task.repeat?.next ? nextDay(task.repeat.next) : null;
  const nextName = next ? (next === shiftDay(today, 1) ? "Tomorrow" : shortDay(next)) : null;
  const backAt = nextName && task.repeat?.at ? ` ${nextName} is back at ${task.repeat.at}.` : "";
  const changed = task.repeat?.changedDates ?? 0;
  const resets = changed > 0 ? ` Resets ${changed} changed date${changed === 1 ? "" : "s"}.` : "";
  if (change.kind === "time") {
    return { line: `Moving ${own} to ${change.to}.`, one: `Only ${own} moves.${backAt}`, all: `${ownCapital} and every later one move to ${change.to}.${resets}` };
  }
  if (change.kind === "untime") {
    return { line: `Removing the time from ${own}.`, one: `Only ${own} loses its time.${backAt}`, all: `${ownCapital} and every later one lose the time.${resets}` };
  }
  return { line: CHANGE_LINES[change.kind], one: `Only ${own} changes.`, all: `${ownCapital} and every later one change.` };
}

export const SCOPE_LATER = "later";

export type ScopeAnswer<Scope extends string> = Scope | null | typeof SCOPE_LATER;

export function menuFocus(repeating: boolean, matchedId: string | null, custom: boolean) {
  if (!repeating) return "none";
  if (matchedId) return matchedId;
  return custom ? "custom" : "none";
}

export function newActionKey() {
  return globalThis.crypto.randomUUID();
}
