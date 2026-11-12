import { dateKey, shiftDateKey, weekStartKey } from "@/lib/calendar-view";
import { DEFAULT_TASK_DURATION, isTaskOverdue } from "@/lib/crm/task-time";
import type { Task } from "@/lib/crm/types";
import { appTimeZone, startOfDay } from "@/lib/time";

const MINUTE_MS = 60_000;
const NOT_BUSY = new Set(["free", "tentative", "workingelsewhere"]);

export type PlannerWorkspace = { id: string; name: string };

export type ClashCandidate = {
  subject: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  showAs: string | null;
  myResponse?: string | null;
};

export type TaskBlock = {
  id: string;
  task: Task;
  title: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  person: string | null;
  workspaceName: string | null;
  done: boolean;
  overdue: boolean;
  clash: string | null;
};

export type TaskListGroupKind = "overdue" | "today" | "week" | "later" | "none";

export const TASK_LIST_LABELS: Record<TaskListGroupKind, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
  none: "No date",
};

const LIST_ORDER: TaskListGroupKind[] = ["overdue", "today", "week", "later", "none"];

export function taskBlockId(taskId: string) {
  return `task:${taskId}`;
}

export function taskPerson(task: Pick<Task, "contactName" | "companyName">) {
  return task.contactName ?? task.companyName ?? null;
}

export function isBusyMeeting(event: ClashCandidate) {
  if (event.isAllDay) return false;
  if ((event.myResponse ?? "").toLowerCase() === "declined") return false;
  return !NOT_BUSY.has((event.showAs ?? "busy").toLowerCase());
}

export function taskBlockEnd(task: Pick<Task, "dueAt" | "durationMinutes">) {
  if (!task.dueAt) return null;
  const start = new Date(task.dueAt).getTime();
  if (Number.isNaN(start)) return null;
  return start + (task.durationMinutes || DEFAULT_TASK_DURATION) * MINUTE_MS;
}

export function isBlockOverdue(task: Pick<Task, "dueAt" | "dueHasTime" | "durationMinutes" | "completedAt">, now: number, timeZone = appTimeZone()) {
  if (task.completedAt) return false;
  if (!task.dueHasTime) return isTaskOverdue(task, now, timeZone);
  const end = taskBlockEnd(task);
  return end !== null && end <= now;
}

export function showsAsBlock(task: Task, viewerId: string, now: number, timeZone = appTimeZone()) {
  if (task.ownerId !== viewerId || !task.dueHasTime || !task.dueAt || task.archivedAt) return false;
  if (!task.completedAt) return true;
  return new Date(task.completedAt).getTime() >= startOfDay(new Date(now), timeZone).getTime();
}

function clashWith(start: number, end: number, meetings: ClashCandidate[]) {
  for (const meeting of meetings) {
    if (!isBusyMeeting(meeting)) continue;
    const from = new Date(meeting.startsAt).getTime();
    const to = new Date(meeting.endsAt).getTime();
    if (from < end && to > start) return meeting.subject?.trim() || "a meeting";
  }
  return null;
}

export function taskBlocks(
  tasks: Task[],
  options: {
    viewerId: string;
    now: number;
    meetings?: ClashCandidate[];
    workspaces?: PlannerWorkspace[];
    done?: ReadonlySet<string>;
    timeZone?: string;
  },
): TaskBlock[] {
  const timeZone = options.timeZone ?? appTimeZone();
  const names = (options.workspaces ?? []).length > 1 ? new Map(options.workspaces!.map((item) => [item.id, item.name])) : null;
  const meetings = [...(options.meetings ?? [])].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  return tasks
    .filter((task) => showsAsBlock(task, options.viewerId, options.now, timeZone))
    .map((task) => {
      const start = new Date(task.dueAt!).getTime();
      const durationMinutes = task.durationMinutes || DEFAULT_TASK_DURATION;
      const end = start + durationMinutes * MINUTE_MS;
      const done = Boolean(task.completedAt) || Boolean(options.done?.has(task.id));
      return {
        id: taskBlockId(task.id),
        task,
        title: task.title,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        durationMinutes,
        person: taskPerson(task),
        workspaceName: names?.get(task.workspaceId) ?? null,
        done,
        overdue: !done && isBlockOverdue(task, options.now, timeZone),
        clash: done ? null : clashWith(start, end, meetings),
      };
    })
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.title.localeCompare(right.title));
}

export function blocksInRange(blocks: TaskBlock[], range: { start: Date; end: Date }) {
  const from = range.start.getTime();
  const to = range.end.getTime();
  return blocks.filter((block) => new Date(block.startsAt).getTime() < to && new Date(block.endsAt).getTime() > from);
}

export function taskListGroupKind(task: Pick<Task, "dueAt" | "dueHasTime" | "durationMinutes" | "completedAt">, now: number, timeZone = appTimeZone()): TaskListGroupKind {
  if (!task.dueAt) return "none";
  if (isBlockOverdue(task, now, timeZone)) return "overdue";
  const today = dateKey(now, timeZone);
  const day = dateKey(task.dueAt, timeZone);
  if (day <= today) return "today";
  const weekEnd = shiftDateKey(weekStartKey(today), 6);
  return day <= weekEnd ? "week" : "later";
}

export function groupTaskList<T extends Pick<Task, "dueAt" | "dueHasTime" | "durationMinutes" | "completedAt" | "createdAt" | "title">>(
  tasks: T[],
  now: number,
  timeZone = appTimeZone(),
) {
  const groups = new Map<TaskListGroupKind, T[]>();
  for (const task of tasks) {
    if (task.completedAt) continue;
    const kind = taskListGroupKind(task, now, timeZone);
    groups.set(kind, [...(groups.get(kind) ?? []), task]);
  }
  const order = (left: T, right: T) =>
    (left.dueAt ?? "").localeCompare(right.dueAt ?? "") || left.createdAt.localeCompare(right.createdAt) || left.title.localeCompare(right.title);
  return LIST_ORDER.flatMap((kind) => {
    const items = groups.get(kind);
    return items?.length ? [{ kind, label: TASK_LIST_LABELS[kind], tasks: [...items].sort(order) }] : [];
  });
}
