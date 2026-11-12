import { TASK_VIEWS, type TaskView } from "@/lib/crm/types";
import { appTimeZone, dayWindow } from "@/lib/time";

export const TASKS_PATH = "/tasks";
const LEGACY_TASKS_PATH = "/actions";
export const DEFAULT_TASK_VIEW: TaskView = "all";

const VIEW_SLUGS: Partial<Record<TaskView, string>> = { none: "without-tasks" };

function taskViewSlug(view: TaskView) {
  return VIEW_SLUGS[view] ?? view;
}

export function taskViewFromParam(value: string | null | undefined): TaskView | null {
  if (!value) return null;
  const match = TASK_VIEWS.find((view) => view === value || taskViewSlug(view) === value);
  return match ?? null;
}

export function tasksHref(view?: TaskView) {
  return view && view !== DEFAULT_TASK_VIEW ? `${TASKS_PATH}?view=${taskViewSlug(view)}` : TASKS_PATH;
}

export function legacyTasksHref(pathname: string, search: URLSearchParams) {
  if (pathname !== LEGACY_TASKS_PATH && pathname !== `${LEGACY_TASKS_PATH}/`) return null;
  const params = new URLSearchParams(search);
  const view = taskViewFromParam(params.get("view"));
  if (view && view !== DEFAULT_TASK_VIEW) params.set("view", taskViewSlug(view));
  else params.delete("view");
  const query = params.toString();
  return query ? `${TASKS_PATH}?${query}` : TASKS_PATH;
}

type TaskDueState = {
  kind: "overdue" | "today" | "later" | "none";
  label: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const YEAR_FORMATS = new Map<string, Intl.DateTimeFormat>();
const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

function yearFormat(timeZone: string) {
  let format = YEAR_FORMATS.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone });
    YEAR_FORMATS.set(timeZone, format);
  }
  return format;
}

function dayFormat(timeZone: string | undefined) {
  const key = timeZone ?? "";
  let format = DAY_FORMATS.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", timeZone });
    DAY_FORMATS.set(key, format);
  }
  return format;
}

function dateParts(date: Date, options: Intl.DateTimeFormatOptions) {
  const parts = dayFormat(options.timeZone).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return [options.weekday ? weekday : "", String(day), MONTHS[month - 1], options.year ? String(year) : ""].filter(Boolean).join(" ");
}

export function taskDueState(
  dueAt: string | null | undefined,
  now: number,
  timeZone = appTimeZone(),
): TaskDueState {
  if (!dueAt) return { kind: "none", label: "No date" };
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return { kind: "none", label: "No date" };
  const today = dayWindow(new Date(now), timeZone);
  if (due < today.start) return { kind: "overdue", label: "Overdue" };
  if (due < today.end) return { kind: "today", label: "Today" };
  const year = yearFormat(timeZone);
  const sameYear = year.format(due) === year.format(new Date(now));
  return {
    kind: "later",
    label: dateParts(due, sameYear ? { weekday: "short", day: "numeric", month: "short", timeZone } : { day: "numeric", month: "short", year: "numeric", timeZone }),
  };
}

export type TaskGroupKind = "overdue" | "today" | "upcoming" | "none";

export const TASK_GROUP_LABELS: Record<TaskGroupKind, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  none: "No date",
};

const GROUP_ORDER: TaskGroupKind[] = ["overdue", "today", "upcoming", "none"];

export function taskGroupKind(dueAt: string | null | undefined, now: number, timeZone = appTimeZone()): TaskGroupKind {
  const state = taskDueState(dueAt, now, timeZone);
  return state.kind === "later" ? "upcoming" : state.kind;
}

export function groupTasksByDue<T extends { dueAt: string | null }>(tasks: T[], now: number, timeZone = appTimeZone()) {
  const groups = new Map<TaskGroupKind, T[]>();
  for (const task of tasks) {
    const kind = taskGroupKind(task.dueAt, now, timeZone);
    groups.set(kind, [...(groups.get(kind) ?? []), task]);
  }
  return GROUP_ORDER.flatMap((kind) => {
    const items = groups.get(kind);
    return items?.length ? [{ kind, label: TASK_GROUP_LABELS[kind], tasks: items }] : [];
  });
}
