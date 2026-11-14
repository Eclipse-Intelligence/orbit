import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError, notFound } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit, replayOrRun, requestHash, type MutationOptions, type MutationOutcome } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { queueTaskBlock } from "@/lib/crm/task-block-queue";
import { withoutViewerMail } from "@/lib/crm/task-mail";
import { clockLabel, dayStartIso, taskDueDay, taskDueEnd } from "@/lib/crm/task-time";
import { readDateTime } from "@/lib/time";
import { archiveTaskInDb, canChangeTask, createTaskInDb, readTaskInDb, unarchiveTaskInDb, updateTaskInDb } from "@/lib/crm/tasks";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import {
  checkEnds,
  checkRule,
  firstPatternDay,
  isDayKey,
  lastOccurrence,
  nextOccurrence,
  normalRule,
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
} from "@/lib/task-repeat";
import type { Actor, Provenance, Task, TaskPriority, TaskWrite, WorkspaceRole } from "@/lib/crm/types";

export const MAX_ACTIVE_SERIES = 200;
export const TOO_MANY_SERIES = "You have 200 repeating tasks. End one first.";
export const REPEAT_SAVE_FAILED = "Couldn't save the repeat. Try again.";
export const NEEDS_SCOPE = "This task repeats. Send repeatScope: this, following or all.";
export const REPEAT_SCOPES = ["this", "following", "all"] as const;
export type RepeatScope = (typeof REPEAT_SCOPES)[number];

export const REPEAT_EVERY = ["day", "weekday", "week", "month", "year"] as const;
export type RepeatEvery = (typeof REPEAT_EVERY)[number];

export type RepeatInput = {
  every: RepeatEvery;
  interval?: number;
  days?: string[];
  monthDay?: number;
  monthWeek?: { n: number; weekday: string };
  ends?: { after: number } | { on: string } | null;
};

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

type RollFrom = Pick<Task, "occursOn" | "dueAt" | "dueHasTime"> & Partial<Pick<Task, "completedAt" | "archivedAt">>;

function rollAtFor(row: SeriesRow, task: RollFrom | null, changes: OccurrenceChange[]) {
  if (stopped(row) || !task || task.completedAt || task.archivedAt || !task.occursOn) return null;
  const pattern = patternOf(row);
  const next = nextOccurrence(pattern, changes, task.occursOn);
  if (!next) return null;
  return rollThreshold(pattern, next, row.remind_minutes, taskDueEnd(task));
}

async function refreshRoll(db: Db, actor: Actor, seriesId: string) {
  const row = await readSeries(db, seriesId);
  if (!row) return;
  const task = await readTask(db, actor, row.current_task_id);
  const changes = await changesOf(db, row.id, task?.occursOn ?? null);
  await db.query("update crm.task_series set roll_at = $2, roll_pending = false where id = $1 and (roll_pending or roll_at is distinct from $2::timestamptz)", [row.id, rollAtFor(row, task, changes)]);
}

function readWeekday(value: unknown): Weekday | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().slice(0, 2);
  return (WEEKDAYS as readonly string[]).includes(key) ? (key as Weekday) : null;
}

function repeatError(message: string, field = "repeat"): never {
  throw new CrmError("invalid_input", message, 400, { field });
}

export function readRepeat(input: unknown, startsOn: string, now = Date.now()): { rule: RepeatRule; ends: RepeatEnds } {
  if (!input || typeof input !== "object") repeatError("Choose how it repeats.");
  const value = input as Partial<RepeatInput>;
  if (!REPEAT_EVERY.includes(value.every as RepeatEvery)) repeatError("Choose how it repeats: day, weekday, week, month or year.");
  const interval = value.interval === undefined || value.interval === null ? 1 : value.interval;
  let rule: RepeatRule;
  if (value.every === "day") rule = { freq: "daily", interval };
  else if (value.every === "weekday") rule = { freq: "weekly", interval, weekdays: [...WORKWEEK] };
  else if (value.every === "week") {
    const days = value.days === undefined || value.days === null ? [weekdayOf(startsOn)] : Array.isArray(value.days) ? value.days.map(readWeekday) : [null];
    if (days.some((day) => day === null)) repeatError("Pick days as mo, tu, we, th, fr, sa or su.");
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
  if (value.ends && typeof value.ends === "object") {
    if ("after" in value.ends) ends = { count: value.ends.after };
    else if ("on" in value.ends) ends = { until: value.ends.on };
  }
  const endsError = checkEnds(ends, startsOn, today(now));
  if (endsError) repeatError(endsError, "repeat.ends");
  return { rule: normalRule(rule), ends };
}

export function repeatInputOf(rule: RepeatRule, ends: RepeatEnds): RepeatInput {
  const input: RepeatInput =
    rule.freq === "daily"
      ? { every: "day" }
      : rule.freq === "weekly"
        ? rule.interval === 1 && rule.weekdays?.length === 5 && WORKWEEK.every((day) => rule.weekdays?.includes(day))
          ? { every: "weekday" }
          : { every: "week", days: rule.weekdays ?? [] }
        : rule.freq === "monthly"
          ? rule.monthWeek
            ? { every: "month", monthWeek: rule.monthWeek }
            : { every: "month", monthDay: rule.monthDay }
          : { every: "year" };
  if (rule.interval > 1) input.interval = rule.interval;
  if ("count" in ends) input.ends = { after: ends.count };
  if ("until" in ends) input.ends = { on: ends.until };
  return input;
}

async function assertRoom(db: Db, workspaceId: string, ownerId: string | null) {
  if (!ownerId) return;
  const counted = await db.query<{ total: number }>(
    `select count(*)::int as total from crm.task_series
     where workspace_id = $1 and owner_id = $2 and archived_at is null and ended_at is null`,
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
  const result = await db.query<{ id: string }>(
    `select id from crm.audit_events where entity_id = any($1::uuid[]) and created_at = now() order by created_at desc, id desc`,
    [entityIds],
  );
  return result.rows.map((row) => row.id);
}

export async function createRepeatingTaskInDb(db: Db, actor: Actor, input: TaskWrite, repeat: unknown, provenance: Provenance, now = Date.now()) {
  if (input.completed) throw new CrmError("invalid_input", "Create the task, then complete it.", 400, { field: "completed" });
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

async function insertOccurrence(db: Db, actor: Actor, row: SeriesRow, occurrence: Occurrence, previous: Task | null, provenance: Provenance | undefined) {
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
  if (ownerId !== row.owner_id) await db.query("update crm.task_series set owner_id = $2 where id = $1", [row.id, ownerId]);
  return { id, task };
}

async function consumeChanges(db: Db, seriesId: string, upTo: string) {
  await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on <= $2::date", [seriesId, upTo]);
}

export async function seriesAfterTaskChange(db: Db, actor: Actor, before: Task, task: Task, provenance: Provenance | undefined): Promise<Task | null> {
  if (!task.seriesId) return null;
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id) return null;
  if (!before.completedAt && task.completedAt) {
    if (stopped(row) || !task.occursOn) {
      await db.query("update crm.task_series set roll_at = null where id = $1", [row.id]);
      return null;
    }
    const changes = await changesOf(db, row.id, task.occursOn);
    const next = nextOccurrence(patternOf(row), changes, task.occursOn);
    if (!next) {
      await db.query("update crm.task_series set roll_at = null where id = $1", [row.id]);
      return readTaskInDb(db, actor, task.id);
    }
    await consumeChanges(db, row.id, next.occursOn);
    const rollAt = rollAtFor(row, next, changes.filter((change) => change.occursOn > next.occursOn));
    const created = await insertOccurrence(db, actor, row, next, task, provenance);
    await db.query("update crm.task_series set roll_at = $3, roll_pending = false where id = $1 and current_task_id = $2", [row.id, created.id, rollAt]);
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

export async function seriesBeforeReopen(db: Db, actor: Actor, task: Task, provenance: Provenance | undefined) {
  if (!task.seriesId) return;
  const row = await lockSeries(db, task.seriesId);
  if (!row) return;
  if (row.current_task_id === task.id) return;
  const current = await readTask(db, actor, row.current_task_id);
  const later = current && !current.completedAt && !current.archivedAt && (current.occursOn ?? "") > (task.occursOn ?? "");
  if (later && (await untouched(db, current.id))) {
    await archiveTaskInDb(db, actor, current.id, { operation: "undo_repeat", source: provenance?.source ?? null }, { keepSeries: true });
    if (current.clickupTaskId) {
      await db.query(`update crm.tasks set clickup_sync = clickup_sync || '{"deleteRemote": true}'::jsonb where id = $1`, [current.id]);
    }
    await db.query("update crm.task_series set current_task_id = $2 where id = $1", [row.id, task.id]);
    return;
  }
  if (!current || current.archivedAt) {
    await db.query("update crm.task_series set current_task_id = $2 where id = $1", [row.id, task.id]);
    return;
  }
  await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
}

export async function seriesAfterArchive(db: Db, actor: Actor, task: Task, provenance: Provenance) {
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || row.archived_at) return;
  await db.query("update crm.task_series set archived_at = now(), roll_at = null where id = $1", [row.id]);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.deleted", "task", task.id, provenance, auditSeries(row, after));
}

export async function seriesAfterUnarchive(db: Db, actor: Actor, task: Task) {
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || !row.archived_at) return;
  await db.query("update crm.task_series set archived_at = null where id = $1", [row.id]);
  await refreshRoll(db, actor, row.id);
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
  await db.query("update crm.tasks set occurs_on = $2 where id = $1", [task.id, target.occursOn]);
  const write = moveWrite(target, task);
  if (!task.dueHasTime && target.dueHasTime === false && task.remindMinutes !== null) write.remindMinutes = null;
  const updated = await updateTaskInDb(db, actor, task.id, write, provenance, {
    auditExtra: { repeat: { seriesId: row.id, kind, from: task.occursOn, to: target.occursOn, passed, consumed, ...extra } },
  });
  await consumeChanges(db, row.id, target.occursOn);
  await refreshRoll(db, actor, row.id);
  return updated.task;
}

export async function rollSeriesInDb(db: Db, actor: Actor, seriesId: string, now = Date.now()) {
  const peek = await readSeries(db, seriesId);
  if (!peek?.current_task_id) return null;
  const task = await lockOpenTask(db, actor, peek.current_task_id);
  const row = await lockSeries(db, seriesId);
  if (!row || !task || row.current_task_id !== task.id || stopped(row) || !task.occursOn) return null;
  if (row.roll_pending) {
    await refreshRoll(db, actor, row.id);
    const fresh = await readSeries(db, row.id);
    row.roll_at = fresh?.roll_at ?? null;
  }
  if (!row.roll_at || new Date(row.roll_at).getTime() > now) return null;
  const pattern = patternOf(row);
  const changes = await changesOf(db, row.id, task.occursOn);
  let target = nextOccurrence(pattern, changes, task.occursOn);
  if (!target) {
    await db.query("update crm.task_series set roll_at = null where id = $1", [row.id]);
    return null;
  }
  const passed = [task.occursOn];
  for (let guard = 0; guard < 400; guard += 1) {
    const after = nextOccurrence(pattern, changes, target.occursOn);
    if (!after || Date.parse(rollThreshold(pattern, after, row.remind_minutes, null)) > now) break;
    passed.push(target.occursOn);
    target = after;
  }
  return moveCurrent(db, actor, row, task, target, passed, "missed", { operation: "repeat_roll", source: "repeat", automatic: true });
}

async function lockOpenTask(db: Db, actor: Actor, id: string) {
  await db.query("select 1 from crm.tasks where id = $1 for no key update", [id]);
  const task = await readTaskInDb(db, actor, id);
  return task && !task.completedAt && !task.archivedAt ? task : null;
}

type DueRoll = { series_id: string; task_id: string; workspace_id: string; workspace_name: string; user_id: string; role: WorkspaceRole; email: string | null; full_name: string | null };

export async function rollDueSeries(options: { deadline: number; now?: number; limit?: number }) {
  const now = options.now ?? Date.now();
  const due = await query<DueRoll>("select * from private.series_due_to_roll($1, $2)", [new Date(now).toISOString(), options.limit ?? 50]);
  let rolled = 0;
  let failed = 0;
  for (const row of due.rows) {
    if (Date.now() > options.deadline) break;
    try {
      const actor = memberActor({ ...row, role: row.role });
      const moved = await withActor(actor, (db) => rollSeriesInDb(db, actor, row.series_id, now));
      if (moved) rolled += 1;
    } catch (error) {
      failed += 1;
      console.error("Repeating task roll failed", error instanceof Error ? error.name : "unknown");
    }
  }
  return { due: due.rows.length, rolled, failed };
}

async function resolveTarget(db: Db, actor: Actor, target: OccurrenceTarget) {
  if ("taskId" in target) {
    if (!isUuid(target.taskId)) throw notFound("task");
    await db.query("select 1 from crm.tasks where id = $1 for no key update", [target.taskId]);
    const task = await readTaskInDb(db, actor, target.taskId);
    if (!task || task.archivedAt || task.workspaceId !== actor.workspaceId) throw notFound("task");
    const row = task.seriesId ? await lockSeries(db, task.seriesId) : null;
    return { task, row, occursOn: task.occursOn, future: false };
  }
  if (!isUuid(target.seriesId) || !isDayKey(target.occursOn)) throw notFound("task");
  const peek = await readSeries(db, target.seriesId);
  if (!peek || peek.workspace_id !== actor.workspaceId || peek.archived_at) throw notFound("task");
  const current = peek.current_task_id ? await lockOpenTask(db, actor, peek.current_task_id) : null;
  const row = await lockSeries(db, target.seriesId);
  if (!row) throw notFound("task");
  if (current && current.occursOn === target.occursOn) return { task: current, row, occursOn: current.occursOn, future: false };
  if (!current || !current.occursOn || target.occursOn <= current.occursOn || stopped(row)) {
    throw new CrmError("invalid_input", "That date isn't an upcoming one. Change the open task instead.", 400, { field: "occursOn" });
  }
  if (occurrenceOnOrAfter(patternOf(row), target.occursOn) !== target.occursOn) {
    throw new CrmError("invalid_input", "That date isn't one of its dates.", 400, { field: "occursOn" });
  }
  return { task: current, row, occursOn: target.occursOn, future: true };
}

function assertSeriesChange(actor: Actor, row: SeriesRow, task: Task) {
  const allowed =
    actor.type === "user"
      ? row.owner_id === actor.userId || row.created_by_user_id === actor.userId || canChangeTask(actor, task)
      : canChangeTask(actor, task);
  if (!allowed) throw new CrmError("forbidden", "Only the assignee or the task's creator can change how it repeats.", 403);
}

export async function skipOccurrenceInDb(db: Db, actor: Actor, target: OccurrenceTarget, provenance: Provenance, extra: Record<string, unknown> = {}) {
  const found = await resolveTarget(db, actor, target);
  const { task, row } = found;
  if (!row) throw new CrmError("invalid_input", "This task doesn't repeat.", 400, { field: "skip" });
  assertSeriesChange(actor, row, task);
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

export async function skipOccurrence(actor: Actor, target: OccurrenceTarget, options: MutationOptions = {}) {
  assertScope(actor.scopes, "tasks:write");
  const provenance = options.provenance ?? { operation: "skip_occurrence" };
  const hash = requestHash("skip_occurrence", { target, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const result = await skipOccurrenceInDb(db, actor, target, { ...provenance, operation: "skip_occurrence" });
      return { ...result, undo: await eventIds(db, [result.task.id]) };
    }),
  );
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

const SERIES_FIELDS = ["title", "description", "priority", "ownerId", "companyId", "contactId", "opportunityId", "durationMinutes", "remindMinutes"] as const;

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
  const timeTouched = write.dueAt !== undefined || write.dueDate !== undefined;
  const saved = Object.keys(write).length > 0 ? (await updateTaskInDb(db, actor, task.id, write, provenance)).task : task;
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
  const base = occurrenceFor(pattern, occursOn, firstChange);
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
  const moving = changes.filter((change) => change.occursOn > occursOn);
  for (const change of moving) {
    const retimed = at !== row.at && change.dueAt;
    await db.query(
      `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, due_at, due_has_time, duration_minutes, title, description, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
      [newId, change.occursOn, change.skip ?? false, retimed ? null : change.dueAt, retimed ? null : change.dueAt ? change.dueHasTime : null, change.durationMinutes ?? null, change.title ?? null, change.description ?? null, actor.type === "user" ? actor.userId : null],
    );
  }
  await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on >= $2::date", [row.id, occursOn]);
  const until = shiftDay(occursOn, -1);
  await db.query(`update crm.task_series set ends = jsonb_build_object('until', $2::text) where id = $1`, [row.id, until]);
  const newRow = (await readSeries(db, newId))!;
  const timing = probe?.dueAt ? { dueAt: probe.dueAt, dueHasTime: probe.dueHasTime } : occurrenceTiming(at, occursOn);
  const first: Occurrence = { ...base, occursOn, day: taskDueDay(timing.dueAt) ?? occursOn, dueAt: timing.dueAt, dueHasTime: timing.dueHasTime, title: input.title?.trim() || null, description: input.description ?? null, durationMinutes: input.durationMinutes ?? null };
  const created = await insertOccurrence(db, actor, newRow, first, task, provenance);
  await db.query("update crm.task_series set current_task_id = $2 where id = $1", [newId, created.id]);
  await refreshRoll(db, actor, newId);
  await refreshRoll(db, actor, row.id);
  const after = await readSeries(db, row.id);
  const splitRow = await readSeries(db, newId);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { scope: "following", split: { seriesId: newId, taskId: created.id, from: occursOn }, movedChanges: moving }));
  await recordAudit(db, actor, "task_series.created", "task", created.id, provenance, { series: { id: newId, before: null, after: splitRow ? snapshotOf(splitRow) : null }, splitFrom: row.id });
  return created.task ?? task;
}

export async function updateOccurrenceInDb(db: Db, actor: Actor, target: OccurrenceTarget, input: TaskWrite, scope: RepeatScope | undefined, provenance: Provenance) {
  const found = await resolveTarget(db, actor, target);
  const { task, row } = found;
  if (!row || !found.occursOn) return (await updateTaskInDb(db, actor, task.id, input, provenance)).task;
  if (input.dueAt === null || input.dueDate === null || input.dueAt === "" || input.dueDate === "") {
    throw new CrmError("invalid_input", "A repeating task needs a day. Stop repeating first.", 400, { field: "dueAt" });
  }
  const touches = touchesSeries(task, input) || found.future;
  if (touches && !scope) throw new CrmError("invalid_input", NEEDS_SCOPE, 400, { field: "repeatScope" });
  if (!touches || scope === "this") {
    if (!found.future) return (await updateTaskInDb(db, actor, task.id, input, provenance)).task;
    assertSeriesChange(actor, row, task);
    await writeChangeRow(db, actor, row, task, found.occursOn, input, provenance);
    return (await readTaskInDb(db, actor, task.id))!;
  }
  assertSeriesChange(actor, row, task);
  if (stopped(row) && found.future) throw new CrmError("invalid_input", "It doesn't repeat any more.", 400, { field: "repeatScope" });
  if (scope === "following" && found.future) return editFollowing(db, actor, row, task, found.occursOn, input, provenance);
  return editAll(db, actor, row, task, input, found.future, provenance);
}

export async function setRepeatInDb(db: Db, actor: Actor, taskId: string, repeat: unknown, provenance: Provenance, now = Date.now()) {
  if (!isUuid(taskId)) throw notFound("task");
  const found = await resolveTarget(db, actor, { taskId });
  const { task, row } = found;
  if (!canChangeTask(actor, task) && !(row && actor.type === "user" && (row.owner_id === actor.userId || row.created_by_user_id === actor.userId))) {
    throw new CrmError("forbidden", "Only the assignee or the task's creator can change how it repeats.", 403);
  }
  if (repeat === null) {
    if (!row || stopped(row)) return task;
    await db.query("update crm.task_series set ended_at = now(), roll_at = null where id = $1", [row.id]);
    const dropped = await changesOf(db, row.id, task.occursOn);
    await db.query("delete from crm.task_occurrence_changes where series_id = $1", [row.id]);
    const after = await readSeries(db, row.id);
    await recordAudit(db, actor, "task_series.ended", "task", task.id, provenance, auditSeries(row, after, { droppedChanges: dropped }));
    return (await readTaskInDb(db, actor, task.id))!;
  }
  if (task.completedAt) throw new CrmError("invalid_input", "This task is done. Reopen it first.", 400, { field: "repeat" });
  const start = startOf(task, now);
  const day = task.occursOn && row && !stopped(row) ? (taskDueDay(task.dueAt) ?? task.occursOn) : start.day;
  const { rule, ends } = readRepeat(repeat, day, now);
  if (!row || stopped(row)) {
    await assertRoom(db, actor.workspaceId, task.ownerId);
    if (row) await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    let current = task;
    if (!task.dueAt) current = (await updateTaskInDb(db, actor, task.id, { dueDate: day }, provenance)).task;
    const inserted = await db.query<{ id: string }>(
      `insert into crm.task_series (
         workspace_id, owner_id, created_by_user_id, created_by_agent_id, title, description, priority, company_id, contact_id, opportunity_id,
         starts_on, at, duration_minutes, remind_minutes, rule, ends, current_task_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::time, $13, $14, $15::jsonb, $16::jsonb, $17)
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
        current.id,
      ],
    );
    await db.query("update crm.tasks set series_id = $2, occurs_on = $3 where id = $1", [current.id, inserted.rows[0].id, day]);
    await refreshRoll(db, actor, inserted.rows[0].id);
    const created = (await readSeries(db, inserted.rows[0].id))!;
    await recordAudit(db, actor, "task_series.created", "task", current.id, provenance, { series: { id: created.id, before: null, after: snapshotOf(created) } });
    return (await readTaskInDb(db, actor, current.id))!;
  }
  assertSeriesChange(actor, row, task);
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
  await db.query("delete from crm.task_occurrence_changes where series_id = $1", [row.id]);
  await db.query("update crm.task_series set rule = $2::jsonb, ends = $3::jsonb, starts_on = $4 where id = $1", [row.id, JSON.stringify(rule), JSON.stringify(ends), day]);
  await db.query("update crm.tasks set occurs_on = $2 where id = $1", [task.id, day]);
  await refreshRoll(db, actor, row.id);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, auditSeries(row, after, { scope: "all", droppedChanges: dropped, occursOnBefore: task.occursOn }));
  return (await readTaskInDb(db, actor, task.id))!;
}

export async function endSeriesOnInDb(db: Db, actor: Actor, taskId: string, until: string, provenance: Provenance) {
  if (!isDayKey(until)) throw new CrmError("invalid_input", "Choose an end date.", 400, { field: "until" });
  const found = await resolveTarget(db, actor, { taskId });
  if (!found.row) throw new CrmError("invalid_input", "This task doesn't repeat.", 400, { field: "until" });
  return setRepeatInDb(db, actor, taskId, { ...repeatInputOf(found.row.rule, found.row.ends), ends: { on: until } }, provenance);
}

export async function deleteSeriesInDb(db: Db, actor: Actor, taskId: string, provenance: Provenance) {
  const found = await resolveTarget(db, actor, { taskId });
  if (!found.row) throw new CrmError("invalid_input", "This task doesn't repeat.", 400);
  assertSeriesChange(actor, found.row, found.task);
  if (found.row.current_task_id === found.task.id && !found.task.completedAt) {
    await archiveTaskInDb(db, actor, found.task.id, provenance);
  } else {
    await db.query("update crm.task_series set archived_at = now(), roll_at = null where id = $1", [found.row.id]);
    const after = await readSeries(db, found.row.id);
    await recordAudit(db, actor, "task_series.deleted", "task", found.task.id, provenance, auditSeries(found.row, after));
  }
  return found.task;
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
    const ids = new Set([task.id, ...("taskId" in target ? [target.taskId] : [])]);
    return { task, undo: await eventIds(db, [...ids]) };
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
  const row = await lockSeries(db, series.id);
  if (!row) throw new CrmError("cannot_undo", "Can't undo: you can't change how this task repeats.", 409);
  const before = series.before;
  if (!before) {
    if (row.current_task_id) {
      const task = await readTaskInDb(db, actor, row.current_task_id);
      if (task && changes.withTask && !task.archivedAt) await archiveTaskInDb(db, actor, task.id, provenance);
      else if (task) await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    }
    await db.query("update crm.task_series set archived_at = coalesce(archived_at, now()), roll_at = null where id = $1", [row.id]);
    return;
  }
  const split = changes.split as { seriesId?: string; taskId?: string } | undefined;
  if (split?.taskId) {
    const created = await readTaskInDb(db, actor, split.taskId);
    if (created && !created.archivedAt) await archiveTaskInDb(db, actor, created.id, provenance, { keepSeries: true });
    if (split.seriesId) await db.query("update crm.task_series set archived_at = now(), roll_at = null where id = $1", [split.seriesId]);
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
      before.ownerId,
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
  if (!before.archivedAt && row.archived_at && row.current_task_id) {
    const current = await readTaskInDb(db, actor, row.current_task_id);
    if (current?.archivedAt) await unarchiveTaskInDb(db, actor, current.id, provenance);
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
  for (const change of (repeat.consumed as ChangeRow[] | undefined) ?? []) await putChange(db, actor, seriesId, change);
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
      if (target.occursOn) {
        const seriesId = target.seriesId ?? (target.taskId && isUuid(target.taskId) ? (await readTaskInDb(db, actor, target.taskId))?.seriesId : null);
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
      if (fields || !task) task = await updateOccurrenceInDb(db, actor, occurrence, write, scope ?? (input.repeat ? "all" : undefined), provenance);
      return { task };
    }),
  );
}
