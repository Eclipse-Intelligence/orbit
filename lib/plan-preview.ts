import { dateKey } from "@/lib/calendar-view";
import { RUN_MAX_MINUTES, RUN_MAX_TASKS, type PlanEntry, type PlanGroup, type PlanMiss, type PlanOverdue, type PlanProposal } from "@/lib/crm/plan-tasks";
import { clockLabel, durationLabel, taskDueDay } from "@/lib/crm/task-time";
import type { Task } from "@/lib/crm/types";
import { clashWith, taskBlockId, taskPerson, type ClashCandidate, type TaskBlock } from "@/lib/task-blocks";
import { appTimeZone } from "@/lib/time";

const MINUTE = 60_000;

export type PreviewSource = "placed" | "overdue" | "unplaced";

export type PreviewEntry = PlanEntry & { source: PreviewSource; byHand?: boolean };

export type OverdueChoice = "move" | "leave";
export type MissChoice = "next" | "outside" | "leave";

export type PlanPreview = {
  proposal: PlanProposal;
  entries: PreviewEntry[];
  overdue: Record<string, OverdueChoice>;
  unplaced: Record<string, MissChoice>;
  removed: string[];
};

export type PreviewRun = { id: string; day: string; group: PlanGroup; startsAt: string; endsAt: string; count: number; minutes: number };

export function startPreview(proposal: PlanProposal): PlanPreview {
  return {
    proposal,
    entries: proposal.placed.map((entry) => ({ ...entry, source: "placed" as const })),
    overdue: {},
    unplaced: {},
    removed: [],
  };
}

export function carryOver(previous: PlanPreview, proposal: PlanProposal, timeZone = appTimeZone()): PlanPreview {
  let next = startPreview(proposal);
  for (const taskId of previous.removed) next = { ...next, entries: without(next.entries, taskId) };
  next = { ...next, removed: [...new Set(previous.removed)] };
  for (const [taskId, choice] of Object.entries(previous.overdue)) {
    if (!proposal.overdue.some((item) => item.taskId === taskId)) continue;
    next = choice === "move" ? moveOverdue(next, taskId, timeZone) : leaveOverdue(next, taskId);
  }
  for (const [taskId, choice] of Object.entries(previous.unplaced)) next = chooseMiss(next, taskId, choice, timeZone);
  for (const entry of previous.entries) {
    if (!entry.byHand) continue;
    const kept = next.entries.find((item) => item.taskId === entry.taskId);
    if (!kept) continue;
    next = {
      ...next,
      entries: sorted([...without(next.entries, entry.taskId), { ...kept, at: entry.at, durationMinutes: entry.durationMinutes, suggested: entry.suggested, moveDay: entry.moveDay, byHand: true }]),
    };
  }
  return next;
}

export function handPlaced(preview: PlanPreview | null) {
  return (preview?.entries ?? [])
    .filter((entry) => entry.byHand)
    .map((entry) => ({ taskId: entry.taskId, at: entry.at, durationMinutes: entry.durationMinutes, moveDay: entry.moveDay }));
}

function sorted(entries: PreviewEntry[]) {
  return [...entries].sort((left, right) => left.at.localeCompare(right.at) || left.title.localeCompare(right.title));
}

function without(entries: PreviewEntry[], taskId: string) {
  return entries.filter((entry) => entry.taskId !== taskId);
}

function overdueEntry(item: PlanOverdue, timeZone: string): PreviewEntry | null {
  if (!item.at) return null;
  return {
    taskId: item.taskId,
    workspaceId: item.workspaceId,
    title: item.title,
    group: item.group,
    at: item.at,
    durationMinutes: item.durationMinutes,
    suggested: item.suggested,
    moveDay: taskDueDay(item.at, timeZone),
    source: "overdue",
  };
}

export function moveOverdue(preview: PlanPreview, taskId: string, timeZone = appTimeZone()): PlanPreview {
  const item = preview.proposal.overdue.find((entry) => entry.taskId === taskId);
  const entry = item ? overdueEntry(item, timeZone) : null;
  if (!entry) return preview;
  return { ...preview, entries: sorted([...without(preview.entries, taskId), entry]), overdue: { ...preview.overdue, [taskId]: "move" } };
}

export function moveAllOverdue(preview: PlanPreview, timeZone = appTimeZone()): PlanPreview {
  return preview.proposal.overdue.reduce(
    (current, item) => (current.overdue[item.taskId] || !item.at ? current : moveOverdue(current, item.taskId, timeZone)),
    preview,
  );
}

export function leaveOverdue(preview: PlanPreview, taskId: string): PlanPreview {
  return { ...preview, entries: without(preview.entries, taskId), overdue: { ...preview.overdue, [taskId]: "leave" } };
}

export function undoOverdue(preview: PlanPreview, taskId: string): PlanPreview {
  const overdue = { ...preview.overdue };
  delete overdue[taskId];
  return { ...preview, entries: without(preview.entries, taskId), overdue };
}

export function chooseMiss(preview: PlanPreview, taskId: string, choice: MissChoice, timeZone = appTimeZone()): PlanPreview {
  const item = preview.proposal.unplaced.find((entry) => entry.taskId === taskId);
  if (!item) return preview;
  const rest = without(preview.entries, taskId);
  const at = choice === "next" ? item.nextFree : choice === "outside" ? item.outside : null;
  if (choice === "leave" || !at) {
    return { ...preview, entries: rest, unplaced: { ...preview.unplaced, [taskId]: choice === "leave" ? "leave" : preview.unplaced[taskId] } };
  }
  const entry: PreviewEntry = {
    taskId,
    workspaceId: item.workspaceId,
    title: item.title,
    group: item.group,
    at,
    durationMinutes: item.durationMinutes,
    suggested: item.suggested,
    moveDay: item.day && taskDueDay(at, timeZone) !== item.day ? taskDueDay(at, timeZone) : null,
    source: "unplaced",
  };
  return { ...preview, entries: sorted([...rest, entry]), unplaced: { ...preview.unplaced, [taskId]: choice } };
}

export function undoMiss(preview: PlanPreview, taskId: string): PlanPreview {
  const unplaced = { ...preview.unplaced };
  delete unplaced[taskId];
  return { ...preview, entries: without(preview.entries, taskId), unplaced };
}

export function removeEntry(preview: PlanPreview, taskId: string): PlanPreview {
  const entry = preview.entries.find((item) => item.taskId === taskId);
  if (!entry) return preview;
  if (entry.source === "overdue") return undoOverdue(preview, taskId);
  if (entry.source === "unplaced") return undoMiss(preview, taskId);
  return { ...preview, entries: without(preview.entries, taskId), removed: [...preview.removed, taskId] };
}

export function dragEntry(
  preview: PlanPreview,
  task: Pick<Task, "id" | "dueAt" | "dueHasTime">,
  at: string,
  durationMinutes: number,
  timeZone = appTimeZone(),
): PlanPreview {
  const entry = preview.entries.find((item) => item.taskId === task.id);
  if (!entry) return preview;
  const day = taskDueDay(at, timeZone);
  const own = taskDueDay(task.dueAt, timeZone);
  const moved: PreviewEntry = {
    ...entry,
    at,
    durationMinutes,
    suggested: entry.suggested && durationMinutes === entry.durationMinutes,
    moveDay: own && day !== own ? day : entry.source === "overdue" ? day : null,
    byHand: true,
  };
  return { ...preview, entries: sorted([...without(preview.entries, task.id), moved]) };
}

export function applyPayload(preview: PlanPreview) {
  return preview.entries.map((entry) => ({
    taskId: entry.taskId,
    at: entry.at,
    durationMinutes: entry.durationMinutes,
    ...(entry.moveDay ? { moveDay: entry.moveDay } : {}),
    ...(entry.byHand ? { byHand: true } : {}),
  }));
}

export function previewMinutes(preview: PlanPreview) {
  return preview.entries.reduce((total, entry) => total + entry.durationMinutes, 0);
}

export function previewSummary(preview: PlanPreview) {
  const count = preview.entries.length;
  return `${count} ${count === 1 ? "block" : "blocks"} · ${durationLabel(previewMinutes(preview))}`;
}

export function entryEnd(entry: Pick<PlanEntry, "at" | "durationMinutes">) {
  return new Date(new Date(entry.at).getTime() + entry.durationMinutes * MINUTE).toISOString();
}

export function previewRuns(entries: PreviewEntry[], timeZone = appTimeZone()): PreviewRun[] {
  const runs: PreviewRun[] = [];
  let current: PreviewRun | null = null;
  for (const entry of sorted(entries)) {
    const day = dateKey(entry.at, timeZone);
    const joins =
      current !== null &&
      entry.group !== "other" &&
      current.group === entry.group &&
      current.day === day &&
      new Date(current.endsAt).getTime() === new Date(entry.at).getTime();
    if (joins && current) {
      current.endsAt = entryEnd(entry);
      current.count += 1;
      current.minutes += entry.durationMinutes;
      continue;
    }
    if (current && current.count > 1) runs.push(current);
    current = entry.group === "other" ? null : { id: `run:${entry.taskId}`, day, group: entry.group, startsAt: entry.at, endsAt: entryEnd(entry), count: 1, minutes: entry.durationMinutes };
  }
  if (current && current.count > 1) runs.push(current);
  return runs;
}

export function runLabel(run: Pick<PreviewRun, "group" | "count" | "minutes">) {
  return `${run.count} ${run.group === "call" ? "calls" : "emails"} · ${durationLabel(run.minutes)}`;
}

export function runHeading(run: Pick<PreviewRun, "group" | "count" | "minutes">) {
  const full = run.count >= RUN_MAX_TASKS || run.minutes >= RUN_MAX_MINUTES;
  return `${run.count} ${run.group === "call" ? "calls" : "emails"} in a row${full ? ", then a break" : ""}`;
}

export function previewTask(task: Task, entry: Pick<PlanEntry, "at" | "durationMinutes">, timeZone = appTimeZone()): Task {
  return { ...task, dueAt: entry.at, dueDate: taskDueDay(entry.at, timeZone), dueHasTime: true, durationMinutes: entry.durationMinutes, scheduledBy: "planner" };
}

export function previewBlocks(
  preview: PlanPreview,
  tasks: Task[],
  options: { workspaces?: { id: string; name: string }[]; meetings?: ClashCandidate[]; blocks?: { title: string; startsAt: string; endsAt: string }[] } = {},
): TaskBlock[] {
  const meetings = [...(options.meetings ?? [])].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const asBusy = (item: { title: string; startsAt: string; endsAt: string }): ClashCandidate => ({ subject: item.title, startsAt: item.startsAt, endsAt: item.endsAt, isAllDay: false, showAs: "busy" });
  const real = (options.blocks ?? []).map(asBusy);
  const proposals = preview.entries.map((entry) => ({ taskId: entry.taskId, candidate: asBusy({ title: entry.title, startsAt: entry.at, endsAt: entryEnd(entry) }) }));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const names = (options.workspaces ?? []).length > 1 ? new Map(options.workspaces!.map((item) => [item.id, item.name])) : null;
  return preview.entries.flatMap((entry) => {
    const task = byId.get(entry.taskId);
    if (!task || task.completedAt) return [];
    return [
      {
        id: `plan:${taskBlockId(task.id)}`,
        task: previewTask(task, entry),
        title: task.title,
        startsAt: entry.at,
        endsAt: entryEnd(entry),
        durationMinutes: entry.durationMinutes,
        person: taskPerson(task),
        workspaceName: names?.get(task.workspaceId) ?? null,
        done: false,
        overdue: false,
        clash: clashWith(new Date(entry.at).getTime(), new Date(entryEnd(entry)).getTime(), [
          ...meetings,
          ...real,
          ...proposals.filter((item) => item.taskId !== entry.taskId).map((item) => item.candidate),
        ]),
        proposed: true,
        suggested: entry.suggested,
      },
    ];
  });
}

export function previewDayLabel(day: string, today: string) {
  if (day === today) return "Today";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${day}T12:00:00Z`))
    .replace(",", "");
}

export function whenLabel(at: string, today: string, timeZone = appTimeZone()) {
  const day = dateKey(at, timeZone);
  return `${previewDayLabel(day, today)}${day === today ? " " : ", "}${clockLabel(at, timeZone)}`;
}

export function wasLabel(item: Pick<PlanOverdue, "dueAt" | "dueHasTime">, today: string, timeZone = appTimeZone()) {
  const day = dateKey(item.dueAt, timeZone);
  return item.dueHasTime ? whenLabel(item.dueAt, today, timeZone) : previewDayLabel(day, today);
}

export function missDayLabel(item: PlanMiss, today: string, timeZone = appTimeZone()) {
  return item.nextFree ? previewDayLabel(dateKey(item.nextFree, timeZone), today).replace(/ \w+$/, "") : null;
}
