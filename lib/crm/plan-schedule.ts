import { z } from "zod";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import {
  DEFAULT_PLAN_PREFERENCES,
  LOOK_BEYOND_DAYS,
  MAX_SCHEDULE_ENTRIES,
  packPlan,
  PLAN_DAYS,
  planGroup,
  scheduleRefusal,
  settleOrdering,
  type PlanMeeting,
  type PlanOrderItem,
  type PlanPreferences,
  type PlanProposal,
  type PlanTask,
  type ScheduleEntry,
} from "@/lib/crm/plan-tasks";
import { readPlannerTasks } from "@/lib/crm/task-blocks";
import { isBlockOverdue } from "@/lib/task-blocks";
import { dayStartIso, DEFAULT_TASK_DURATION, isTaskDuration, localInstant, taskDueDay } from "@/lib/crm/task-time";
import { scheduleTaskInDb } from "@/lib/crm/tasks";
import type { Provenance, Task, UserActor } from "@/lib/crm/types";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { readWorkingHoursInDb } from "@/lib/crm/working-hours";
import { actorsForTasks } from "@/lib/crm/workspaces";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { completeJson } from "@/lib/llm";
import type { WorkingHours } from "@/lib/working-hours";

export const PLAN_AI_DEADLINE_MS = 20_000;
export const SCHEDULE_FAILED = "Couldn't put the tasks on your calendar. Try again.";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

type MeetingRow = {
  subject: string | null;
  starts_at: Date;
  ends_at: Date;
  is_all_day: boolean;
  show_as: string | null;
  response_status: string | null;
};

export type PlanContext = {
  now: number;
  tasks: Task[];
  hours: WorkingHours;
  meetings: PlanMeeting[];
  preferences: PlanPreferences;
};

export async function planPreferences(actor: UserActor): Promise<PlanPreferences> {
  void actor;
  return DEFAULT_PLAN_PREFERENCES;
}

export async function readPlanContext(actor: UserActor, now = Date.now(), cover: { start: number; end: number } | null = null): Promise<PlanContext> {
  const today = dayKeyAt(new Date(now));
  const from = new Date(Math.min(Date.parse(dayStartIso(shiftDay(today, -1))), cover ? cover.start - 86_400_000 : Number.POSITIVE_INFINITY)).toISOString();
  const to = new Date(Math.max(Date.parse(dayStartIso(shiftDay(today, PLAN_DAYS + LOOK_BEYOND_DAYS + 2))), cover ? cover.end + 86_400_000 : 0)).toISOString();
  const [planner, personal, preferences] = await Promise.all([
    readPlannerTasks(actor, now),
    withActor(actor, async (db) => {
      const hours = await readWorkingHoursInDb(db, actor.userId);
      const rows = await db.query<MeetingRow>(
        `select subject, starts_at, ends_at, is_all_day, show_as, response_status
         from crm.calendar_events
         where user_id = $1 and not is_cancelled and starts_at < $3 and ends_at > $2
         order by starts_at
         limit 5000`,
        [actor.userId, from, to],
      );
      return {
        hours,
        meetings: rows.rows.map((row) => ({
          subject: row.subject,
          startsAt: new Date(row.starts_at).toISOString(),
          endsAt: new Date(row.ends_at).toISOString(),
          isAllDay: row.is_all_day,
          showAs: row.show_as,
          myResponse: row.response_status,
        })),
      };
    }),
    planPreferences(actor),
  ]);
  return {
    now,
    tasks: planner.read.flatMap((entry) => entry.tasks).filter((task) => task.ownerId === actor.userId),
    hours: personal.hours,
    meetings: personal.meetings,
    preferences,
  };
}

const orderSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      group: z.enum(["call", "email", "other"]),
      minutes: z.number().nullable().optional(),
    }),
  ),
});

const ORDER_SYSTEM = [
  "You help one person plan their open tasks onto their calendar for the next two weeks.",
  "Return every task id once, most pressing first, so work that belongs together sits next to each other.",
  "group is call for phone calls and booking meetings, email for writing or sending email, and other for everything else.",
  "minutes is a realistic length for a task whose duration is 15, the default, from 5 to 240 in steps of 5. Use null to keep 15, and always null for any task whose duration is not 15.",
  "You only order and group. You never choose days or times.",
  'Reply with JSON only: {"tasks":[{"id":"...","group":"call","minutes":null}]}',
].join("\n");

function describeTask(task: PlanTask & Partial<Pick<Task, "contactName" | "companyName" | "description">>, now: number) {
  return {
    id: task.id,
    title: task.title,
    detail: task.description ?? null,
    person: task.contactName ?? null,
    company: task.companyName ?? null,
    due: task.dueAt ? (task.dueHasTime ? task.dueAt : taskDueDay(task.dueAt)) : null,
    overdue: isBlockOverdue(task, now),
    priority: task.priority,
    durationMinutes: task.durationMinutes,
    group: planGroup(task.title),
  };
}

export async function orderWithAi(
  tasks: (PlanTask & Partial<Pick<Task, "contactName" | "companyName" | "description">>)[],
  options: { now?: number; fetchImpl?: typeof fetch; deadlineMs?: number } = {},
): Promise<PlanOrderItem[] | null> {
  if (tasks.length < 2 || !process.env.LLM_API_KEY?.trim()) return null;
  const now = options.now ?? Date.now();
  const budget = options.deadlineMs ?? PLAN_AI_DEADLINE_MS;
  try {
    const result = await completeJson({
      system: ORDER_SYSTEM,
      user: JSON.stringify({ today: taskDueDay(new Date(now).toISOString()), tasks: tasks.map((task) => describeTask(task, now)) }),
      schema: orderSchema,
      deadline: Date.now() + budget,
      timeoutMs: budget,
      fetchImpl: options.fetchImpl,
    });
    return result.data.tasks.map((item) => ({ id: item.id, group: item.group, minutes: item.minutes ?? null }));
  } catch (error) {
    console.error("Plan ordering failed", error);
    return null;
  }
}

export async function buildPlan(
  actor: UserActor,
  options: { now?: number; replan?: boolean; ordering?: unknown; ai?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<PlanProposal> {
  const now = options.now ?? Date.now();
  const context = await readPlanContext(actor, now);
  const open = context.tasks.filter((task) => !task.completedAt && !task.archivedAt);
  const given = Array.isArray(options.ordering) ? settleOrdering(open, options.ordering as PlanOrderItem[]) : null;
  const ordering = given ?? (options.ai === false ? null : await orderWithAi(open, { now, fetchImpl: options.fetchImpl }));
  return packPlan({
    tasks: open,
    meetings: context.meetings,
    viewerId: actor.userId,
    now,
    hours: context.hours,
    replan: options.replan === true,
    ordering,
    preferences: context.preferences,
  });
}

function entryError(message: string) {
  return new CrmError("invalid_input", message, 400, { field: "schedule" });
}

export function readScheduleEntries(raw: unknown): ScheduleEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) throw entryError("Send at least one block to schedule.");
  if (raw.length > MAX_SCHEDULE_ENTRIES) throw entryError(`Schedule up to ${MAX_SCHEDULE_ENTRIES} blocks at a time.`);
  const seen = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object") throw entryError("Each block needs a taskId and an at time.");
    const item = value as Record<string, unknown>;
    if (typeof item.taskId !== "string" || !isUuid(item.taskId)) throw entryError("Each block needs a taskId.");
    if (seen.has(item.taskId)) throw entryError("Each task can appear only once.");
    seen.add(item.taskId);
    const text = typeof item.at === "string" ? item.at.trim() : "";
    const at = /T\d{2}:\d{2}/.test(text) ? localInstant(text) : "";
    if (!at || Number.isNaN(Date.parse(at))) throw entryError("Give each block a start as YYYY-MM-DDTHH:mm in London time.");
    if (item.durationMinutes !== undefined && item.durationMinutes !== null && !isTaskDuration(item.durationMinutes)) {
      throw entryError("Choose a duration between 5 and 480 minutes.");
    }
    if (item.moveDay !== undefined && item.moveDay !== null && (typeof item.moveDay !== "string" || !DAY.test(item.moveDay))) {
      throw entryError("moveDay takes a day, such as 2026-11-16.");
    }
    if (item.byHand !== undefined && typeof item.byHand !== "boolean") throw entryError("byHand is true or false.");
    return {
      taskId: item.taskId,
      at: new Date(at).toISOString(),
      durationMinutes: typeof item.durationMinutes === "number" ? item.durationMinutes : 0,
      moveDay: typeof item.moveDay === "string" ? item.moveDay : null,
      byHand: item.byHand === true,
    };
  });
}

export type ScheduledTask = { task: Task; actor: UserActor; changed: boolean };

export async function scheduleTasks(
  actor: UserActor,
  raw: unknown,
  options: { mode: "plan" | "agent"; provenance: Provenance; now?: number },
): Promise<ScheduledTask[]> {
  const entries = readScheduleEntries(raw);
  const now = options.now ?? Date.now();
  const members = await actorsForTasks(actor, entries.map((entry) => entry.taskId));
  const starts = entries.map((entry) => Date.parse(entry.at));
  const cover = { start: Math.min(...starts), end: Math.max(...starts) + 480 * 60_000 };
  const context = options.mode === "agent" ? await readPlanContext(actor, now, cover) : null;
  const byHand = options.mode === "plan";
  const known = new Map((context?.tasks ?? []).map((task) => [task.id, task]));
  const batch = entries.map((entry) => ({
    ...entry,
    durationMinutes: entry.durationMinutes || known.get(entry.taskId)?.durationMinutes || DEFAULT_TASK_DURATION,
  }));
  return withActor(actor, async (db) => {
    await db.query("select 1 from crm.tasks where id = any($1::uuid[]) order by id for update", [[...entries.map((entry) => entry.taskId)].sort()]);
    const done: ScheduledTask[] = [];
    for (const [index, entry] of entries.entries()) {
      const member = members[index];
      const result = await scheduleTaskInDb(
        db,
        member,
        entry.taskId,
        { at: entry.at, durationMinutes: entry.durationMinutes || null, byHand: byHand && entry.byHand === true },
        options.provenance,
        (task) => {
          const settled = { ...entry, durationMinutes: entry.durationMinutes || task.durationMinutes || DEFAULT_TASK_DURATION };
          batch[index] = settled;
          return scheduleRefusal(task, settled, {
            viewerId: actor.userId,
            now,
            mode: options.mode,
            hours: context?.hours,
            meetings: context?.meetings,
            others: context?.tasks,
            batch,
          });
        },
      );
      done.push({ task: result.task, actor: member, changed: result.changed });
    }
    return done;
  });
}

export async function pushScheduled(scheduled: ScheduledTask[]) {
  for (const item of scheduled) {
    if (!item.changed || !item.task.clickupListId) continue;
    try {
      await pushClickUpTask(item.actor, item.task.id);
    } catch (error) {
      console.error("ClickUp push failed", error);
    }
  }
}
