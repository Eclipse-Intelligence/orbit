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
  type PlanKeep,
  type PlanMeeting,
  type PlanOrderItem,
  type PlanPreferences,
  type PlanProposal,
  type PlanTask,
  type ScheduleEntry,
} from "@/lib/crm/plan-tasks";
import { learningActors, planPreferencesInDb } from "@/lib/crm/schedule-preferences";
import { isBlockOverdue } from "@/lib/task-blocks";
import { dayStartIso, DEFAULT_TASK_DURATION, isTaskDuration, localInstant, taskDueDay } from "@/lib/crm/task-time";
import { listPlannerTasksInDb, scheduleTaskInDb } from "@/lib/crm/tasks";
import { listOwnSeriesInDb } from "@/lib/crm/upcoming";
import { laterBlocks } from "@/lib/reminder-repeat";
import { upcomingBetween, type RepeatEnds, type RepeatRule } from "@/lib/task-repeat";
import type { Provenance, Task, UserActor } from "@/lib/crm/types";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { readWorkingHoursInDb } from "@/lib/crm/working-hours";
import { actorsForTasks, workspaceActors } from "@/lib/crm/workspaces";
import type { Db } from "@/lib/db/pool";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { completeJson } from "@/lib/llm";
import type { WorkingHours } from "@/lib/working-hours";

export const PLAN_AI_DEADLINE_MS = 20_000;
export const SCHEDULE_AHEAD_DAYS = 366;

const DAY_MS = 86_400_000;
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

export type PlanBusy = { title: string; startsAt: string; endsAt: string };

export type PlanContext = {
  now: number;
  tasks: Task[];
  hours: WorkingHours;
  meetings: PlanMeeting[];
  upcoming: { seriesId: string; title: string; startsAt: string; endsAt: string }[];
  reminders: PlanBusy[];
  preferences: PlanPreferences;
};

export async function readPlanContext(actor: UserActor, now = Date.now(), options: { store?: boolean } = {}): Promise<PlanContext> {
  const { actors, complete } = await learningActors(actor);
  return withActor(actor, (db) => readPlanContextInDb(db, actor, actors, now, [], { store: complete && options.store !== false }));
}

export async function readPlanContextInDb(
  db: Db,
  actor: UserActor,
  actors: UserActor[],
  now = Date.now(),
  covers: { start: number; end: number }[] = [],
  learn: false | { store: boolean } = { store: true },
): Promise<PlanContext> {
  const today = dayKeyAt(new Date(now));
  const from = dayStartIso(shiftDay(today, -1));
  const to = dayStartIso(shiftDay(today, PLAN_DAYS + LOOK_BEYOND_DAYS + 2));
  const coverFrom = covers.map((cover) => new Date(cover.start - DAY_MS).toISOString());
  const coverTo = covers.map((cover) => new Date(cover.end + DAY_MS).toISOString());
  const hours = await readWorkingHoursInDb(db, actor.userId);
  const rows = await db.query<MeetingRow>(
    `select subject, starts_at, ends_at, is_all_day, show_as, response_status
     from crm.calendar_events
     where user_id = $1 and not is_cancelled and task_id is null
       and (
         (starts_at < $3 and ends_at > $2)
         or exists (select 1 from unnest($4::timestamptz[], $5::timestamptz[]) as cover(starts, ends) where starts_at < cover.ends and ends_at > cover.starts)
       )
     order by starts_at
     limit 5000`,
    [actor.userId, from, to, coverFrom, coverTo],
  );
  const reminderRows = await db.query<{ title: string; due_at: Date; duration_minutes: number }>(
    `select title, due_at, duration_minutes
     from crm.reminders
     where user_id = $1 and completed_at is null and blocks_time and due_at is not null
       and (
         (due_at < $3 and due_at + make_interval(mins => duration_minutes) > $2)
         or exists (select 1 from unnest($4::timestamptz[], $5::timestamptz[]) as cover(starts, ends) where due_at < cover.ends and due_at + make_interval(mins => duration_minutes) > cover.starts)
       )
     order by due_at
     limit 1000`,
    [actor.userId, from, to, coverFrom, coverTo],
  );
  const repeatRows = await db.query<{ title: string; due_on: string; due_at: Date; duration_minutes: number; repeat_rule: RepeatRule; repeat_ends: RepeatEnds }>(
    `select title, due_on::text as due_on, due_at, duration_minutes, repeat_rule, repeat_ends
     from crm.reminders
     where user_id = $1 and completed_at is null and blocks_time and due_at is not null and due_on is not null
       and repeat_rule is not null and repeat_ends is not null
     order by due_at
     limit 200`,
    [actor.userId],
  );
  const tasks: Task[] = [];
  for (const target of actors) tasks.push(...(await listPlannerTasksInDb(db, target, now)));
  const series = await listOwnSeriesInDb(db, actor, actors.map((target) => target.workspaceId));
  const coverDays = covers.map((cover) => dayKeyAt(new Date(cover.end + DAY_MS)));
  const lastDay = [shiftDay(today, PLAN_DAYS + LOOK_BEYOND_DAYS + 1), ...coverDays].sort().at(-1)!;
  const upcoming = series.flatMap((item) =>
    upcomingBetween(item, today, lastDay, today)
      .filter((occurrence) => occurrence.dueHasTime)
      .map((occurrence) => ({
        seriesId: item.id,
        title: occurrence.title ?? item.title,
        startsAt: occurrence.dueAt,
        endsAt: new Date(Date.parse(occurrence.dueAt) + occurrence.durationMinutes * 60_000).toISOString(),
      })),
  );
  return {
    now,
    tasks: tasks.filter((task) => task.ownerId === actor.userId),
    hours,
    meetings: rows.rows.map((row) => ({
      subject: row.subject,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      isAllDay: row.is_all_day,
      showAs: row.show_as,
      myResponse: row.response_status,
    })),
    upcoming,
    reminders: [
      ...reminderRows.rows.map((row) => ({
        title: row.title,
        startsAt: new Date(row.due_at).toISOString(),
        endsAt: new Date(new Date(row.due_at).getTime() + row.duration_minutes * 60_000).toISOString(),
      })),
      ...repeatRows.rows.flatMap((row) =>
        laterBlocks(
          { dueOn: row.due_on, dueAt: new Date(row.due_at).toISOString(), durationMinutes: row.duration_minutes, rule: row.repeat_rule, ends: row.repeat_ends },
          today,
          lastDay,
          today,
        ).map((block) => ({ title: row.title, startsAt: new Date(block.start).toISOString(), endsAt: new Date(block.end).toISOString() })),
      ),
    ],
    preferences: learn ? await planPreferencesInDb(db, actor, actors, now, learn) : DEFAULT_PLAN_PREFERENCES,
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
  options: { now?: number; replan?: boolean; ordering?: unknown; ai?: boolean; fetchImpl?: typeof fetch; keep?: PlanKeep[]; store?: boolean } = {},
): Promise<PlanProposal> {
  const now = options.now ?? Date.now();
  const context = await readPlanContext(actor, now, { store: options.store });
  const open = context.tasks.filter((task) => !task.completedAt && !task.archivedAt);
  const given = Array.isArray(options.ordering) ? settleOrdering(open, options.ordering as PlanOrderItem[]) : null;
  const ordering = given ?? (options.ai === false ? null : await orderWithAi(open, { now, fetchImpl: options.fetchImpl }));
  return packPlan({
    tasks: open,
    meetings: context.meetings,
    upcoming: [...context.upcoming, ...context.reminders],
    viewerId: actor.userId,
    now,
    hours: context.hours,
    replan: options.replan === true,
    ordering,
    preferences: context.preferences,
    keep: options.keep ?? null,
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
    const taskId = item.taskId.toLowerCase();
    if (seen.has(taskId)) throw entryError("Each task can appear only once.");
    seen.add(taskId);
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
      taskId,
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
  if (entries.some((entry) => Date.parse(entry.at) > now + SCHEDULE_AHEAD_DAYS * DAY_MS)) throw entryError("Schedule blocks within the next year.");
  const members = await actorsForTasks(actor, entries.map((entry) => entry.taskId));
  const actors = options.mode === "agent" ? await workspaceActors(actor).catch(() => [actor]) : [];
  const covers = entries.map((entry) => ({ start: Date.parse(entry.at), end: Date.parse(entry.at) + 480 * 60_000 }));
  const byHand = options.mode === "plan";
  return withActor(actor, async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`plan:${actor.userId}`]);
    await db.query("select 1 from crm.tasks where id = any($1::uuid[]) order by id for update", [[...entries.map((entry) => entry.taskId)].sort()]);
    const context = options.mode === "agent" ? await readPlanContextInDb(db, actor, actors, now, covers, false) : null;
    const known = new Map((context?.tasks ?? []).map((task) => [task.id, task]));
    const batch = entries.map((entry) => ({
      ...entry,
      durationMinutes: entry.durationMinutes || known.get(entry.taskId)?.durationMinutes || DEFAULT_TASK_DURATION,
    }));
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
            meetings: context
              ? [
                  ...context.meetings,
                  ...context.upcoming
                    .filter((item) => item.seriesId !== task.seriesId)
                    .map((item) => ({ subject: item.title, startsAt: item.startsAt, endsAt: item.endsAt, isAllDay: false, showAs: "busy" })),
                  ...context.reminders.map((item) => ({ subject: item.title, startsAt: item.startsAt, endsAt: item.endsAt, isAllDay: false, showAs: "busy" })),
                ]
              : undefined,
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
