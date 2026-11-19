import { dateKey, wallMinutes } from "@/lib/calendar-view";
import type { Reminder } from "@/lib/crm/reminders";
import type { Task } from "@/lib/crm/types";
import type { HeldTick } from "@/lib/reminders-card";
import { clashWith, taskBlockId, type ClashCandidate, type TaskBlock } from "@/lib/task-blocks";

const MINUTE_MS = 60_000;
const REMINDER_PREFIX = "reminder:";

export type ReminderChip = { id: string; day: string; reminder: Reminder; overdue: boolean };

export type ReminderMarker = { id: string; day: string; minutes: number; reminder: Reminder };

export type PlacedReminders = { chips: ReminderChip[]; markers: ReminderMarker[]; blocks: TaskBlock[] };

export type DayReminderRow = { key: string; reminder: Reminder; done: boolean; held: boolean; overdue: boolean };

export function reminderTaskId(id: string) {
  return `${REMINDER_PREFIX}${id}`;
}

export function isReminderTaskId(id: string) {
  return id.startsWith(REMINDER_PREFIX);
}

export function reminderIdOf(taskId: string) {
  return isReminderTaskId(taskId) ? taskId.slice(REMINDER_PREFIX.length) : null;
}

export function reminderEnd(reminder: Pick<Reminder, "dueAt" | "durationMinutes">) {
  return reminder.dueAt ? Date.parse(reminder.dueAt) + reminder.durationMinutes * MINUTE_MS : null;
}

export function blocksCalendar(reminder: Reminder) {
  return !reminder.completedAt && reminder.blocksTime && Boolean(reminder.dueAt);
}

export function reminderBusy(reminders: Reminder[], today: string): ClashCandidate[] {
  return reminders.filter((reminder) => blocksCalendar(reminder) && reminder.dueOn !== null && reminder.dueOn >= today).map((reminder) => ({
    subject: reminder.title,
    startsAt: reminder.dueAt!,
    endsAt: new Date(reminderEnd(reminder)!).toISOString(),
    isAllDay: false,
    showAs: "busy",
  }));
}

export function reminderTask(reminder: Reminder, viewerId: string, workspaceId: string): Task {
  return {
    id: reminderTaskId(reminder.id),
    workspaceId,
    title: reminder.title,
    description: null,
    dueAt: reminder.dueAt,
    dueDate: reminder.dueOn,
    dueHasTime: Boolean(reminder.dueAt),
    durationMinutes: reminder.durationMinutes,
    scheduledBy: reminder.dueAt ? "person" : null,
    remindMinutes: null,
    completedAt: reminder.completedAt,
    priority: "normal",
    ownerId: viewerId,
    ownerName: null,
    companyId: null,
    companyName: null,
    companyPhone: null,
    contactId: null,
    contactCompanyId: null,
    contactName: null,
    contactFirstName: null,
    contactLastName: null,
    contactJobTitle: null,
    contactPhone: null,
    contactEmail: null,
    opportunityId: null,
    opportunityName: null,
    createdByUserId: viewerId,
    createdByAgentId: null,
    archivedAt: null,
    clickupTaskId: null,
    clickupListId: null,
    clickupUrl: null,
    clickupError: null,
    inOutlook: false,
    mailThreadKey: null,
    mailThread: null,
    seriesId: null,
    occursOn: null,
    repeat: null,
    docIds: [],
    docs: [],
    canLinkDocs: false,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
  };
}

function byTime(left: Reminder, right: Reminder) {
  return (left.dueOn ?? "").localeCompare(right.dueOn ?? "") || (left.dueAt ?? "").localeCompare(right.dueAt ?? "") || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function placeReminders(
  reminders: Reminder[],
  options: { days: string[]; today: string; viewerId: string; workspaceId: string; meetings?: ClashCandidate[] },
): PlacedReminders {
  const shown = new Set(options.days);
  const chips: ReminderChip[] = [];
  const markers: ReminderMarker[] = [];
  const blocks: TaskBlock[] = [];
  for (const reminder of [...reminders].sort(byTime)) {
    if (reminder.completedAt || !reminder.dueOn) continue;
    if (reminder.dueOn < options.today) {
      if (shown.has(options.today)) chips.push({ id: reminder.id, day: options.today, reminder, overdue: true });
      continue;
    }
    if (!reminder.dueAt) {
      if (shown.has(reminder.dueOn)) chips.push({ id: reminder.id, day: reminder.dueOn, reminder, overdue: false });
      continue;
    }
    const day = dateKey(reminder.dueAt);
    if (!shown.has(day)) continue;
    if (!reminder.blocksTime) {
      markers.push({ id: reminder.id, day, minutes: wallMinutes(reminder.dueAt), reminder });
      continue;
    }
    const start = Date.parse(reminder.dueAt);
    const end = reminderEnd(reminder)!;
    const task = reminderTask(reminder, options.viewerId, options.workspaceId);
    blocks.push({
      id: taskBlockId(task.id),
      task,
      title: reminder.title,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      durationMinutes: reminder.durationMinutes,
      person: null,
      workspaceName: null,
      done: false,
      overdue: false,
      clash: clashWith(start, end, options.meetings ?? []),
      reminder,
    });
  }
  chips.sort((left, right) => Number(right.overdue) - Number(left.overdue) || byTime(left.reminder, right.reminder));
  return { chips, markers, blocks };
}

export function dayChips(chips: ReminderChip[], day: string) {
  return chips.filter((chip) => chip.day === day);
}

export function dayMarkers(markers: ReminderMarker[], day: string) {
  return markers.filter((marker) => marker.day === day);
}

export function waitingOnTick(reminder: Reminder, held: HeldTick | undefined) {
  return Boolean(held && reminder.dueOn === held.snapshot.dueOn && reminder.dueAt === held.snapshot.dueAt);
}

export function settledTicks(held: Record<string, HeldTick>, reminders: Reminder[]) {
  const byId = new Map(reminders.map((reminder) => [reminder.id, reminder]));
  let dropped = false;
  const kept: Record<string, HeldTick> = {};
  for (const [id, tick] of Object.entries(held)) {
    const server = byId.get(id);
    if (tick.doneId === null || (server && !server.completedAt && waitingOnTick(server, tick))) kept[id] = tick;
    else dropped = true;
  }
  return dropped ? kept : held;
}

export function withoutTicked(reminders: Reminder[], held: Record<string, HeldTick>) {
  return reminders.filter((reminder) => !waitingOnTick(reminder, held[reminder.id]));
}

export function movedReminder(reminder: Reminder, at: string, durationMinutes: number): Reminder {
  return { ...reminder, dueAt: new Date(at).toISOString(), dueOn: dateKey(at), durationMinutes };
}

export function showsDayReminders(page: { kind: string; dailyDate: string | null; owner: { id: string } }, viewerId: string | null | undefined) {
  return page.kind === "daily" && Boolean(page.dailyDate) && Boolean(viewerId) && page.owner.id === viewerId;
}

export function dayReminderRows(reminders: Reminder[], held: Record<string, HeldTick>, day: string, today: string): DayReminderRow[] {
  const heldDone = new Set(Object.values(held).flatMap((tick) => (tick.doneId ? [tick.doneId] : [])));
  const open: DayReminderRow[] = [];
  const done: DayReminderRow[] = [];
  for (const reminder of reminders) {
    if (reminder.completedAt) {
      if (heldDone.has(reminder.id) || held[reminder.id]) continue;
      done.push({ key: `done:${reminder.id}`, reminder, done: true, held: false, overdue: false });
      continue;
    }
    if (!reminder.dueOn) continue;
    const overdue = reminder.dueOn < day && day === today;
    if (reminder.dueOn !== day && !overdue) continue;
    if (waitingOnTick(reminder, held[reminder.id])) continue;
    open.push({ key: reminder.id, reminder, done: false, held: false, overdue });
  }
  for (const tick of Object.values(held)) {
    const reminder = tick.snapshot;
    const overdue = Boolean(reminder.dueOn && reminder.dueOn < day && day === today);
    if (reminder.dueOn !== day && !overdue) continue;
    open.push({ key: `ticked:${reminder.id}`, reminder, done: true, held: true, overdue });
  }
  open.sort((left, right) => Number(right.overdue) - Number(left.overdue) || byTime(left.reminder, right.reminder));
  done.sort((left, right) => (left.reminder.completedAt ?? "").localeCompare(right.reminder.completedAt ?? ""));
  return [...open, ...done];
}
