import { wallMinutes } from "@/lib/calendar-view";
import { taskKind } from "@/lib/crm/task-kind";
import { DEFAULT_TASK_DURATION, clockLabel, isTaskDuration, taskDueDay } from "@/lib/crm/task-time";
import type { Task } from "@/lib/crm/types";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { isBlockOverdue } from "@/lib/task-blocks";
import { reasonPhrase, slotScore } from "@/lib/learned-times";
import { appTimeZone } from "@/lib/time";
import {
  DEFAULT_START_MINUTES,
  DEFAULT_WORKING_HOURS,
  hoursText,
  nextWorkableDay,
  offDayReason,
  offDayText,
  wallAt,
  workingDay,
  workingWindow,
  type WorkingHours,
} from "@/lib/working-hours";

export type PlanGroup = "call" | "email" | "other";

export const PLAN_DAYS = 14;
export const PLAN_STEP_MINUTES = 5;
export const MEETING_GAP_MINUTES = 5;
export const RUN_MAX_TASKS = 6;
export const RUN_MAX_MINUTES = 90;
export const RUN_BREAK_MINUTES = 15;
export const LOOK_BEYOND_DAYS = 30;
export const MAX_SUGGESTED_MINUTES = 240;
export const MAX_SCHEDULE_ENTRIES = 100;

const OUTSIDE_EARLIEST = 7 * 60;
const OUTSIDE_LATEST = 22 * 60;
const MINUTE = 60_000;
const STEP = PLAN_STEP_MINUTES * MINUTE;
const NOT_BLOCKING = new Set(["free", "workingelsewhere"]);
const GROUP_RANK: Record<PlanGroup, number> = { call: 0, email: 1, other: 2 };
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

export type PlanPreference = { from: number; to: number; learned: boolean; slots?: number[] | null };
export type PlanPreferences = Record<PlanGroup, PlanPreference | null>;

export const DEFAULT_PLAN_PREFERENCES: PlanPreferences = {
  call: { from: 10 * 60 + 30, to: 12 * 60 + 30, learned: false },
  email: { from: 13 * 60, to: 15 * 60 + 30, learned: false },
  other: null,
};

export type PlanTask = Pick<
  Task,
  "id" | "workspaceId" | "title" | "dueAt" | "dueHasTime" | "durationMinutes" | "scheduledBy" | "priority" | "completedAt" | "archivedAt" | "ownerId" | "createdAt"
>;

export type PlanMeeting = {
  subject?: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  showAs: string | null;
  myResponse?: string | null;
};

export type PlanOrderItem = { id: string; group: PlanGroup; minutes: number | null };

export type PlanEntry = {
  taskId: string;
  workspaceId: string;
  title: string;
  group: PlanGroup;
  at: string;
  durationMinutes: number;
  suggested: boolean;
  moveDay: string | null;
};

export type PlanOverdue = {
  taskId: string;
  workspaceId: string;
  title: string;
  group: PlanGroup;
  dueAt: string;
  dueHasTime: boolean;
  at: string | null;
  durationMinutes: number;
  suggested: boolean;
};

export type PlanMiss = {
  taskId: string;
  workspaceId: string;
  title: string;
  group: PlanGroup;
  durationMinutes: number;
  suggested: boolean;
  day: string | null;
  reason: string;
  nextFree: string | null;
  outside: string | null;
};

export type PlanProposal = {
  from: string;
  to: string;
  placed: PlanEntry[];
  overdue: PlanOverdue[];
  unplaced: PlanMiss[];
  reason: string | null;
  ordering: PlanOrderItem[];
  replan: boolean;
};

export type PackInput = {
  tasks: PlanTask[];
  meetings: PlanMeeting[];
  viewerId: string;
  now: number;
  hours?: WorkingHours;
  timeZone?: string;
  replan?: boolean;
  ordering?: PlanOrderItem[] | null;
  preferences?: PlanPreferences;
  days?: number;
  keep?: PlanKeep[] | null;
};

export type PlanKeep = { taskId: string; at: string; durationMinutes: number; moveDay?: string | null };

type Interval = { start: number; end: number };
type Run = { group: PlanGroup; day: string; start: number; end: number; count: number; minutes: number };
type Item = { task: PlanTask; group: PlanGroup; minutes: number; suggested: boolean; day: string | null };

export function planGroup(title: string | null | undefined): PlanGroup {
  const kind = taskKind(title);
  if (kind === "call" || kind === "meeting") return "call";
  return kind === "email" ? "email" : "other";
}

export function isPlanGroup(value: unknown): value is PlanGroup {
  return value === "call" || value === "email" || value === "other";
}

export function meetingBlocksPlan(meeting: PlanMeeting) {
  if (meeting.isAllDay) return false;
  if ((meeting.myResponse ?? "").toLowerCase() === "declined") return false;
  return !NOT_BLOCKING.has((meeting.showAs ?? "busy").toLowerCase());
}

export function planDayLabel(key: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${key}T12:00:00Z`))
    .replace(",", "");
}

export function gapWords(minutes: number) {
  return minutes % 60 === 0 ? `${minutes / 60} hour` : `${minutes} minute`;
}

function suggestedMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value / PLAN_STEP_MINUTES) * PLAN_STEP_MINUTES;
  return Math.min(MAX_SUGGESTED_MINUTES, Math.max(PLAN_STEP_MINUTES, rounded));
}

function dueOrder(task: PlanTask) {
  return task.dueAt ? new Date(task.dueAt).getTime() : Number.POSITIVE_INFINITY;
}

export function fallbackOrdering(tasks: PlanTask[]): PlanOrderItem[] {
  return [...tasks]
    .map((task) => ({ task, group: planGroup(task.title) }))
    .sort(
      (left, right) =>
        GROUP_RANK[left.group] - GROUP_RANK[right.group] ||
        dueOrder(left.task) - dueOrder(right.task) ||
        (PRIORITY_RANK[left.task.priority] ?? 1) - (PRIORITY_RANK[right.task.priority] ?? 1) ||
        left.task.createdAt.localeCompare(right.task.createdAt) ||
        left.task.title.localeCompare(right.task.title),
    )
    .map(({ task, group }) => ({ id: task.id, group, minutes: null }));
}

export function settleOrdering(tasks: PlanTask[], ordering: PlanOrderItem[] | null | undefined): PlanOrderItem[] {
  const known = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const settled: PlanOrderItem[] = [];
  for (const item of Array.isArray(ordering) ? ordering : []) {
    if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
    const task = known.get(item.id);
    if (!task) continue;
    seen.add(item.id);
    settled.push({ id: item.id, group: isPlanGroup(item.group) ? item.group : planGroup(task.title), minutes: suggestedMinutes(item.minutes) });
  }
  for (const item of fallbackOrdering(tasks)) {
    if (!seen.has(item.id)) settled.push(item);
  }
  return settled;
}

function itemFor(task: PlanTask, order: PlanOrderItem): Omit<Item, "day"> {
  const own = isTaskDuration(task.durationMinutes) ? task.durationMinutes : DEFAULT_TASK_DURATION;
  const suggestion = own === DEFAULT_TASK_DURATION && order.minutes !== null && order.minutes !== own ? order.minutes : null;
  return { task, group: order.group, minutes: suggestion ?? own, suggested: suggestion !== null };
}

function overlaps(left: Interval, right: Interval) {
  return left.start < right.end && right.start < left.end;
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

const REASON_NOUNS: Record<PlanGroup, string> = { call: "Calls", email: "Emails", other: "Other tasks" };
const DEFAULT_PHRASES: Record<"call" | "email", string> = { call: "late morning", email: "after lunch" };

export function preferenceScore(preference: PlanPreference | null, start: number, minutes: number, timeZone = appTimeZone()) {
  if (!preference) return 0;
  if (preference.slots && preference.slots.length > 0) return slotScore(preference.slots, start, minutes, timeZone);
  const wall = wallMinutes(start, timeZone);
  const latest = Math.max(preference.from, preference.to - minutes);
  if (wall < preference.from) return preference.from - wall;
  if (wall > latest) return wall - latest;
  return 0;
}

function joinPhrases(parts: string[]) {
  const lowered = parts.map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1)));
  return lowered.length > 1 ? `${lowered.slice(0, -1).join(", ")} and ${lowered[lowered.length - 1]}` : lowered[0];
}

export function planReason(
  placed: Pick<PlanEntry, "group" | "suggested" | "at" | "durationMinutes">[],
  preferences: PlanPreferences = DEFAULT_PLAN_PREFERENCES,
  timeZone = appTimeZone(),
) {
  const sentences: string[] = [];
  const defaults: string[] = [];
  const learned: string[] = [];
  for (const group of ["call", "email", "other"] as const) {
    const preference = preferences[group];
    const entries = placed.filter((entry) => entry.group === group);
    if (!preference || entries.length === 0) continue;
    if (!preference.learned) {
      if (group !== "other") defaults.push(`${REASON_NOUNS[group]} ${DEFAULT_PHRASES[group]}`);
      continue;
    }
    const fits = entries.filter((entry) => preferenceScore(preference, Date.parse(entry.at), entry.durationMinutes, timeZone) === 0).length;
    if (fits === 0 || fits * 2 < entries.length) continue;
    learned.push(`${REASON_NOUNS[group]} ${reasonPhrase((preference.from + preference.to) / 2)}`);
  }
  if (learned.length > 0) sentences.push(`${joinPhrases(learned)}, as you usually do.`);
  if (defaults.length > 0) sentences.push(`${joinPhrases(defaults)} by default.`);
  if (placed.some((entry) => entry.suggested)) sentences.push("Durations in purple are suggested.");
  return sentences.length > 0 ? sentences.join(" ") : null;
}

export function packPlan(input: PackInput): PlanProposal {
  const timeZone = input.timeZone ?? appTimeZone();
  const hours = input.hours ?? DEFAULT_WORKING_HOURS;
  const preferences = input.preferences ?? DEFAULT_PLAN_PREFERENCES;
  const now = input.now;
  const floor = Math.ceil(now / STEP) * STEP;
  const today = dayKeyAt(new Date(now), timeZone);
  const span = input.days ?? PLAN_DAYS;
  const last = shiftDay(today, span);
  const days = Array.from({ length: span + 1 }, (_, index) => shiftDay(today, index));
  const replan = input.replan === true;

  const mine = input.tasks.filter((task) => task.ownerId === input.viewerId && !task.completedAt && !task.archivedAt);
  const ordering = settleOrdering(mine, input.ordering);
  const byId = new Map(mine.map((task) => [task.id, task]));

  const busy: Interval[] = [];
  for (const meeting of input.meetings) {
    if (!meetingBlocksPlan(meeting)) continue;
    const start = new Date(meeting.startsAt).getTime();
    const end = new Date(meeting.endsAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    busy.push({ start, end: end + MEETING_GAP_MINUTES * MINUTE });
  }

  const dated: Item[] = [];
  const undated: Item[] = [];
  const overdueItems: Item[] = [];
  const replanned: (Item & { original: Interval })[] = [];
  const fixed: { group: PlanGroup; day: string; interval: Interval }[] = [];
  const keeps = new Map<string, PlanKeep>();
  for (const item of Array.isArray(input.keep) ? input.keep : []) {
    const start = Date.parse(item?.at);
    if (!item || typeof item.taskId !== "string" || Number.isNaN(start) || !isTaskDuration(item.durationMinutes) || start + MINUTE < now) continue;
    keeps.set(item.taskId, { taskId: item.taskId, at: iso(start), durationMinutes: item.durationMinutes, moveDay: typeof item.moveDay === "string" ? item.moveDay : null });
  }
  const keepFor = (item: Item, sameDayOnly = false) => {
    const keep = keeps.get(item.task.id);
    if (!keep) return null;
    const day = taskDueDay(keep.at, timeZone);
    if (item.day && day !== item.day && (sameDayOnly || keep.moveDay !== day)) return null;
    return keep;
  };
  const keptItems: { item: Item; keep: PlanKeep }[] = [];
  const keepOr = (item: Item, bucket: Item[]) => {
    const keep = keepFor(item);
    if (keep) keptItems.push({ item: { ...item, minutes: keep.durationMinutes, day: taskDueDay(keep.at, timeZone) }, keep });
    else bucket.push(item);
  };
  for (const order of ordering) {
    const task = byId.get(order.id)!;
    const base = itemFor(task, order);
    if (!task.dueAt) {
      keepOr({ ...base, day: null }, undated);
      continue;
    }
    if (isBlockOverdue(task, now, timeZone)) {
      overdueItems.push({ ...base, day: taskDueDay(task.dueAt, timeZone) });
      continue;
    }
    const day = taskDueDay(task.dueAt, timeZone);
    if (task.dueHasTime) {
      const start = new Date(task.dueAt).getTime();
      const own = isTaskDuration(task.durationMinutes) ? task.durationMinutes : DEFAULT_TASK_DURATION;
      const original = { start, end: start + own * MINUTE };
      if (replan && task.scheduledBy === "planner" && start > now && day && day <= last) {
        const keep = keepFor({ ...base, day }, true);
        if (keep) keptItems.push({ item: { ...base, minutes: keep.durationMinutes, day: taskDueDay(keep.at, timeZone) }, keep });
        else replanned.push({ ...base, day, original });
        continue;
      }
      busy.push(original);
      if (day) fixed.push({ group: base.group, day, interval: original });
      continue;
    }
    if (day && day >= today && day <= last) keepOr({ ...base, day }, dated);
  }

  const taken: Interval[] = [];
  const held: Interval[] = replanned.map((item) => item.original);
  const runs: Run[] = [];
  const seedRun = (group: PlanGroup, day: string, interval: Interval) => {
    if (group === "other") return;
    const minutes = Math.round((interval.end - interval.start) / MINUTE);
    const joined = runs.find((run) => run.group === group && run.day === day && (run.end === interval.start || run.start === interval.end));
    if (joined) {
      joined.start = Math.min(joined.start, interval.start);
      joined.end = Math.max(joined.end, interval.end);
      joined.count += 1;
      joined.minutes += minutes;
      return;
    }
    runs.push({ group, day, start: interval.start, end: interval.end, count: 1, minutes });
  };
  for (const block of [...fixed].sort((left, right) => left.interval.start - right.interval.start)) seedRun(block.group, block.day, block.interval);
  const placed: PlanEntry[] = [];
  const unplaced: PlanMiss[] = [];

  const free = (interval: Interval) =>
    interval.start >= floor &&
    !busy.some((item) => overlaps(item, interval)) &&
    !taken.some((item) => overlaps(item, interval)) &&
    !held.some((item) => overlaps(item, interval));

  const insideHours = (day: string, interval: Interval) => {
    const window = workingWindow(day, hours, timeZone);
    return Boolean(window && interval.start >= window.open && interval.end <= window.close);
  };

  const runClear = (day: string, group: PlanGroup, interval: Interval, except: Run | null) =>
    runs.every(
      (run) =>
        run === except ||
        run.day !== day ||
        run.group !== group ||
        interval.end + RUN_BREAK_MINUTES * MINUTE <= run.start ||
        interval.start >= run.end + RUN_BREAK_MINUTES * MINUTE,
    );

  const searchWindow = (from: number, to: number, minutes: number, accept: (interval: Interval) => boolean, score?: (start: number) => number) => {
    const length = minutes * MINUTE;
    let best: number | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let start = Math.ceil(Math.max(from, floor) / STEP) * STEP; start + length <= to; start += STEP) {
      const interval = { start, end: start + length };
      if (!free(interval) || !accept(interval)) continue;
      const value = score ? score(start) : 0;
      if (value < bestScore) {
        best = start;
        bestScore = value;
        if (value === 0) break;
      }
    }
    return best;
  };

  const findSlot = (day: string, minutes: number, group: PlanGroup, guardRuns: boolean) => {
    const window = workingWindow(day, hours, timeZone);
    if (!window) return null;
    return searchWindow(
      window.open,
      window.close,
      minutes,
      (interval) => !guardRuns || runClear(day, group, interval, null),
      (start) => preferenceScore(preferences[group], start, minutes, timeZone),
    );
  };

  const commit = (item: Item, start: number) => {
    const interval = { start, end: start + item.minutes * MINUTE };
    taken.push(interval);
    placed.push({
      taskId: item.task.id,
      workspaceId: item.task.workspaceId,
      title: item.task.title,
      group: item.group,
      at: iso(start),
      durationMinutes: item.minutes,
      suggested: item.suggested,
      moveDay: null,
    });
    return interval;
  };

  const extendRun = (item: Item, day: string) => {
    for (const run of runs) {
      if (run.day !== day || run.group !== item.group) continue;
      if (run.count >= RUN_MAX_TASKS || run.minutes + item.minutes > RUN_MAX_MINUTES) continue;
      for (const start of [run.end, run.start - item.minutes * MINUTE]) {
        const interval = { start, end: start + item.minutes * MINUTE };
        const whole = { start: Math.min(run.start, interval.start), end: Math.max(run.end, interval.end) };
        if (!insideHours(day, interval) || !free(interval) || !runClear(day, item.group, whole, run)) continue;
        commit(item, start);
        run.start = whole.start;
        run.end = whole.end;
        run.count += 1;
        run.minutes += item.minutes;
        return true;
      }
    }
    return false;
  };

  const wanted = (item: Item, pending: Item[], day: string) => {
    let minutes = item.minutes;
    let count = 1;
    for (const other of pending) {
      if (other === item || other.group !== item.group || (other.day !== null && other.day !== day)) continue;
      if (count >= RUN_MAX_TASKS || minutes + other.minutes > RUN_MAX_MINUTES) break;
      minutes += other.minutes;
      count += 1;
    }
    return minutes;
  };

  const startRun = (item: Item, day: string, pending: Item[]) => {
    const want = wanted(item, pending, day);
    const start = (want > item.minutes ? findSlot(day, want, item.group, true) : null) ?? findSlot(day, item.minutes, item.group, true);
    if (start === null) return false;
    const interval = commit(item, start);
    runs.push({ group: item.group, day, start: interval.start, end: interval.end, count: 1, minutes: item.minutes });
    return true;
  };

  const placeOn = (item: Item, day: string, pending: Item[]) => {
    if (item.group === "other") {
      const start = findSlot(day, item.minutes, item.group, false);
      if (start === null) return false;
      commit(item, start);
      return true;
    }
    return extendRun(item, day) || startRun(item, day, pending);
  };

  const hold = (start: number | null, minutes: number) => {
    if (start === null) return null;
    taken.push({ start, end: start + minutes * MINUTE });
    return iso(start);
  };

  const nextFreeAfter = (day: string, item: Item) => {
    let next: string | null = day;
    for (let guard = 0; guard < LOOK_BEYOND_DAYS; guard += 1) {
      next = next ? nextWorkableDay(next, hours) : null;
      if (!next) return null;
      const start = findSlot(next, item.minutes, item.group, false);
      if (start !== null) return hold(start, item.minutes);
    }
    return null;
  };

  const outsideHours = (day: string, item: Item) => {
    const window = workingWindow(day, hours, timeZone);
    const latest = wallAt(day, OUTSIDE_LATEST, timeZone);
    if (!window) return hold(searchWindow(wallAt(day, DEFAULT_START_MINUTES, timeZone), latest, item.minutes, () => true), item.minutes);
    const evening = searchWindow(window.close, latest, item.minutes, () => true);
    if (evening !== null) return hold(evening, item.minutes);
    const length = item.minutes * MINUTE;
    const earliest = wallAt(day, OUTSIDE_EARLIEST, timeZone);
    for (let start = Math.floor((window.open - length) / STEP) * STEP; start >= Math.max(earliest, floor); start -= STEP) {
      const interval = { start, end: start + length };
      if (free(interval)) return hold(start, item.minutes);
    }
    return null;
  };

  const miss = (item: Item, day: string | null, reason: string, nextFree: string | null, outside: string | null) => {
    unplaced.push({
      taskId: item.task.id,
      workspaceId: item.task.workspaceId,
      title: item.task.title,
      group: item.group,
      durationMinutes: item.minutes,
      suggested: item.suggested,
      day,
      reason,
      nextFree,
      outside,
    });
  };

  for (const { item, keep } of keptItems) {
    const start = Date.parse(keep.at);
    taken.push({ start, end: start + keep.durationMinutes * MINUTE });
    placed.push({
      taskId: item.task.id,
      workspaceId: item.task.workspaceId,
      title: item.task.title,
      group: item.group,
      at: iso(start),
      durationMinutes: keep.durationMinutes,
      suggested: false,
      moveDay: keep.moveDay ?? null,
    });
    if (item.day) seedRun(item.group, item.day, { start, end: start + keep.durationMinutes * MINUTE });
  }
  const keptOverdue = new Map<string, string>();
  for (const item of overdueItems) {
    const keep = keeps.get(item.task.id);
    if (!keep) continue;
    const start = Date.parse(keep.at);
    const interval = { start, end: start + keep.durationMinutes * MINUTE };
    taken.push(interval);
    seedRun(item.group, taskDueDay(keep.at, timeZone)!, interval);
    keptOverdue.set(item.task.id, iso(start));
  }

  const stillWorks = (item: Item & { original: Interval }) => {
    const window = workingWindow(item.day!, hours, timeZone);
    const others = held.filter((interval) => interval !== item.original);
    return Boolean(
      window &&
        item.original.start >= window.open &&
        item.original.end <= window.close &&
        item.original.start >= floor &&
        !busy.some((interval) => overlaps(interval, item.original)) &&
        !taken.some((interval) => overlaps(interval, item.original)) &&
        !others.some((interval) => overlaps(interval, item.original)),
    );
  };
  const staying = replanned.filter(stillWorks);
  const moving = replanned.filter((item) => !staying.includes(item));
  for (const item of staying) {
    held.splice(held.indexOf(item.original), 1);
    busy.push(item.original);
  }
  for (const item of [...staying].sort((left, right) => left.original.start - right.original.start)) seedRun(item.group, item.day!, item.original);
  for (const item of staying) {
    if (item.group === "other") continue;
    const own = runs.find((run) => run.day === item.day && run.group === item.group && run.start === item.original.start && run.end === item.original.end);
    const others = runs.filter((run) => run !== own && run.day === item.day && run.group === item.group);
    if (!own || others.length === 0) continue;
    runs.splice(runs.indexOf(own), 1);
    busy.splice(busy.indexOf(item.original), 1);
    if (extendRun(item, item.day!)) continue;
    busy.push(item.original);
    runs.push(own);
  }
  for (const item of moving) {
    held.splice(held.indexOf(item.original), 1);
    if (placeOn(item, item.day!, [])) continue;
    busy.push(item.original);
    seedRun(item.group, item.day!, item.original);
  }

  const missedDated: Item[] = [];
  const pendingDated = [...dated];
  for (const item of dated) {
    pendingDated.splice(pendingDated.indexOf(item), 1);
    if (!placeOn(item, item.day!, pendingDated)) missedDated.push(item);
  }

  const missedUndated: Item[] = [];
  const pendingUndated = [...undated];
  for (const item of undated) {
    pendingUndated.splice(pendingUndated.indexOf(item), 1);
    const joined = item.group !== "other" && days.some((day) => extendRun(item, day));
    if (joined) continue;
    if (!days.some((day) => placeOn(item, day, pendingUndated))) missedUndated.push(item);
  }

  const overdue: PlanOverdue[] = overdueItems.map((item) => {
    const kept = keptOverdue.get(item.task.id);
    if (kept) {
      return {
        taskId: item.task.id,
        workspaceId: item.task.workspaceId,
        title: item.task.title,
        group: item.group,
        dueAt: item.task.dueAt!,
        dueHasTime: item.task.dueHasTime,
        at: kept,
        durationMinutes: keeps.get(item.task.id)!.durationMinutes,
        suggested: false,
      };
    }
    let start = findSlot(today, item.minutes, item.group, false);
    let day: string | null = today;
    for (let guard = 0; start === null && guard < LOOK_BEYOND_DAYS; guard += 1) {
      day = day ? nextWorkableDay(day, hours) : null;
      if (!day) break;
      start = findSlot(day, item.minutes, item.group, false);
    }
    return {
      taskId: item.task.id,
      workspaceId: item.task.workspaceId,
      title: item.task.title,
      group: item.group,
      dueAt: item.task.dueAt!,
      dueHasTime: item.task.dueHasTime,
      at: hold(start, item.minutes),
      durationMinutes: item.minutes,
      suggested: item.suggested,
    };
  });

  for (const item of missedDated) {
    const day = item.day!;
    const reason = offDayText(day, hours) ?? `No ${gapWords(item.minutes)} gap ${day === today ? "left today" : `on ${planDayLabel(day)}`}`;
    miss(item, day, reason, nextFreeAfter(day, item), outsideHours(day, item));
  }
  for (const item of missedUndated) {
    miss(item, null, "No room in the next two weeks", nextFreeAfter(last, item), outsideHours(today, item));
  }

  placed.sort((left, right) => left.at.localeCompare(right.at) || left.title.localeCompare(right.title));
  return {
    from: today,
    to: last,
    placed,
    overdue,
    unplaced,
    reason: planReason(placed, preferences, timeZone),
    ordering,
    replan,
  };
}

export type ScheduleEntry = { taskId: string; at: string; durationMinutes: number; moveDay: string | null; byHand?: boolean };

export type ScheduleCheck = {
  viewerId: string;
  now: number;
  mode: "plan" | "agent";
  timeZone?: string;
  hours?: WorkingHours;
  meetings?: PlanMeeting[];
  others?: PlanTask[];
  batch?: ScheduleEntry[];
};

function quoted(title: string) {
  return `“${title}”`;
}

export function scheduleRefusal(task: PlanTask, entry: ScheduleEntry, check: ScheduleCheck): string | null {
  const timeZone = check.timeZone ?? appTimeZone();
  const name = quoted(task.title);
  if (task.ownerId !== check.viewerId) return `${name} isn't yours. Only your own tasks go on your calendar.`;
  if (task.completedAt) return `${name} is done. Reopen it to move it.`;
  const start = new Date(entry.at).getTime();
  const end = start + entry.durationMinutes * MINUTE;
  const day = dayKeyAt(new Date(start), timeZone);
  const own = taskDueDay(task.dueAt, timeZone);
  const overdue = isBlockOverdue(task, check.now, timeZone);
  const movingOverdue = overdue && entry.moveDay === day;
  if (task.dueHasTime && task.dueAt && task.scheduledBy !== "planner" && !movingOverdue) return `You placed ${name} yourself, so it stays where it is.`;
  if (start < check.now - MINUTE) return `${name} would start in the past. Plan again.`;
  if (own && own !== day) {
    const named = entry.moveDay === day;
    if (!named || (check.mode === "agent" && !overdue)) {
      return overdue
        ? `${name} is overdue from ${planDayLabel(own)}. Name the new day to move it.`
        : `${name} is due ${planDayLabel(own)}, so it stays on that day.`;
    }
  }
  if (check.mode === "plan") return null;
  const hours = check.hours ?? DEFAULT_WORKING_HOURS;
  const offDay = offDayReason(day, hours);
  if (offDay) return `${name} can't go on ${planDayLabel(day)}: it's ${offDay}.`;
  const window = workingWindow(day, hours, timeZone)!;
  if (start < window.open || end > window.close) {
    return `${name} at ${clockLabel(entry.at, timeZone)} is outside your working hours (${hoursText(workingDay(hours, day))}).`;
  }
  const slot = { start, end };
  for (const meeting of check.meetings ?? []) {
    if (!meetingBlocksPlan(meeting)) continue;
    const busy = { start: new Date(meeting.startsAt).getTime(), end: new Date(meeting.endsAt).getTime() };
    if (overlaps(slot, busy)) return `${name} clashes with ${meeting.subject?.trim() || "a meeting"}.`;
  }
  const moving = new Set((check.batch ?? []).map((item) => item.taskId));
  for (const other of check.others ?? []) {
    if (other.id === task.id || moving.has(other.id) || !other.dueHasTime || !other.dueAt || other.completedAt || other.ownerId !== check.viewerId) continue;
    const otherStart = new Date(other.dueAt).getTime();
    const minutes = isTaskDuration(other.durationMinutes) ? other.durationMinutes : DEFAULT_TASK_DURATION;
    if (overlaps(slot, { start: otherStart, end: otherStart + minutes * MINUTE })) return `${name} clashes with ${quoted(other.title)}.`;
  }
  for (const item of check.batch ?? []) {
    if (item.taskId === task.id) continue;
    const itemStart = new Date(item.at).getTime();
    if (overlaps(slot, { start: itemStart, end: itemStart + item.durationMinutes * MINUTE })) return `${name} overlaps another block in this schedule.`;
  }
  return null;
}
