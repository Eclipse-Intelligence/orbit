import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError, notFound } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit, replayOrRun, requestHash, type MutationOptions, type MutationOutcome } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { isReminderMinutes } from "@/lib/crm/reminder-options";
import { queueTaskBlock } from "@/lib/crm/task-block-queue";
import { withoutViewerMail } from "@/lib/crm/task-mail";
import { clockLabel, dayStartIso, isTaskDuration, taskDueDay } from "@/lib/crm/task-time";
import { readDateTime } from "@/lib/time";
import type { SeriesRights } from "@/lib/crm/task-rights";
import { addTaskParticipantsInDb, archiveTaskInDb, canChangeTask, createTaskInDb, readTaskInDb, unarchiveTaskInDb, updateTaskInDb } from "@/lib/crm/tasks";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import {
  checkEnds,
  checkRule,
  firstPatternDay,
  MAX_COUNT,
  isDayKey,
  lastOccurrence,
  nextOccurrence,
  normalRule,
  occurrenceDays,
  occurrenceEnd,
  occurrenceAfter,
  occurrenceFor,
  occurrenceOnOrAfter,
  occurrenceTiming,
  rollThreshold,
  sameRule,
  WEEKDAYS,
  WORKWEEK,
  type MonthWeek,
  type Occurrence,
  type OccurrenceChange,
  type RepeatEnds,
  type RepeatPattern,
  type RepeatRule,
  type Weekday,
  weekdayOf,
  REPEAT_EVERY,
  repeatInputOf,
  type RepeatEvery,
  type RepeatInput,
} from "@/lib/task-repeat";

export { REPEAT_EVERY, repeatInputOf, type RepeatEvery, type RepeatInput } from "@/lib/task-repeat";
import type { Actor, Provenance, Task, TaskPriority, TaskWrite, WorkspaceRole } from "@/lib/crm/types";

export const MAX_ACTIVE_SERIES = 200;
const ROLL_RETRY_MS = 15 * 60_000;
export const TOO_MANY_SERIES = "You have 200 repeating tasks. End one first.";
export const REPEAT_SAVE_FAILED = "Couldn't save the repeat. Try again.";
export const NEEDS_SCOPE = "This task repeats. Send repeatScope: this, following or all.";
export const REPEAT_SCOPES = ["this", "following", "all"] as const;
export type RepeatScope = (typeof REPEAT_SCOPES)[number];

export type OccurrenceTarget = { taskId: string } | { seriesId: string; occursOn: string };

type SeriesRow = {
  id: string;
  workspace_id: string;
  owner_id: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  company_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  starts_on: string;
  at: string | null;
  duration_minutes: number;
  remind_minutes: number | null;
  rule: RepeatRule;
  ends: RepeatEnds;
  current_task_id: string | null;
  roll_at: Date | string | null;
  roll_pending: boolean;
  split_from_id: string | null;
  ended_at: Date | string | null;
  archived_at: Date | string | null;
};

export type SeriesSnapshot = {
  title: string;
  description: string | null;
  priority: TaskPriority;
  ownerId: string | null;
  companyId: string | null;
  contactId: string | null;
  opportunityId: string | null;
  startsOn: string;
  at: string | null;
  durationMinutes: number;
  remindMinutes: number | null;
  rule: RepeatRule;
  ends: RepeatEnds;
  currentTaskId: string | null;
  endedAt: string | null;
  archivedAt: string | null;
};

type ChangeRow = OccurrenceChange & { occursOn: string };

const SERIES_SQL = `select s.id, s.workspace_id, s.owner_id, s.created_by_user_id, s.created_by_agent_id, s.title, s.description, s.priority,
    s.company_id, s.contact_id, s.opportunity_id, s.starts_on::text as starts_on, to_char(s.at, 'HH24:MI') as at,
    s.duration_minutes, s.remind_minutes, s.rule, s.ends, s.current_task_id, s.roll_at, s.roll_pending, s.split_from_id, s.ended_at, s.archived_at
  from crm.task_series s`;

const CHANGES_SQL = `select occurs_on::text as "occursOn", skip, due_at as "dueAt", due_has_time as "dueHasTime",
    duration_minutes as "durationMinutes", title, description
  from crm.task_occurrence_changes`;

function today(now = Date.now()) {
  return dayKeyAt(new Date(now));
}

function patternOf(row: Pick<SeriesRow, "starts_on" | "at" | "rule" | "ends">): RepeatPattern {
  return { startsOn: row.starts_on, at: row.at, rule: row.rule, ends: row.ends };
}

function snapshotOf(row: SeriesRow): SeriesSnapshot {
  return {
    title: row.title,
    description: row.description,
    priority: row.priority,
    ownerId: row.owner_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    opportunityId: row.opportunity_id,
    startsOn: row.starts_on,
    at: row.at,
    durationMinutes: row.duration_minutes,
    remindMinutes: row.remind_minutes,
    rule: row.rule,
    ends: row.ends,
    currentTaskId: row.current_task_id,
    endedAt: iso(row.ended_at),
    archivedAt: iso(row.archived_at),
  };
}

function stopped(row: Pick<SeriesRow, "ended_at" | "archived_at">) {
  return Boolean(row.ended_at || row.archived_at);
}

async function lockSeries(db: Db, id: string | null) {
  if (!id) return null;
  const result = await db.query<SeriesRow>(`${SERIES_SQL} where s.id = $1 for update`, [id]);
  return result.rows[0] ?? null;
}

async function readSeries(db: Db, id: string | null) {
  if (!id) return null;
  const result = await db.query<SeriesRow>(`${SERIES_SQL} where s.id = $1`, [id]);
  return result.rows[0] ?? null;
}

async function changesOf(db: Db, seriesId: string, after: string | null = null): Promise<ChangeRow[]> {
  const result = await db.query<ChangeRow & { dueAt: Date | string | null }>(
    `${CHANGES_SQL} where series_id = $1 and ($2::date is null or occurs_on > $2::date) order by occurs_on`,
    [seriesId, after],
  );
  return result.rows.map((row) => ({ ...row, dueAt: iso(row.dueAt) }));
}

async function readTask(db: Db, actor: Actor, id: string | null) {
  if (!id) return null;
  return readTaskInDb(db, actor, id);
}

type RollFrom = Pick<Task, "occursOn" | "dueAt" | "dueHasTime"> & { durationMinutes?: number | null } & Partial<Pick<Task, "completedAt" | "archivedAt">>;

function endOf(row: SeriesRow, occurrence: { dueAt: string | null; dueHasTime: boolean; durationMinutes?: number | null }) {
  return occurrenceEnd({ ...occurrence, durationMinutes: occurrence.durationMinutes ?? row.duration_minutes });
}

function rollAtFor(row: SeriesRow, task: RollFrom | null, changes: OccurrenceChange[]) {
  if (stopped(row) || !task || task.completedAt || task.archivedAt || !task.occursOn) return null;
  const pattern = patternOf(row);
  const next = nextOccurrence(pattern, changes, task.occursOn);
  if (!next) return null;
  return rollThreshold(pattern, next, row.remind_minutes, endOf(row, task));
}

function latestDue(row: SeriesRow, changes: OccurrenceChange[], first: Occurrence, now: number, notBefore: string | null = null) {
  const pattern = patternOf(row);
  let target = first;
  const passed: string[] = [];
  for (let guard = 0; guard < 2000; guard += 1) {
    const after = nextOccurrence(pattern, changes, target.occursOn);
    if (!after) break;
    const early = notBefore !== null && target.day <= notBefore;
    const over = (endOf(row, target) ?? Infinity) <= now && Date.parse(rollThreshold(pattern, after, row.remind_minutes, endOf(row, target))) <= now;
    if (!early && !over) break;
    passed.push(target.occursOn);
    target = after;
  }
  return { target, passed };
}

async function refreshRoll(db: Db, actor: Actor, seriesId: string) {
  const row = await readSeries(db, seriesId);
  if (!row) return;
  if (!ownsSeries(actor, row)) {
    if (!stopped(row)) await db.query("update crm.task_series set roll_pending = true where id = $1 and not roll_pending", [row.id]);
    return;
  }
  const task = await readTask(db, actor, row.current_task_id);
  const changes = await changesOf(db, row.id, task?.occursOn ?? null);
  await db.query(
    "update crm.task_series set roll_at = $2, roll_pending = false, roll_retry_at = null where id = $1 and (roll_pending or roll_retry_at is not null or roll_at is distinct from $2::timestamptz)",
    [row.id, rollAtFor(row, task, changes)],
  );
}

const WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function readWeekday(value: unknown): Weekday | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const index = WEEKDAY_NAMES.findIndex((name) => text === name || text === name.slice(0, 3) || text === name.slice(0, 2));
  return index === -1 ? null : WEEKDAYS[index];
}

function repeatError(message: string, field = "repeat"): never {
  throw new CrmError("invalid_input", message, 400, { field });
}

export function readRepeat(input: unknown, startsOn: string, now = Date.now()): { rule: RepeatRule; ends: RepeatEnds } {
  if (!input || typeof input !== "object") repeatError("Choose how it repeats.");
  const value = input as Partial<RepeatInput>;
  if (!REPEAT_EVERY.includes(value.every as RepeatEvery)) repeatError("Choose how it repeats: day, weekday, week, month or year.");
  if (value.days !== undefined && value.days !== null && value.every !== "week") repeatError("days only go with every: week.");
  if ((value.monthDay !== undefined || value.monthWeek !== undefined) && value.every !== "month") repeatError("monthDay and monthWeek only go with every: month.");
  if (value.monthDay !== undefined && value.monthWeek !== undefined) repeatError("Choose monthDay or monthWeek, not both.");
  const interval = value.interval === undefined || value.interval === null ? 1 : value.interval;
  let rule: RepeatRule;
  if (value.every === "day") rule = { freq: "daily", interval };
  else if (value.every === "weekday") rule = { freq: "weekly", interval, weekdays: [...WORKWEEK] };
  else if (value.every === "week") {
    const days = value.days === undefined || value.days === null ? [weekdayOf(startsOn)] : Array.isArray(value.days) ? value.days.map(readWeekday) : [null];
    if (days.some((day) => day === null)) repeatError("Choose days as mo, tu, we, th, fr, sa or su.");
    rule = { freq: "weekly", interval, weekdays: days as Weekday[] };
  } else if (value.every === "month") {
    if (value.monthWeek) {
      const weekdayName = readWeekday(value.monthWeek.weekday);
      if (!weekdayName) repeatError("Choose which week of the month.");
      rule = { freq: "monthly", interval, monthWeek: { n: value.monthWeek.n as MonthWeek["n"], weekday: weekdayName } };
    } else rule = { freq: "monthly", interval, monthDay: value.monthDay ?? Number(startsOn.slice(8, 10)) };
  } else rule = { freq: "yearly", interval };
  const ruleError = checkRule(rule);
  if (ruleError) repeatError(ruleError);
  let ends: RepeatEnds = { never: true };
  if (value.ends !== undefined && value.ends !== null) {
    if (typeof value.ends !== "object" || Array.isArray(value.ends)) repeatError("Choose when it ends: { after: N } or { on: YYYY-MM-DD }.", "repeat.ends");
    if ("after" in value.ends && "on" in value.ends) repeatError("Choose after or on, not both.", "repeat.ends");
    if ("after" in value.ends) ends = { count: value.ends.after };
    else if ("on" in value.ends) ends = { until: value.ends.on };
    else repeatError("Choose when it ends: { after: N } or { on: YYYY-MM-DD }.", "repeat.ends");
  }
  const endsError = checkEnds(ends, startsOn, today(now));
  if (endsError) repeatError(endsError, "repeat.ends");
  return { rule: normalRule(rule), ends };
}

async function assertRoom(db: Db, workspaceId: string, ownerId: string | null) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`task-series-room:${workspaceId}:${ownerId ?? "owner"}`]);
  const counted = await db.query<{ total: number }>(
    `with keeper as (
       select coalesce($2::uuid, (select m.user_id from crm.workspace_members m where m.workspace_id = $1 and m.role = 'owner' order by m.created_at limit 1)) as id
     )
     select count(*)::int as total from crm.task_series s, keeper k
     where s.workspace_id = $1 and s.archived_at is null and s.ended_at is null
       and (s.owner_id = k.id or (s.owner_id is null and k.id = (select m.user_id from crm.workspace_members m where m.workspace_id = $1 and m.role = 'owner' order by m.created_at limit 1)))`,
    [workspaceId, ownerId],
  );
  if ((counted.rows[0]?.total ?? 0) >= MAX_ACTIVE_SERIES) throw new CrmError("invalid_input", TOO_MANY_SERIES, 400, { field: "repeat" });
}

function startOf(task: Pick<Task, "dueAt" | "dueHasTime">, now: number) {
  const day = taskDueDay(task.dueAt) ?? today(now);
  return { day, at: task.dueHasTime && task.dueAt ? clockLabel(task.dueAt) : null };
}

function firstDay(rule: RepeatRule, at: string | null, start: string, now: number) {
  const from = start < today(now) ? today(now) : start;
  let day = firstPatternDay(rule, from);
  if (day && at && Date.parse(occurrenceTiming(at, day).dueAt) <= now) day = firstPatternDay(rule, from, shiftDay(day, 1));
  return day;
}

function auditSeries(row: SeriesRow, after: SeriesRow | null, extra: Record<string, unknown> = {}) {
  return { series: { id: row.id, before: snapshotOf(row), after: after ? snapshotOf(after) : null }, ...extra };
}

async function eventIds(db: Db, entityIds: string[]) {
  const result = await db.query<{ id: string; event_type: string }>(
    `select id, event_type from crm.audit_events where entity_id = any($1::uuid[]) and created_at = now() order by created_at desc, id desc`,
    [entityIds],
  );
  const deleting = result.rows.some((row) => row.event_type === "task_series.deleted");
  return result.rows.filter((row) => !(deleting && row.event_type === "task.archived")).map((row) => row.id);
}

function checkLengths(input: Pick<TaskWrite, "durationMinutes" | "remindMinutes">) {
  if (input.durationMinutes !== undefined && !isTaskDuration(input.durationMinutes)) {
    throw new CrmError("invalid_input", "Choose a duration between 5 and 480 minutes.", 400, { field: "durationMinutes" });
  }
  if (input.remindMinutes !== undefined && input.remindMinutes !== null && !isReminderMinutes(input.remindMinutes)) {
    throw new CrmError("invalid_input", "Choose a reminder.", 400, { field: "remindMinutes" });
  }
}

export async function createRepeatingTaskInDb(db: Db, actor: Actor, input: TaskWrite, repeat: unknown, provenance: Provenance, now = Date.now()) {
  if (input.completed) throw new CrmError("invalid_input", "Create the task, then complete it.", 400, { field: "completed" });
  checkLengths(input);
  const ownerId = input.ownerId === undefined ? (actor.type === "user" ? actor.userId : null) : input.ownerId || null;
  await assertRoom(db, actor.workspaceId, ownerId);
  const probe = await createTaskProbe(input);
  const start = startOf(probe, now);
  const { rule, ends } = readRepeat(repeat, start.day, now);
  const first = firstDay(rule, start.at, start.day, now);
  if (!first || ("until" in ends && ends.until < first)) throw new CrmError("invalid_input", "The end date is before the first one.", 400, { field: "repeat.ends" });
  const timing = occurrenceTiming(start.at, first);
  const inserted = await db.query<{ id: string }>(
    `insert into crm.task_series (
      workspace_id, owner_id, created_by_user_id, created_by_agent_id, title, description, priority,
      starts_on, at, duration_minutes, remind_minutes, rule, ends
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::time, $10, $11, $12::jsonb, $13::jsonb)
    returning id`,
    [
      actor.workspaceId,
      ownerId,
      actor.type === "user" ? actor.userId : null,
      actor.type === "agent" ? actor.agentId : null,
      (input.title ?? "").trim().slice(0, 200) || "Task",
      input.description ?? null,
      input.priority ?? "normal",
      first,
      start.at,
      input.durationMinutes ?? 15,
      start.at ? (input.remindMinutes ?? null) : null,
      JSON.stringify(rule),
      JSON.stringify(ends),
    ],
  );
  const seriesId = inserted.rows[0].id;
  const write: TaskWrite = { ...input };
  delete write.dueDate;
  write.dueAt = timing.dueAt;
  write.dueHasTime = timing.dueHasTime;
  const task = await createTaskInDb(db, actor, write, provenance, { series: { id: seriesId, occursOn: first } });
  if (!task) throw new CrmError("internal_error", REPEAT_SAVE_FAILED, 500);
  await db.query(
    `update crm.task_series set current_task_id = $2, owner_id = $3, title = $4, description = $5, priority = $6,
       company_id = $7, contact_id = $8, opportunity_id = $9, duration_minutes = $10,
       at = $11::time, remind_minutes = $12
     where id = $1`,
    [
      seriesId,
      task.id,
      task.ownerId,
      task.title,
      task.description,
      task.priority,
      task.companyId,
      task.contactId,
      task.opportunityId,
      task.durationMinutes,
      task.dueHasTime ? start.at : null,
      task.dueHasTime ? task.remindMinutes : null,
    ],
  );
  await refreshRoll(db, actor, seriesId);
  const row = (await readSeries(db, seriesId))!;
  await recordAudit(db, actor, "task_series.created", "task", task.id, provenance, { series: { id: seriesId, before: null, after: snapshotOf(row) }, withTask: true });
  return (await readTaskInDb(db, actor, task.id))!;
}

async function createTaskProbe(input: TaskWrite): Promise<Pick<Task, "dueAt" | "dueHasTime">> {
  const raw = input.dueAt ?? input.dueDate ?? null;
  if (!raw || !raw.trim()) return { dueAt: null, dueHasTime: false };
  const reading = readDateTime(raw);
  if (!reading.ok) throw new CrmError("invalid_input", reading.error, 400, { field: input.dueAt ? "dueAt" : "dueDate" });
  if (reading.dateOnly || input.dueDate !== undefined || input.dueHasTime === false) {
    const day = taskDueDay(reading.date.toISOString()) ?? today();
    return { dueAt: reading.dateOnly ? reading.date.toISOString() : dayStartIso(day), dueHasTime: false };
  }
  return { dueAt: reading.date.toISOString(), dueHasTime: true };
}

export async function createRepeatingTask(actor: Actor, input: TaskWrite, repeat: unknown, options: MutationOptions = {}): Promise<MutationOutcome<{ task: Task }>> {
  assertScope(actor.scopes, "tasks:write");
  const provenance = options.provenance ?? { operation: "create_task" };
  const hash = requestHash("create_task", { input, repeat, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 201, async () => ({ task: await createRepeatingTaskInDb(db, actor, input, repeat, provenance) })),
  );
}

async function memberOrNull(db: Db, workspaceId: string, userId: string | null) {
  if (!userId) return null;
  const found = await db.query("select 1 from crm.workspace_members where workspace_id = $1 and user_id = $2", [workspaceId, userId]);
  return (found.rowCount ?? 0) > 0 ? userId : null;
}

async function linksInWorkspace(db: Db, row: SeriesRow) {
  const found = await db.query<{ company_id: string | null; contact_id: string | null; opportunity_id: string | null }>(
    `select
       (select c.id from crm.companies c where c.id = $2 and c.workspace_id = $1) as company_id,
       (select c.id from crm.contacts c where c.id = $3 and c.workspace_id = $1) as contact_id,
       (select o.id from crm.opportunities o where o.id = $4 and o.workspace_id = $1) as opportunity_id`,
    [row.workspace_id, row.company_id, row.contact_id, row.opportunity_id],
  );
  return found.rows[0];
}

type Previous = Pick<Task, "id" | "ownerId" | "clickupListId">;

async function insertOccurrence(db: Db, actor: Actor, row: SeriesRow, occurrence: Occurrence, previous: Previous | null, provenance: Provenance | undefined) {
  const ownerId = (await memberOrNull(db, row.workspace_id, row.owner_id)) ?? (await memberOrNull(db, row.workspace_id, previous?.ownerId ?? null));
  const links = await linksInWorkspace(db, row);
  const timed = occurrence.dueHasTime;
  const id = randomUUID();
  await db.query(
    `insert into crm.tasks (
       workspace_id, title, description, due_at, priority, owner_id, company_id, contact_id, opportunity_id,
       created_by_user_id, created_by_agent_id, remind_minutes, due_has_time, scheduled_by, duration_minutes,
       clickup_list_id, series_id, occurs_on, id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      row.workspace_id,
      occurrence.title ?? row.title,
      occurrence.description ?? row.description,
      occurrence.dueAt,
      row.priority,
      ownerId,
      links.company_id,
      links.contact_id,
      links.opportunity_id,
      row.created_by_user_id,
      row.created_by_agent_id,
      timed ? row.remind_minutes : null,
      timed,
      timed ? "person" : null,
      occurrence.durationMinutes ?? row.duration_minutes,
      previous?.clickupListId ?? null,
      row.id,
      occurrence.occursOn,
      id,
    ],
  );
  queueTaskBlock(db, id);
  const task = await readTaskInDb(db, actor, id);
  await recordAudit(db, actor, "task.created", "task", id, { operation: "repeat_task", source: provenance?.source ?? null }, {
    after: task ? withoutViewerMail(task) : { title: occurrence.title ?? row.title, dueAt: occurrence.dueAt, dueHasTime: timed, ownerId, seriesId: row.id, occursOn: occurrence.occursOn },
    repeat: { seriesId: row.id, occursOn: occurrence.occursOn, after: previous?.id ?? null },
  });
  if (ownerId !== row.owner_id && ownsSeries(actor, row)) await db.query("update crm.task_series set owner_id = $2 where id = $1", [row.id, ownerId]);
  return { id, task };
}

async function finishSeries(db: Db, actor: Actor, row: SeriesRow, previous: Task | null, provenance: Provenance | undefined) {
  if (!ownsSeries(actor, row)) return;
  await db.query("update crm.task_series set ended_at = coalesce(ended_at, now()), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
  const child = await db.query<SeriesRow>(
    `${SERIES_SQL} where s.split_from_id = $1 and s.current_task_id is null and s.archived_at is null and s.ended_at is null for update`,
    [row.id],
  );
  for (const split of child.rows) if (ownsSeries(actor, split)) await startSplit(db, actor, split, previous, provenance);
}

async function startSplit(db: Db, actor: Actor, split: SeriesRow, previous: Previous | null, provenance: Provenance | undefined) {
  const changes = await changesOf(db, split.id);
  const first = nextOccurrence(patternOf(split), changes, shiftDay(split.starts_on, -1));
  if (!first) {
    await db.query("update crm.task_series set ended_at = coalesce(ended_at, now()), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [split.id]);
    await consumeChanges(db, split.id, "9999-12-31");
    return null;
  }
  await consumeChanges(db, split.id, first.occursOn);
  const created = await insertOccurrence(db, actor, split, first, previous ?? (await splitPrevious(db, split.id)), provenance);
  await db.query("update crm.task_series set roll_at = $3, roll_pending = false, roll_retry_at = null where id = $1 and current_task_id = $2", [
    split.id,
    created.id,
    rollAtFor(split, first, changes.filter((change) => change.occursOn > first.occursOn)),
  ]);
  return created.task;
}

async function splitPrevious(db: Db, seriesId: string): Promise<Previous | null> {
  const found = await db.query<{ id: string; owner_id: string | null; clickup_list_id: string | null }>("select id, owner_id, clickup_list_id from crm.series_split_previous($1)", [seriesId]);
  const row = found.rows[0];
  return row ? { id: row.id, ownerId: row.owner_id, clickupListId: row.clickup_list_id } : null;
}

async function startSplitInDb(db: Db, actor: Actor, seriesId: string) {
  const split = await lockSeries(db, seriesId);
  if (!split || !split.split_from_id || split.current_task_id || stopped(split) || !ownsSeries(actor, split)) return null;
  const parent = await readSeries(db, split.split_from_id);
  if (parent && !parent.ended_at && !parent.archived_at) return null;
  return startSplit(db, actor, split, null, { operation: "repeat_task", automatic: true });
}

async function advanceFrom(db: Db, actor: Actor, row: SeriesRow, done: Task, provenance: Provenance | undefined, now = Date.now()) {
  if (stopped(row) || !done.occursOn) {
    if (ownsSeries(actor, row)) await db.query("update crm.task_series set roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
    return null;
  }
  const changes = await changesOf(db, row.id, done.occursOn);
  const first = nextOccurrence(patternOf(row), changes, done.occursOn);
  if (!first) {
    await finishSeries(db, actor, row, done, provenance);
    return null;
  }
  const { target: next } = latestDue(row, changes, first, now, taskDueDay(done.dueAt));
  await consumeChanges(db, row.id, next.occursOn);
  const rollAt = rollAtFor(row, next, changes.filter((change) => change.occursOn > next.occursOn));
  const owner = (await memberOrNull(db, row.workspace_id, row.owner_id)) ?? (await memberOrNull(db, row.workspace_id, done.ownerId));
  const owns = ownsSeries(actor, row);
  if (owns) await db.query("update crm.task_series set roll_at = $2, roll_pending = false, roll_retry_at = null, owner_id = $3 where id = $1", [row.id, rollAt, owner]);
  else await db.query("update crm.task_series set roll_pending = true where id = $1 and not roll_pending", [row.id]);
  const created = await insertOccurrence(db, actor, { ...row, owner_id: owner }, next, done, provenance);
  if (owns) await db.query("update crm.task_series set roll_at = $3, roll_pending = false, roll_retry_at = null where id = $1 and current_task_id = $2", [row.id, created.id, rollAt]);
  return created;
}

async function consumeChanges(db: Db, seriesId: string, upTo: string) {
  await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on <= $2::date", [seriesId, upTo]);
}

export async function seriesAfterTaskChange(db: Db, actor: Actor, before: Task, task: Task, provenance: Provenance | undefined): Promise<Task | null> {
  if (!task.seriesId) return null;
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id) return null;
  if (!before.completedAt && task.completedAt) {
    await advanceFrom(db, actor, row, task, provenance);
    return readTaskInDb(db, actor, task.id);
  }
  const retimed = before.dueAt !== task.dueAt || before.dueHasTime !== task.dueHasTime || Boolean(before.completedAt) !== Boolean(task.completedAt);
  if (retimed) await refreshRoll(db, actor, row.id);
  return null;
}

async function untouched(db: Db, taskId: string) {
  const result = await db.query<{ total: number }>(
    `select count(*)::int as total from crm.audit_events
     where entity_type = 'task' and entity_id = $1 and event_type <> 'task.created' and event_type not like 'task.participant_%'`,
    [taskId],
  );
  return (result.rows[0]?.total ?? 0) === 0;
}

async function neighboursOf(db: Db, taskId: string) {
  const found = await db.query<{ before_open: string | null; last: string | null }>("select before_open, last from crm.series_reopen_neighbours($1)", [taskId]);
  return { beforeOpen: found.rows[0]?.before_open ?? null, last: found.rows[0]?.last ?? null };
}

export async function seriesBeforeReopen(db: Db, actor: Actor, task: Task, provenance: Provenance | undefined) {
  if (!task.seriesId) return;
  const peek = await readSeries(db, task.seriesId);
  if (!peek) {
    await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    return;
  }
  if (peek.current_task_id && peek.current_task_id !== task.id) await lockOccurrence(db, peek.current_task_id);
  const row = await lockSeries(db, task.seriesId);
  if (!row) {
    await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    return;
  }
  if (row.current_task_id === task.id) return;
  const current = await readTask(db, actor, row.current_task_id);
  const near = await neighboursOf(db, task.id);
  const later = current && !current.completedAt && !current.archivedAt && (current.occursOn ?? "") > (task.occursOn ?? "");
  const predecessor = current ? near.beforeOpen === task.id : false;
  if (later && predecessor && (await untouched(db, current.id))) {
    await archiveTaskInDb(db, actor, current.id, { operation: "undo_repeat", source: provenance?.source ?? null }, { keepSeries: true });
    if (current.clickupTaskId || current.clickupListId) {
      await db.query(`update crm.tasks set clickup_sync = clickup_sync || '{"deleteRemote": true}'::jsonb where id = $1`, [current.id]);
    }
    await db.query("update crm.task_series set current_task_id = $2 where id = $1", [row.id, task.id]);
    return;
  }
  if ((!current || current.archivedAt || current.completedAt) && near.last === task.id) {
    await db.query("update crm.task_series set current_task_id = $2 where id = $1", [row.id, task.id]);
    return;
  }
  await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
}

export async function seriesAfterArchive(db: Db, actor: Actor, task: Task) {
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || stopped(row) || !ownsSeries(actor, row)) return;
  await db.query("update crm.task_series set ended_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
}

export async function seriesBeforeUnarchive(db: Db, task: Task) {
  if (!task.seriesId || !task.occursOn) return;
  const clash = await db.query(
    `select 1 from crm.tasks where series_id = $1 and id <> $2 and archived_at is null
       and (occurs_on = $3::date or ($4::boolean and completed_at is null))`,
    [task.seriesId, task.id, task.occursOn, !task.completedAt],
  );
  if ((clash.rowCount ?? 0) > 0) await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
}

export async function seriesAfterUnarchive(db: Db, actor: Actor, task: Task) {
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || !row.archived_at) return;
  if (!ownsSeries(actor, row)) {
    await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    return;
  }
  await db.query("update crm.task_series set archived_at = null where id = $1", [row.id]);
  await refreshRoll(db, actor, row.id);
}

async function seriesValues(db: Db, actor: Actor, row: SeriesRow, task: Task, target: Occurrence, handed = false): Promise<TaskWrite> {
  const write: TaskWrite = {};
  const title = target.title ?? row.title;
  if (title !== task.title) write.title = title;
  const description = target.description ?? row.description;
  if ((description ?? null) !== (task.description ?? null)) write.description = description;
  if (row.priority !== task.priority) write.priority = row.priority;
  const duration = target.durationMinutes ?? row.duration_minutes;
  if (duration !== task.durationMinutes && !handed) write.durationMinutes = duration;
  if (target.dueHasTime && !handed && row.remind_minutes !== task.remindMinutes) write.remindMinutes = row.remind_minutes;
  const owner = await memberOrNull(db, row.workspace_id, row.owner_id);
  if (owner && owner !== task.ownerId && ownsSeries(actor, row)) write.ownerId = owner;
  const links = await linksInWorkspace(db, row);
  if (links.company_id !== task.companyId || links.contact_id !== task.contactId || links.opportunity_id !== task.opportunityId) {
    write.companyId = links.company_id;
    write.contactId = links.contact_id;
    write.opportunityId = links.opportunity_id;
  }
  return write;
}

type OccurrenceWriteOptions = { auditExtra?: Record<string, unknown>; occursOn?: string; archive?: boolean; detach?: boolean; restoring?: boolean };

function seriesRights(row: SeriesRow): SeriesRights {
  return { id: row.id, ownerId: row.owner_id, createdByUserId: row.created_by_user_id, createdByAgentId: row.created_by_agent_id };
}

async function writeOccurrence(db: Db, actor: Actor, row: SeriesRow, task: Task, write: TaskWrite, provenance: Provenance, options: OccurrenceWriteOptions = {}): Promise<Task> {
  if (!canChangeTask(actor, task, seriesRights(row))) throw new CrmError("forbidden", seriesRefusal(actor, task), 403, { field: "repeatScope" });
  if (options.detach) {
    await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    return (await readTaskInDb(db, actor, task.id)) ?? task;
  }
  if (options.occursOn) await db.query("update crm.tasks set occurs_on = $2 where id = $1", [task.id, options.occursOn]);
  if (options.archive) return (await archiveTaskInDb(db, actor, task.id, provenance, { keepSeries: true, series: seriesRights(row) })).task;
  return (await updateTaskInDb(db, actor, task.id, write, provenance, { restoring: options.restoring, auditExtra: options.auditExtra, series: seriesRights(row) })).task;
}

function moveWrite(occurrence: Occurrence, task: Task): TaskWrite {
  const write: TaskWrite = occurrence.dueHasTime ? { dueAt: occurrence.dueAt, dueHasTime: true } : { dueDate: occurrence.day };
  if (occurrence.durationMinutes && occurrence.durationMinutes !== task.durationMinutes) write.durationMinutes = occurrence.durationMinutes;
  if (occurrence.title && occurrence.title !== task.title) write.title = occurrence.title;
  if (occurrence.description !== null && occurrence.description !== task.description) write.description = occurrence.description;
  if (task.scheduledBy && occurrence.dueHasTime) write.scheduledBy = task.scheduledBy;
  return write;
}

async function moveCurrent(
  db: Db,
  actor: Actor,
  row: SeriesRow,
  task: Task,
  target: Occurrence,
  passed: string[],
  kind: "missed" | "skipped",
  provenance: Provenance,
  extra: Record<string, unknown> = {},
) {
  const consumed = (await changesOf(db, row.id, task.occursOn)).filter((change) => change.occursOn <= target.occursOn);
  const handed = !ownsSeries(actor, row) && task.ownerId !== row.owner_id;
  const used: Occurrence = handed
    ? task.dueHasTime && task.dueAt
      ? { ...target, ...occurrenceTiming(clockLabel(task.dueAt), target.day) }
      : { ...target, dueAt: dayStartIso(target.day), dueHasTime: false }
    : target;
  const write: TaskWrite & { occursOn?: string } = { ...moveWrite(used, task), ...(await seriesValues(db, actor, row, task, used, handed)) };
  if (!used.dueHasTime && task.remindMinutes !== null) write.remindMinutes = null;
  const moved = await writeOccurrence(db, actor, row, task, write, provenance, {
    occursOn: target.occursOn,
    restoring: true,
    auditExtra: { repeat: { seriesId: row.id, kind, from: task.occursOn, to: target.occursOn, passed, consumed, ...extra } },
  });
  await consumeChanges(db, row.id, target.occursOn);
  await refreshRoll(db, actor, row.id);
  return moved;
}

export async function rollSeriesInDb(db: Db, actor: Actor, seriesId: string, now = Date.now()) {
  const peek = await readSeries(db, seriesId);
  if (!peek?.current_task_id) return null;
  await lockOccurrence(db, peek.current_task_id);
  const current = await readTaskInDb(db, actor, peek.current_task_id);
  const row = await lockSeries(db, seriesId);
  if (!row || !current || current.seriesId !== row.id || row.current_task_id !== current.id || stopped(row) || !current.occursOn || current.archivedAt) return null;
  if (current.completedAt) {
    const created = await advanceFrom(db, actor, row, current, { operation: "repeat_task", automatic: true }, now);
    return created?.task ?? null;
  }
  const task = { ...current, occursOn: current.occursOn };
  const from = current.occursOn;
  if (row.roll_pending) {
    await refreshRoll(db, actor, row.id);
    const fresh = await readSeries(db, row.id);
    row.roll_at = fresh?.roll_at ?? null;
  }
  if (!row.roll_at || new Date(row.roll_at).getTime() > now) return null;
  const pattern = patternOf(row);
  const changes = await changesOf(db, row.id, from);
  const first = nextOccurrence(pattern, changes, from);
  if (!first) {
    if (ownsSeries(actor, row)) await db.query("update crm.task_series set roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
    return null;
  }
  const { target, passed } = latestDue(row, changes, first, now);
  return moveCurrent(db, actor, row, task, target, [from, ...passed], "missed", { operation: "repeat_roll", automatic: true });
}

async function lockOccurrence(db: Db, taskId: string) {
  await db.query("select 1 from crm.tasks where id = $1 for no key update", [taskId]);
}

async function lockOpenTask(db: Db, actor: Actor, id: string) {
  await lockOccurrence(db, id);
  const task = await readTaskInDb(db, actor, id);
  return task && !task.completedAt && !task.archivedAt ? task : null;
}

type DueRoll = { series_id: string; task_id: string | null; workspace_id: string; workspace_name: string; user_id: string; role: WorkspaceRole; email: string | null; full_name: string | null };

export async function rollDueSeries(options: { deadline: number; now?: number; limit?: number }) {
  const now = options.now ?? Date.now();
  const due = await query<DueRoll>("select * from private.series_due_to_roll($1, $2)", [new Date(now).toISOString(), options.limit ?? 50]);
  let rolled = 0;
  let failed = 0;
  for (const row of due.rows) {
    if (Date.now() > options.deadline) break;
    try {
      const actor = memberActor({ ...row, role: row.role });
      const moved = await withActor(actor, (db) => (row.task_id ? rollSeriesInDb(db, actor, row.series_id, now) : startSplitInDb(db, actor, row.series_id)));
      if (moved) rolled += 1;
      else await query("select private.delay_series_roll($1, $2, $3)", [row.series_id, new Date(now + ROLL_RETRY_MS).toISOString(), new Date(now).toISOString()]);
    } catch (error) {
      failed += 1;
      console.error("Repeating task roll failed", row.series_id, error instanceof Error ? error.name : "unknown");
      await query("select private.delay_series_roll($1, $2, $3)", [row.series_id, new Date(now + ROLL_RETRY_MS).toISOString(), new Date(now).toISOString()]).catch(() => undefined);
    }
  }
  return { due: due.rows.length, rolled, failed };
}

async function resolveTarget(db: Db, actor: Actor, target: OccurrenceTarget) {
  if ("taskId" in target) {
    if (!isUuid(target.taskId)) throw notFound("task");
    await lockOccurrence(db, target.taskId);
    const task = await readTaskInDb(db, actor, target.taskId);
    if (!task || task.archivedAt || task.workspaceId !== actor.workspaceId) throw notFound("task");
    const row = task.seriesId ? await lockSeries(db, task.seriesId) : null;
    return { task, row, occursOn: task.occursOn, future: false };
  }
  if (!isDayKey(target.occursOn)) throw new CrmError("invalid_input", "occursOn takes a day, such as 2027-03-04.", 400, { field: "occursOn" });
  if (!isUuid(target.seriesId)) throw notFound("task");
  const peek = await readSeries(db, target.seriesId);
  if (!peek || peek.workspace_id !== actor.workspaceId || peek.archived_at) throw notFound("task");
  let current = peek.current_task_id ? await lockOpenTask(db, actor, peek.current_task_id) : null;
  const row = await lockSeries(db, target.seriesId);
  if (!row) throw notFound("task");
  if (row.current_task_id !== (current?.id ?? peek.current_task_id)) current = row.current_task_id ? await lockOpenTask(db, actor, row.current_task_id) : null;
  if (current && current.occursOn === target.occursOn) return { task: current, row, occursOn: current.occursOn, future: false };
  if (!current || !current.occursOn || target.occursOn <= current.occursOn || stopped(row)) {
    throw new CrmError("invalid_input", "That date isn't an upcoming one. Change the open task instead.", 400, { field: "occursOn" });
  }
  if (occurrenceOnOrAfter(patternOf(row), target.occursOn) !== target.occursOn) {
    throw new CrmError("invalid_input", "That date isn't one of its dates.", 400, { field: "occursOn" });
  }
  return { task: current, row, occursOn: target.occursOn, future: true };
}

export const SERIES_RIGHTS = "Only the repeating task's assignee or creator can change every date. You can change this one.";
export const SERIES_RIGHTS_TAGGED = "Only the repeating task's assignee or creator can change every date.";

function seriesRefusal(actor: Actor, task: Pick<Task, "ownerId" | "createdByUserId" | "createdByAgentId">) {
  return canChangeTask(actor, task) ? SERIES_RIGHTS : SERIES_RIGHTS_TAGGED;
}

function hiddenSeries(actor: Actor, task: Task, field: string) {
  if (task.seriesId && !canChangeTask(actor, task)) throw new CrmError("forbidden", SERIES_RIGHTS_TAGGED, 403, { field });
}

function ownsSeries(actor: Actor, row: SeriesRow) {
  return actor.type === "user"
    ? row.owner_id === actor.userId || row.created_by_user_id === actor.userId
    : Boolean(row.created_by_agent_id) && row.created_by_agent_id === actor.agentId;
}

function assertSeriesChange(actor: Actor, row: SeriesRow) {
  if (!ownsSeries(actor, row)) throw new CrmError("forbidden", SERIES_RIGHTS, 403, { field: "repeatScope" });
}

function assertOccurrenceChange(actor: Actor, row: SeriesRow, task: Task) {
  if (!ownsSeries(actor, row) && !canChangeTask(actor, task)) throw new CrmError("forbidden", SERIES_RIGHTS_TAGGED, 403);
}

export const SKIP_MOVED_ON = "This one has moved on already. Check its date and try again.";

export async function skipOccurrenceInDb(db: Db, actor: Actor, target: OccurrenceTarget, provenance: Provenance, extra: Record<string, unknown> = {}, expect?: string) {
  const found = await resolveTarget(db, actor, target);
  const { task, row } = found;
  if (!row) {
    hiddenSeries(actor, task, "skip");
    throw new CrmError("invalid_input", "This task doesn't repeat.", 400, { field: "skip" });
  }
  if (expect !== undefined && !found.future && task.occursOn !== expect) throw new CrmError("conflict", SKIP_MOVED_ON, 409, { field: "skip" });
  if (found.future) assertSeriesChange(actor, row);
  else assertOccurrenceChange(actor, row, task);
  if (task.completedAt) throw new CrmError("invalid_input", "This one is done. Reopen it to skip it.", 400, { field: "skip" });
  if (found.future) {
    const before = (await changesOf(db, row.id)).find((change) => change.occursOn === found.occursOn) ?? null;
    await db.query(
      `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, created_by)
       values ($1, $2, true, $3)
       on conflict (series_id, occurs_on) do update set skip = true`,
      [row.id, found.occursOn, actor.type === "user" ? actor.userId : null],
    );
    await refreshRoll(db, actor, row.id);
    const after = await readSeries(db, row.id);
    await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { skipped: found.occursOn, changeBefore: before }));
    return { task: (await readTaskInDb(db, actor, task.id))!, skipped: found.occursOn! };
  }
  if (stopped(row)) throw new CrmError("invalid_input", "It doesn't repeat any more. Mark it done or delete it.", 400, { field: "skip" });
  const changes = await changesOf(db, row.id, task.occursOn);
  const next = nextOccurrence(patternOf(row), changes, task.occursOn!);
  if (!next) throw new CrmError("invalid_input", "This is the last one. Mark it done or delete it.", 400, { field: "skip" });
  const moved = await moveCurrent(db, actor, row, task, next, [task.occursOn!], "skipped", provenance, extra);
  return { task: moved, skipped: task.occursOn! };
}

export async function skipOccurrence(actor: Actor, target: OccurrenceTarget, options: MutationOptions & { expect?: string } = {}) {
  assertScope(actor.scopes, "tasks:write");
  const provenance = options.provenance ?? { operation: "skip_occurrence" };
  const hash = requestHash("skip_occurrence", { target, provenance, expect: options.expect });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const result = await skipOccurrenceInDb(db, actor, target, { ...provenance, operation: "skip_occurrence" }, {}, options.expect);
      return { ...result, undo: await eventIds(db, [result.task.id]) };
    }),
  );
}

export async function archiveAsSkipInDb(db: Db, actor: Actor, task: Task, provenance: Provenance) {
  if (!task.seriesId || task.completedAt || task.archivedAt || !task.occursOn) return null;
  const peek = await readSeries(db, task.seriesId);
  if (!peek || peek.current_task_id !== task.id || stopped(peek)) return null;
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || stopped(row)) return null;
  const next = nextOccurrence(patternOf(row), await changesOf(db, row.id, task.occursOn), task.occursOn);
  if (!next) return null;
  return moveCurrent(db, actor, row, task, next, [task.occursOn], "skipped", { ...provenance, operation: provenance.operation === "archive_task" ? "skip_occurrence" : provenance.operation }, { archived: true });
}

export async function skipDeletedOccurrenceInDb(db: Db, actor: Actor, taskId: string, provenance: Provenance) {
  const task = await readTaskInDb(db, actor, taskId);
  if (!task?.seriesId || task.completedAt || task.archivedAt) return false;
  const row = await readSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || stopped(row)) return false;
  const next = nextOccurrence(patternOf(row), await changesOf(db, row.id, task.occursOn), task.occursOn!);
  if (!next) return false;
  await db.query(
    `update crm.tasks set clickup_task_id = null, clickup_url = null, clickup_error = null, clickup_synced_at = null, clickup_sync = '{}'::jsonb where id = $1`,
    [taskId],
  );
  await skipOccurrenceInDb(db, actor, { taskId }, { ...provenance, operation: "skip_occurrence" }, { goneFromClickUp: true });
  return true;
}

const SERIES_FIELDS = ["title", "description", "priority", "ownerId", "durationMinutes", "remindMinutes"] as const;
const LINK_FIELDS = ["companyId", "contactId", "opportunityId"] as const;

export function touchesSeries(task: Pick<Task, "dueAt" | "dueHasTime" | "occursOn">, input: TaskWrite) {
  if (SERIES_FIELDS.some((field) => input[field] !== undefined)) return true;
  const due = input.dueAt ?? input.dueDate;
  if (due === undefined) return false;
  if (due === null || due === "") return true;
  if (input.dueDate !== undefined) return task.dueHasTime;
  const day = taskDueDay(input.dueAt ?? null);
  return day === taskDueDay(task.dueAt) && (!task.dueHasTime || clockLabel(input.dueAt!) !== (task.dueAt ? clockLabel(task.dueAt) : null));
}

async function writeChangeRow(db: Db, actor: Actor, row: SeriesRow, task: Task, occursOn: string, input: TaskWrite, provenance: Provenance) {
  const unsupported = ["priority", "ownerId", "companyId", "contactId", "opportunityId", "remindMinutes", "mailThreadKey", "completed"].find((field) => input[field as keyof TaskWrite] !== undefined);
  if (unsupported) {
    throw new CrmError("invalid_input", "Only the day, time, length, title and description can change for one upcoming date. Use repeatScope all for the rest.", 400, { field: unsupported });
  }
  const before = (await changesOf(db, row.id)).find((change) => change.occursOn === occursOn) ?? null;
  const base = occurrenceFor(patternOf(row), occursOn, before ?? undefined);
  let dueAt: string | null = before?.dueAt ?? null;
  let dueHasTime: boolean | null = before?.dueHasTime ?? null;
  const probe = input.dueAt !== undefined || input.dueDate !== undefined ? await createTaskProbe(input) : null;
  if (probe) {
    if (!probe.dueAt) throw new CrmError("invalid_input", "An upcoming date needs a day. Skip it instead.", 400, { field: "dueAt" });
    dueAt = probe.dueAt;
    dueHasTime = probe.dueHasTime;
  }
  if (input.durationMinutes !== undefined && (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 480)) {
    throw new CrmError("invalid_input", "Choose a duration between 5 and 480 minutes.", 400, { field: "durationMinutes" });
  }
  const title = input.title !== undefined ? input.title.trim().slice(0, 200) || null : (before?.title ?? null);
  await db.query(
    `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, due_at, due_has_time, duration_minutes, title, description, created_by)
     values ($1, $2, false, $3, $4, $5, $6, $7, $8)
     on conflict (series_id, occurs_on) do update set skip = false, due_at = excluded.due_at, due_has_time = excluded.due_has_time,
       duration_minutes = excluded.duration_minutes, title = excluded.title, description = excluded.description`,
    [
      row.id,
      occursOn,
      dueAt,
      dueAt ? dueHasTime : null,
      input.durationMinutes ?? before?.durationMinutes ?? null,
      title,
      input.description !== undefined ? input.description : (before?.description ?? null),
      actor.type === "user" ? actor.userId : null,
    ],
  );
  await refreshRoll(db, actor, row.id);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { changed: occursOn, changeBefore: before, was: { dueAt: base.dueAt } }));
}

async function resetTimedChanges(db: Db, seriesId: string, after: string) {
  const rows = await changesOf(db, seriesId, after);
  const timed = rows.filter((row) => row.dueAt && !row.skip);
  if (timed.length === 0) return [];
  await db.query("update crm.task_occurrence_changes set due_at = null, due_has_time = null where series_id = $1 and occurs_on > $2::date and due_at is not null and not skip", [seriesId, after]);
  await db.query(
    "delete from crm.task_occurrence_changes where series_id = $1 and occurs_on > $2::date and not skip and due_at is null and duration_minutes is null and title is null and description is null",
    [seriesId, after],
  );
  return timed;
}

export async function countResetDates(actor: Actor, taskId: string) {
  return withActor(actor, async (db) => {
    const task = await readTaskInDb(db, actor, taskId);
    if (!task?.seriesId) return 0;
    return (await changesOf(db, task.seriesId, task.occursOn)).filter((row) => row.dueAt && !row.skip).length;
  });
}

function seriesUpdate(row: SeriesRow, task: Task, input: TaskWrite, timeTouched: boolean) {
  const relinks = input.companyId !== undefined || input.contactId !== undefined || input.opportunityId !== undefined;
  const next = {
    title: input.title !== undefined ? task.title : row.title,
    description: input.description !== undefined ? task.description : row.description,
    priority: input.priority !== undefined ? task.priority : row.priority,
    owner_id: input.ownerId !== undefined ? task.ownerId : row.owner_id,
    company_id: relinks ? task.companyId : row.company_id,
    contact_id: relinks ? task.contactId : row.contact_id,
    opportunity_id: relinks ? task.opportunityId : row.opportunity_id,
    duration_minutes: input.durationMinutes !== undefined ? task.durationMinutes : row.duration_minutes,
    at: timeTouched ? (task.dueHasTime && task.dueAt ? clockLabel(task.dueAt) : null) : row.at,
    remind_minutes: row.remind_minutes as number | null,
  };
  if (input.remindMinutes !== undefined || timeTouched) next.remind_minutes = task.dueHasTime ? task.remindMinutes : null;
  if (!next.at) next.remind_minutes = null;
  if (input.ownerId !== undefined && task.ownerId && !task.dueHasTime && row.at && !timeTouched) {
    next.at = null;
    next.remind_minutes = null;
  }
  return next;
}

async function writeSeries(db: Db, id: string, values: ReturnType<typeof seriesUpdate>) {
  await db.query(
    `update crm.task_series set title = $2, description = $3, priority = $4, owner_id = $5, company_id = $6, contact_id = $7,
       opportunity_id = $8, duration_minutes = $9, at = $10::time, remind_minutes = $11
     where id = $1`,
    [id, values.title, values.description, values.priority, values.owner_id, values.company_id, values.contact_id, values.opportunity_id, values.duration_minutes, values.at, values.remind_minutes],
  );
}

function currentWrite(task: Task, input: TaskWrite, future: boolean): TaskWrite {
  if (!future) return input;
  const write: TaskWrite = { ...input };
  delete write.dueDate;
  delete write.dueAt;
  delete write.dueHasTime;
  if (input.dueAt && input.dueHasTime !== false) {
    const day = taskDueDay(task.dueAt) ?? today();
    const [hour, minute] = clockLabel(input.dueAt).split(":").map(Number);
    write.dueAt = occurrenceTiming(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, day).dueAt;
    write.dueHasTime = true;
  } else if (input.dueDate !== undefined && input.dueDate !== null && task.dueAt) write.dueDate = taskDueDay(task.dueAt);
  return write;
}

async function editAll(db: Db, actor: Actor, row: SeriesRow, task: Task, input: TaskWrite, future: boolean, provenance: Provenance) {
  const write = currentWrite(task, input, future);
  if (write.ownerId !== undefined && (write.ownerId || null) !== row.owner_id) await assertRoom(db, actor.workspaceId, write.ownerId || null);
  const timeTouched = write.dueAt !== undefined || write.dueDate !== undefined;
  const saved = Object.keys(write).length > 0 ? await writeOccurrence(db, actor, row, task, write, provenance) : task;
  const values = seriesUpdate(row, saved, write, timeTouched);
  const reset = values.at !== row.at ? await resetTimedChanges(db, row.id, saved.occursOn ?? row.starts_on) : [];
  await writeSeries(db, row.id, values);
  await refreshRoll(db, actor, row.id);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { scope: "all", resetChanges: reset }));
  return (await readTaskInDb(db, actor, task.id))!;
}

async function editFollowing(db: Db, actor: Actor, row: SeriesRow, task: Task, occursOn: string, input: TaskWrite, provenance: Provenance) {
  const pattern = patternOf(row);
  const changes = await changesOf(db, row.id, shiftDay(occursOn, -1));
  const kept = "count" in row.ends ? row.ends : null;
  const firstChange = changes.find((change) => change.occursOn === occursOn);
  const probe = input.dueAt !== undefined || input.dueDate !== undefined ? await createTaskProbe(input) : null;
  const at = probe ? (probe.dueHasTime && probe.dueAt ? clockLabel(probe.dueAt) : null) : row.at;
  let ends: RepeatEnds = row.ends;
  if (kept) {
    const last = lastOccurrence(pattern);
    let left = 0;
    for (let day: string | null = occursOn; day && last && day <= last; day = occurrenceAfter(pattern, day)) left += 1;
    ends = { count: Math.max(1, left) };
  }
  const split = await db.query<{ id: string }>(
    `insert into crm.task_series (
       workspace_id, owner_id, created_by_user_id, created_by_agent_id, title, description, priority, company_id, contact_id, opportunity_id,
       starts_on, at, duration_minutes, remind_minutes, rule, ends, split_from_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::time, $13, $14, $15::jsonb, $16::jsonb, $17)
     returning id`,
    [
      row.workspace_id,
      row.owner_id,
      actor.type === "user" ? actor.userId : null,
      actor.type === "agent" ? actor.agentId : null,
      input.title?.trim().slice(0, 200) || row.title,
      input.description !== undefined ? input.description : row.description,
      row.priority,
      row.company_id,
      row.contact_id,
      row.opportunity_id,
      occursOn,
      at,
      input.durationMinutes ?? row.duration_minutes,
      at ? row.remind_minutes : null,
      JSON.stringify(row.rule),
      JSON.stringify(ends),
      row.id,
    ],
  );
  const newId = split.rows[0].id;
  const moving = changes.filter((change) => change.occursOn >= occursOn);
  for (const change of moving) {
    const retimed = at !== row.at && change.dueAt && change.occursOn !== occursOn;
    await db.query(
      `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, due_at, due_has_time, duration_minutes, title, description, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
      [newId, change.occursOn, change.skip ?? false, retimed ? null : change.dueAt, retimed ? null : change.dueAt ? change.dueHasTime : null, change.durationMinutes ?? null, change.title ?? null, change.description ?? null, actor.type === "user" ? actor.userId : null],
    );
  }
  if (probe?.dueAt && firstChange?.dueAt) {
    await db.query("update crm.task_occurrence_changes set due_at = $3, due_has_time = $4 where series_id = $1 and occurs_on = $2", [newId, occursOn, probe.dueAt, probe.dueHasTime]);
  }
  await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on >= $2::date", [row.id, occursOn]);
  const until = shiftDay(occursOn, -1);
  await db.query(`update crm.task_series set ends = jsonb_build_object('until', $2::text) where id = $1`, [row.id, until]);
  const parent = (await readSeries(db, row.id))!;
  const parentNext = task.completedAt ? null : nextOccurrence(patternOf(parent), await changesOf(db, row.id, task.occursOn), task.occursOn ?? until);
  if (!parentNext && (task.completedAt || row.current_task_id !== task.id)) await finishSeries(db, actor, parent, task, provenance);
  await refreshRoll(db, actor, row.id);
  const after = await readSeries(db, row.id);
  const splitRow = await readSeries(db, newId);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { scope: "following", split: { seriesId: newId, from: occursOn }, movedChanges: moving }));
  if (splitRow?.current_task_id) {
    await recordAudit(db, actor, "task_series.created", "task", splitRow.current_task_id, provenance, { series: { id: newId, before: null, after: snapshotOf(splitRow) }, splitFrom: row.id });
  }
  return (await readTaskInDb(db, actor, task.id))!;
}

export async function updateOccurrenceInDb(db: Db, actor: Actor, target: OccurrenceTarget, input: TaskWrite, scope: RepeatScope | undefined, provenance: Provenance) {
  const found = await resolveTarget(db, actor, target);
  const { task, row } = found;
  if (!row && (scope === "all" || scope === "following")) hiddenSeries(actor, task, "repeatScope");
  const plain = !row || !found.occursOn || (!found.future && (stopped(row) || task.completedAt || row.current_task_id !== task.id));
  if (plain) return (await updateTaskInDb(db, actor, task.id, input, provenance)).task;
  if (input.dueAt === null || input.dueDate === null || input.dueAt === "" || input.dueDate === "") {
    throw new CrmError("invalid_input", "A repeating task needs a day. Stop repeating first.", 400, { field: "dueAt" });
  }
  const touches = touchesSeries(task, input) || found.future;
  if (touches && !scope) throw new CrmError("invalid_input", NEEDS_SCOPE, 400, { field: "repeatScope" });
  const relinks = LINK_FIELDS.some((field) => input[field] !== undefined);
  if ((!touches && !(relinks && (scope === "all" || scope === "following"))) || scope === "this") {
    if (!found.future) {
      const saved = (await updateTaskInDb(db, actor, task.id, input, provenance, { series: seriesRights(row) })).task;
      if (input.ownerId !== undefined && actor.type === "user" && row.owner_id && row.owner_id !== (input.ownerId || null) && (await memberOrNull(db, row.workspace_id, row.owner_id))) {
        await addTaskParticipantsInDb(db, actor, task.id, [row.owner_id], provenance, { alert: false });
      }
      if (!scope && LINK_FIELDS.some((field) => input[field] !== undefined)) {
        await syncSeriesLinksInDb(db, actor, task.id, provenance);
        return (await readTaskInDb(db, actor, task.id))!;
      }
      return saved;
    }
    assertSeriesChange(actor, row);
    await writeChangeRow(db, actor, row, task, found.occursOn!, input, provenance);
    return (await readTaskInDb(db, actor, task.id))!;
  }
  assertSeriesChange(actor, row);
  if (stopped(row) && found.future) throw new CrmError("invalid_input", "It doesn't repeat any more.", 400, { field: "repeatScope" });
  if (scope === "following" && found.future) return editFollowing(db, actor, row, task, found.occursOn!, input, provenance);
  return editAll(db, actor, row, task, input, found.future, provenance);
}

async function stopLaterParts(db: Db, actor: Actor, seriesId: string) {
  const parts = await db.query<SeriesRow>(
    `${SERIES_SQL} where s.id in (select id from crm.series_later_parts($1)) and s.current_task_id is null and s.ended_at is null and s.archived_at is null for update`,
    [seriesId],
  );
  const mine = parts.rows.filter((part) => ownsSeries(actor, part)).map((part) => part.id);
  if (mine.length) await db.query("update crm.task_series set ended_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null where id = any($1::uuid[])", [mine]);
  return mine;
}

async function restartLaterParts(db: Db, actor: Actor, ids: unknown) {
  if (!Array.isArray(ids)) return;
  const wanted = ids.filter((id): id is string => typeof id === "string" && isUuid(id));
  if (!wanted.length) return;
  const parts = await db.query<SeriesRow>(`${SERIES_SQL} where s.id = any($1::uuid[]) and s.archived_at is null for update`, [wanted]);
  const mine = parts.rows.filter((part) => ownsSeries(actor, part)).map((part) => part.id);
  if (mine.length) await db.query("update crm.task_series set ended_at = null where id = any($1::uuid[])", [mine]);
}

export async function setRepeatInDb(db: Db, actor: Actor, taskId: string, repeat: unknown, provenance: Provenance, now = Date.now()) {
  if (!isUuid(taskId)) throw notFound("task");
  const found = await resolveTarget(db, actor, { taskId });
  const { task, row } = found;
  if (!row) hiddenSeries(actor, task, "repeat");
  if (row && !stopped(row) ? !ownsSeries(actor, row) : !canChangeTask(actor, task)) {
    throw new CrmError("forbidden", row && !stopped(row) ? seriesRefusal(actor, task) : "Only the assignee or the task's creator can change how it repeats.", 403, { field: "repeat" });
  }
  if (repeat === null) {
    if (!row || stopped(row)) return task;
    await db.query("update crm.task_series set ended_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
    const stoppedParts = await stopLaterParts(db, actor, row.id);
    const dropped = await changesOf(db, row.id, task.occursOn);
    await db.query("delete from crm.task_occurrence_changes where series_id = $1", [row.id]);
    const after = await readSeries(db, row.id);
    await recordAudit(db, actor, "task_series.ended", "task", task.id, provenance, auditSeries(row, after, { droppedChanges: dropped, ...(stoppedParts.length ? { stoppedParts } : {}) }));
    return (await readTaskInDb(db, actor, task.id))!;
  }
  if (task.completedAt) throw new CrmError("invalid_input", "This task is done. Reopen it first.", 400, { field: "repeat" });
  const start = startOf(task, now);
  const day = task.occursOn && row && !stopped(row) ? (taskDueDay(task.dueAt) ?? task.occursOn) : start.day;
  const keepsEnd = row && !stopped(row) && repeat && typeof repeat === "object" && !Array.isArray(repeat) && !("ends" in repeat);
  const { rule, ends } = readRepeat(keepsEnd ? { ...(repeat as object), ends: repeatInputOf(row.rule, row.ends).ends ?? null } : repeat, day, now);
  if (!row || stopped(row)) {
    await assertRoom(db, actor.workspaceId, task.ownerId);
    checkLengths(task);
    if (row) await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    let current = task;
    if (!task.dueAt) current = (await updateTaskInDb(db, actor, task.id, { dueDate: day }, provenance)).task;
    const inserted = await db.query<{ id: string }>(
      `insert into crm.task_series (
         workspace_id, owner_id, created_by_user_id, created_by_agent_id, title, description, priority, company_id, contact_id, opportunity_id,
         starts_on, at, duration_minutes, remind_minutes, rule, ends
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::time, $13, $14, $15::jsonb, $16::jsonb)
       returning id`,
      [
        current.workspaceId,
        current.ownerId,
        actor.type === "user" ? actor.userId : null,
        actor.type === "agent" ? actor.agentId : null,
        current.title,
        current.description,
        current.priority,
        current.companyId,
        current.contactId,
        current.opportunityId,
        day,
        start.at,
        current.durationMinutes,
        start.at ? current.remindMinutes : null,
        JSON.stringify(rule),
        JSON.stringify(ends),
      ],
    );
    await db.query("update crm.tasks set series_id = $2, occurs_on = $3 where id = $1", [current.id, inserted.rows[0].id, day]);
    await db.query("update crm.task_series set current_task_id = $2 where id = $1", [inserted.rows[0].id, current.id]);
    await refreshRoll(db, actor, inserted.rows[0].id);
    const created = (await readSeries(db, inserted.rows[0].id))!;
    await recordAudit(db, actor, "task_series.created", "task", current.id, provenance, { series: { id: created.id, before: null, after: snapshotOf(created) } });
    return (await readTaskInDb(db, actor, current.id))!;
  }
  assertSeriesChange(actor, row);
  const consumed = task.occursOn ? occurrenceDays({ ...patternOf(row), ends: { never: true } }, row.starts_on, shiftDay(task.occursOn, -1), MAX_COUNT + 1).length : 0;
  const samePattern = sameRule(rule, row.rule);
  if (samePattern && JSON.stringify(ends) === JSON.stringify(row.ends)) return task;
  if (samePattern) {
    if ("until" in ends && ends.until < (task.occursOn ?? day)) throw new CrmError("invalid_input", "The end date is before the first one.", 400, { field: "repeat.ends" });
    await db.query("update crm.task_series set ends = $2::jsonb where id = $1", [row.id, JSON.stringify(ends)]);
    const removed = "until" in ends ? await changesOf(db, row.id, ends.until) : [];
    if ("until" in ends) await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on > $2::date", [row.id, ends.until]);
    await refreshRoll(db, actor, row.id);
    const after = await readSeries(db, row.id);
    await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { droppedChanges: removed }));
    return (await readTaskInDb(db, actor, task.id))!;
  }
  const dropped = await changesOf(db, row.id);
  const taken = await db.query("select 1 from crm.tasks where series_id = $1 and id <> $2 and occurs_on = $3::date and archived_at is null", [row.id, task.id, day]);
  const startDay = (taken.rowCount ?? 0) > 0 && task.occursOn ? task.occursOn : day;
  const kept: RepeatEnds = "count" in ends ? { count: ends.count, spent: Math.min(consumed, ends.count - 1) } : ends;
  await db.query("delete from crm.task_occurrence_changes where series_id = $1", [row.id]);
  await db.query("update crm.task_series set rule = $2::jsonb, ends = $3::jsonb, starts_on = $4 where id = $1", [row.id, JSON.stringify(rule), JSON.stringify(kept), startDay]);
  await db.query("update crm.tasks set occurs_on = $2 where id = $1", [task.id, startDay]);
  await refreshRoll(db, actor, row.id);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { scope: "all", droppedChanges: dropped, occursOnBefore: task.occursOn }));
  return (await readTaskInDb(db, actor, task.id))!;
}

export async function endSeriesOnInDb(db: Db, actor: Actor, taskId: string, until: string, provenance: Provenance) {
  if (!isDayKey(until)) throw new CrmError("invalid_input", "Choose an end date.", 400, { field: "until" });
  const found = await resolveTarget(db, actor, { taskId });
  if (!found.row) {
    hiddenSeries(actor, found.task, "until");
    throw new CrmError("invalid_input", "This task doesn't repeat.", 400, { field: "until" });
  }
  return setRepeatInDb(db, actor, taskId, { ...repeatInputOf(found.row.rule, found.row.ends), ends: { on: until } }, provenance);
}

export async function deleteSeriesInDb(db: Db, actor: Actor, taskId: string, provenance: Provenance) {
  if (!isUuid(taskId)) throw notFound("task");
  const given = await readTaskInDb(db, actor, taskId);
  if (!given || given.workspaceId !== actor.workspaceId) throw notFound("task");
  if (!given.seriesId) throw new CrmError("invalid_input", "This task doesn't repeat.", 400);
  const peek = await readSeries(db, given.seriesId);
  if (!peek) hiddenSeries(actor, given, "repeat");
  if (!peek || peek.archived_at) throw notFound("task");
  const openId = peek.current_task_id;
  if (openId) await lockOccurrence(db, openId);
  const row = await lockSeries(db, given.seriesId);
  if (!row) hiddenSeries(actor, given, "repeat");
  if (!row) throw notFound("task");
  if (row.current_task_id && row.current_task_id !== openId) await lockOccurrence(db, row.current_task_id);
  const open = row.current_task_id ? await readTaskInDb(db, actor, row.current_task_id) : null;
  assertSeriesChange(actor, row);
  await db.query("update crm.task_series set archived_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
  const stoppedParts = await stopLaterParts(db, actor, row.id);
  const anchor = open && !open.completedAt && !open.archivedAt ? open : given;
  if (anchor === open) await writeOccurrence(db, actor, row, open, {}, provenance, { archive: true });
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.deleted", "task", anchor.id, provenance, auditSeries(row, after, { archivedTask: anchor === open ? open.id : null, ...(stoppedParts.length ? { stoppedParts } : {}) }));
  return (await readTaskInDb(db, actor, anchor.id))!;
}

async function mutate<T>(actor: Actor, operation: string, payload: unknown, options: MutationOptions, run: (db: Db, provenance: Provenance) => Promise<T>) {
  assertScope(actor.scopes, "tasks:write");
  const provenance = { ...(options.provenance ?? {}), operation: options.provenance?.operation ?? operation };
  const hash = requestHash(operation, { payload, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const result = await run(db, provenance);
      return result;
    }),
  );
}

export type SeriesResult = { task: Task; undo: string[] };

async function withUndo(db: Db, task: Task): Promise<SeriesResult> {
  return { task, undo: await eventIds(db, [task.id]) };
}

export function setTaskRepeat(actor: Actor, taskId: string, repeat: unknown, options: MutationOptions = {}) {
  return mutate(actor, repeat === null ? "stop_repeating" : "set_repeat", { taskId, repeat }, options, async (db, provenance) =>
    withUndo(db, await setRepeatInDb(db, actor, taskId, repeat, provenance)),
  );
}

export function endSeriesOn(actor: Actor, taskId: string, until: string, options: MutationOptions = {}) {
  return mutate(actor, "end_repeat", { taskId, until }, options, async (db, provenance) => withUndo(db, await endSeriesOnInDb(db, actor, taskId, until, provenance)));
}

export function deleteSeries(actor: Actor, taskId: string, options: MutationOptions = {}) {
  return mutate(actor, "delete_series", { taskId }, options, async (db, provenance) => withUndo(db, await deleteSeriesInDb(db, actor, taskId, provenance)));
}

export function updateOccurrence(actor: Actor, target: OccurrenceTarget, input: TaskWrite, scope: RepeatScope | undefined, options: MutationOptions = {}) {
  return mutate(actor, "update_task", { target, input, scope }, options, async (db, provenance) => {
    const task = await updateOccurrenceInDb(db, actor, target, input, scope, provenance);
    return { task, undo: await eventIds(db, [task.id]) };
  });
}

export type RepeatHistoryItem = { kind: "done" | "missed" | "skipped"; day: string };

export async function readRepeatHistory(actor: Actor, taskId: string, limit = 6): Promise<RepeatHistoryItem[]> {
  if (!isUuid(taskId)) return [];
  return withActor(actor, async (db) => {
    const task = await readTaskInDb(db, actor, taskId);
    if (!task?.seriesId) return [];
    const done = await db.query<{ day: string }>(
      `select occurs_on::text as day from crm.tasks
       where series_id = $1 and completed_at is not null and archived_at is null and occurs_on is not null
       order by occurs_on desc limit $2`,
      [task.seriesId, limit],
    );
    const moves = await db.query<{ repeat: { kind?: string; passed?: string[] } | null; id: string }>(
      `select e.id, e.changes -> 'repeat' as repeat from crm.audit_events e
       where e.entity_type = 'task'
         and e.entity_id in (select t.id from crm.tasks t where t.series_id = $1)
         and e.changes -> 'repeat' ->> 'seriesId' = $1::text
         and e.changes -> 'repeat' ->> 'kind' in ('missed', 'skipped')
         and not exists (select 1 from crm.audit_events u where u.event_type like '%.undone' and u.changes ->> 'undoes' = e.id::text)
       order by e.created_at desc limit 30`,
      [task.seriesId],
    );
    const items: RepeatHistoryItem[] = done.rows.map((row) => ({ kind: "done", day: row.day }));
    for (const row of moves.rows) {
      const kind = row.repeat?.kind === "skipped" ? "skipped" : "missed";
      for (const day of row.repeat?.passed ?? []) if (isDayKey(day)) items.push({ kind, day });
    }
    const seen = new Set<string>();
    return items
      .sort((left, right) => right.day.localeCompare(left.day))
      .filter((item) => {
        if (seen.has(item.day) || item.day >= (task.occursOn ?? "9999")) return false;
        seen.add(item.day);
        return true;
      })
      .slice(0, limit);
  });
}

export async function restoreSeriesInDb(db: Db, actor: Actor, changes: Record<string, unknown>, provenance: Provenance) {
  const series = changes.series as { id?: string; before?: SeriesSnapshot | null } | undefined;
  if (!series?.id) return;
  const splitId = (changes.split as { seriesId?: string } | undefined)?.seriesId;
  const child = splitId ? await readSeries(db, splitId) : null;
  if (child?.current_task_id) await lockOccurrence(db, child.current_task_id);
  const row = await lockSeries(db, series.id);
  if (!row || !ownsSeries(actor, row)) throw new CrmError("cannot_undo", "Can't undo: you can't change how this task repeats.", 409);
  const before = series.before;
  const revives = Boolean(before && ((row.archived_at && !before.archivedAt) || (row.ended_at && !before.endedAt)));
  if (revives && !row.current_task_id) throw new CrmError("cannot_undo", "Can't undo: its open task has left the repeating task.", 409);
  if (!before) {
    await db.query("update crm.task_series set archived_at = coalesce(archived_at, now()), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
    if (row.current_task_id) {
      const task = await readTaskInDb(db, actor, row.current_task_id);
      if (task && changes.withTask && !task.archivedAt) await writeOccurrence(db, actor, row, task, {}, provenance, { archive: true });
      else if (task) await writeOccurrence(db, actor, row, task, {}, provenance, { detach: true });
    }
    return;
  }
  const split = changes.split as { seriesId?: string } | undefined;
  if (split?.seriesId) {
    const child = await lockSeries(db, split.seriesId);
    if (child?.current_task_id) {
      const created = await readTaskInDb(db, actor, child.current_task_id);
      if (created && !created.archivedAt) await writeOccurrence(db, actor, child, created, {}, provenance, { archive: true });
    }
    await db.query("update crm.task_series set archived_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [split.seriesId]);
  }
  await db.query(
    `update crm.task_series set title = $2, description = $3, priority = $4, owner_id = $5, company_id = $6, contact_id = $7, opportunity_id = $8,
       starts_on = $9, at = $10::time, duration_minutes = $11, remind_minutes = $12, rule = $13::jsonb, ends = $14::jsonb,
       ended_at = $15, archived_at = $16
     where id = $1`,
    [
      row.id,
      before.title,
      before.description,
      before.priority,
      (await memberOrNull(db, row.workspace_id, before.ownerId)) ?? row.owner_id,
      before.companyId,
      before.contactId,
      before.opportunityId,
      before.startsOn,
      before.at,
      before.durationMinutes,
      before.remindMinutes,
      JSON.stringify(before.rule),
      JSON.stringify(before.ends),
      before.endedAt,
      before.archivedAt,
    ],
  );
  await restartLaterParts(db, actor, changes.stoppedParts);
  if (!before.archivedAt && row.archived_at && row.current_task_id) {
    const current = await readTaskInDb(db, actor, row.current_task_id);
    if (current?.archivedAt) await unarchiveTaskInDb(db, actor, current.id, provenance, { series: seriesRights(row) });
  }
  if (typeof changes.occursOnBefore === "string" && row.current_task_id) {
    await db.query("update crm.tasks set occurs_on = $2 where id = $1", [row.current_task_id, changes.occursOnBefore]);
  }
  const rows = [
    ...((changes.droppedChanges as ChangeRow[] | undefined) ?? []),
    ...((changes.resetChanges as ChangeRow[] | undefined) ?? []),
    ...((changes.movedChanges as ChangeRow[] | undefined) ?? []),
  ];
  const single = changes.changeBefore as ChangeRow | null | undefined;
  const touched = (changes.skipped ?? changes.changed) as string | undefined;
  if (touched) {
    await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on = $2", [row.id, touched]);
    if (single) rows.push(single);
  }
  for (const change of rows) await putChange(db, actor, row.id, change);
  await refreshRoll(db, actor, row.id);
}

async function putChange(db: Db, actor: Actor, seriesId: string, change: ChangeRow) {
  await db.query(
    `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, due_at, due_has_time, duration_minutes, title, description, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (series_id, occurs_on) do update set skip = excluded.skip, due_at = excluded.due_at, due_has_time = excluded.due_has_time,
       duration_minutes = excluded.duration_minutes, title = excluded.title, description = excluded.description`,
    [
      seriesId,
      change.occursOn,
      Boolean(change.skip),
      change.dueAt ?? null,
      change.dueAt ? Boolean(change.dueHasTime) : null,
      change.durationMinutes ?? null,
      change.title ?? null,
      change.description ?? null,
      actor.type === "user" ? actor.userId : null,
    ],
  );
}

export async function restoreOccurrenceInDb(db: Db, actor: Actor, taskId: string, repeat: Record<string, unknown>) {
  const from = repeat.from;
  const seriesId = repeat.seriesId;
  if (typeof from !== "string" || typeof seriesId !== "string") return;
  await db.query("update crm.tasks set occurs_on = $2 where id = $1 and series_id = $3", [taskId, from, seriesId]);
  const row = await readSeries(db, seriesId);
  if (row && ownsSeries(actor, row)) for (const change of (repeat.consumed as ChangeRow[] | undefined) ?? []) await putChange(db, actor, seriesId, change);
  await refreshRoll(db, actor, seriesId);
}

export type RepeatFields = { repeat?: unknown; repeatScope?: RepeatScope; skip?: boolean; seriesId?: string; occursOn?: string };

const REPEAT_KEYS = new Set(["repeat", "repeatScope", "skip", "seriesId", "occursOn"]);

function plainWrite<T extends TaskWrite & RepeatFields>(input: T): TaskWrite {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined && !REPEAT_KEYS.has(key))) as TaskWrite;
}

export async function createTaskFromApi(actor: Actor, input: TaskWrite & { repeat?: unknown }, options: MutationOptions = {}): Promise<MutationOutcome<{ task: Task }>> {
  assertScope(actor.scopes, "tasks:write");
  const write = plainWrite(input);
  const provenance = options.provenance ?? { operation: "create_task" };
  const hash = requestHash("create_task", { input: input.repeat ? input : write, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 201, async () => ({
      task: input.repeat ? await createRepeatingTaskInDb(db, actor, write, input.repeat, provenance) : (await createTaskInDb(db, actor, write, provenance))!,
    })),
  );
}

export async function updateTaskFromApi(
  actor: Actor,
  target: { taskId?: string; seriesId?: string; occursOn?: string },
  input: TaskWrite & RepeatFields,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ task: Task; skipped?: string }>> {
  assertScope(actor.scopes, "tasks:write");
  const write = plainWrite(input);
  const provenance = options.provenance ?? { operation: "update_task" };
  const scope = input.repeatScope;
  if (scope !== undefined && !REPEAT_SCOPES.includes(scope)) throw new CrmError("invalid_input", "repeatScope is this, following or all.", 400, { field: "repeatScope" });
  const hash = requestHash("update_task", { target, input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      let occurrence: OccurrenceTarget;
      const given = target.taskId && isUuid(target.taskId) ? await readTaskInDb(db, actor, target.taskId) : null;
      if (target.taskId && target.seriesId && given?.seriesId !== target.seriesId) {
        throw new CrmError("invalid_input", "That task isn't part of that repeating task. Send taskId or seriesId, not both.", 400, { field: "seriesId" });
      }
      if (target.occursOn) {
        if (target.taskId && !given) throw notFound("task");
        if (given && !given.seriesId) throw new CrmError("invalid_input", "This task doesn't repeat.", 400, { field: "occursOn" });
        const seriesId = target.seriesId ?? given?.seriesId ?? null;
        if (!seriesId) throw notFound("task");
        occurrence = { seriesId, occursOn: target.occursOn };
      } else if (target.taskId) occurrence = { taskId: target.taskId };
      else throw notFound("task");
      const fields = Object.keys(write).length > 0;
      if (input.skip === true) {
        if (fields || input.repeat !== undefined) throw new CrmError("invalid_input", "Send skip on its own.", 400, { field: "skip" });
        const result = await skipOccurrenceInDb(db, actor, occurrence, { ...provenance, operation: "skip_occurrence" });
        return { task: result.task, skipped: result.skipped };
      }
      let task: Task | null = null;
      if (input.repeat !== undefined) {
        if (!("taskId" in occurrence)) throw new CrmError("invalid_input", "Change how it repeats from the open task.", 400, { field: "repeat" });
        task = await setRepeatInDb(db, actor, occurrence.taskId, input.repeat, { ...provenance, operation: input.repeat === null ? "stop_repeating" : "set_repeat" });
      }
      if (fields || !task) task = await updateOccurrenceInDb(db, actor, occurrence, write, scope, provenance);
      return { task };
    }),
  );
}

async function syncSeriesLinksInDb(db: Db, actor: Actor, taskId: string, provenance: Provenance) {
  const task = await readTaskInDb(db, actor, taskId);
  if (!task?.seriesId || task.completedAt) return;
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || stopped(row) || !ownsSeries(actor, row)) return;
  if (row.company_id === task.companyId && row.contact_id === task.contactId && row.opportunity_id === task.opportunityId) return;
  await db.query("update crm.task_series set company_id = $2, contact_id = $3, opportunity_id = $4 where id = $1", [row.id, task.companyId, task.contactId, task.opportunityId]);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { scope: "all" }));
}

export async function followSeriesLinks(actor: Actor, taskId: string, provenance: Provenance = { operation: "link_task" }) {
  if (!isUuid(taskId)) return;
  await withActor(actor, (db) => syncSeriesLinksInDb(db, actor, taskId, provenance));
}

export async function readSeriesTitle(actor: Actor, seriesId: string) {
  if (!isUuid(seriesId)) return null;
  return withActor(actor, async (db) => (await readSeries(db, seriesId))?.title ?? null);
}

export async function seriesRightsRefusal(actor: Actor, target: { taskId?: string; seriesId?: string; occursOn?: string; seriesWide?: boolean }) {
  const id = target.taskId && isUuid(target.taskId) ? target.taskId : null;
  const seriesId = target.seriesId && isUuid(target.seriesId) ? target.seriesId : null;
  if (!id && !seriesId) return null;
  return withActor(actor, async (db) => {
    const sid = seriesId ?? (await readTaskInDb(db, actor, id!))?.seriesId ?? null;
    const row = sid ? await readSeries(db, sid) : null;
    if (!row || stopped(row)) return null;
    if (!target.seriesWide && target.occursOn) {
      const current = row.current_task_id ? await readTaskInDb(db, actor, row.current_task_id) : null;
      if (current?.occursOn === target.occursOn) return null;
    }
    if (ownsSeries(actor, row)) return null;
    const open = row.current_task_id ? await readTaskInDb(db, actor, row.current_task_id) : null;
    return open ? seriesRefusal(actor, open) : SERIES_RIGHTS;
  });
}
