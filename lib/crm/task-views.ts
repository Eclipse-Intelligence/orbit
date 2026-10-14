import { TASK_VIEWS, type TaskView } from "@/lib/crm/types";
import { appTimeZone, dayWindow } from "@/lib/time";

export const TASKS_PATH = "/tasks";
export const LEGACY_TASKS_PATH = "/actions";
export const DEFAULT_TASK_VIEW: TaskView = "all";

const VIEW_SLUGS: Partial<Record<TaskView, string>> = { none: "without-tasks" };

export function taskViewSlug(view: TaskView) {
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

export type TaskDueState = {
  kind: "overdue" | "today" | "later" | "none";
  label: string;
};

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
    label: new Intl.DateTimeFormat(
      "en-GB",
      sameYear
        ? { weekday: "short", day: "numeric", month: "short", timeZone }
        : { day: "numeric", month: "short", year: "numeric", timeZone },
    ).format(due),
  };
}
