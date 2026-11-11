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

function dateParts(date: Date, options: Intl.DateTimeFormatOptions) {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", timeZone: options.timeZone }).formatToParts(date);
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
  const sameYear =
    new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(due) ===
    new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(new Date(now));
  return {
    kind: "later",
    label: dateParts(due, sameYear ? { weekday: "short", day: "numeric", month: "short", timeZone } : { day: "numeric", month: "short", year: "numeric", timeZone }),
  };
}
