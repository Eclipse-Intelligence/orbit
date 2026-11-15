import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError, notFound } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit, replayOrRun, requestHash, type MutationOptions, type MutationOutcome } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { isReminderMinutes } from "@/lib/crm/reminder-options";
import { queueTaskBlock } from "@/lib/crm/task-block-queue";
import { withoutViewerLinks } from "@/lib/crm/task-docs";
import { clockLabel, dayStartIso, isTaskDuration, taskDueDay } from "@/lib/crm/task-time";
import type { SeriesRights } from "@/lib/crm/task-rights";
import { currentLinksInDb } from "@/lib/crm/links";
import { addTaskParticipantsInDb, archiveTaskInDb, canChangeTask, checkTaskWrite, createTaskInDb, OWNER_SETS_LENGTH, readDue, readTaskInDb, unarchiveTaskInDb, updateTaskInDb, workspaceOwner } from "@/lib/crm/tasks";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import {
  MAX_EXPANSION,
  END_BEFORE_THIS,
  lostChangeDays,
  chainEnds,
  sameEnds,
  isLastWeekOfMonth,
  monthWeekOf,
  shortDay,
  anchoredRule,
  checkEnds,
  checkRule,
  reachesEnd,
  weekdayIndex,
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
import { REPEAT_SAVE_FAILED } from "@/lib/task-repeat-menu";
export { REPEAT_SAVE_FAILED };
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

export async function readSeriesSnapshot(db: Db, seriesId: string) {
  const row = isUuid(seriesId) ? await readSeries(db, seriesId) : null;
  return row ? snapshotOf(row) : null;
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
  const dueDay = taskDueDay(task.dueAt);
  const next = nextOccurrence(pattern, changes, dueDay && dueDay > task.occursOn ? dueDay : task.occursOn);
  if (!next) return null;
  return rollThreshold(pattern, next, row.remind_minutes, endOf(row, task));
}

function latestDue(row: SeriesRow, changes: OccurrenceChange[], first: Occurrence, now: number, notBefore: string | null = null): { target: Occurrence | null; passed: string[] } {
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
  if (notBefore !== null && target.day <= notBefore) {
    const jumped = occurrencePast(pattern, changes, notBefore);
    if (!jumped) return { target: null, passed };
    target = jumped;
  }
  return { target, passed };
}

function occurrencePast(pattern: RepeatPattern, changes: OccurrenceChange[], day: string) {
  const on = occurrenceOnOrAfter(pattern, shiftDay(day, 1));
  if (!on) return null;
  const change = changes.find((item) => item.occursOn === on);
  return change?.skip ? nextOccurrence(pattern, changes, on) : occurrenceFor(pattern, on, change);
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
  const open = Boolean(task && !task.completedAt && !task.archivedAt && !stopped(row));
  const rollAt = rollAtFor(row, task, changes) ?? (await rollIntoPartAt(db, actor, row, task)) ?? (open && (await othersPart(db, row.id)) ? iso(row.roll_at) : null);
  await db.query(
    "update crm.task_series set roll_at = $2, roll_pending = false, roll_retry_at = null where id = $1 and (roll_pending or roll_retry_at is not null or roll_at is distinct from $2::timestamptz)",
    [row.id, rollAt],
  );
}

async function waitingPart(db: Db, actor: Actor, seriesId: string, lock = false) {
  const found = await db.query<SeriesRow>(
    `${SERIES_SQL} where s.split_from_id = $1 and s.current_task_id is null and s.ended_at is null and s.archived_at is null order by s.starts_on limit 1${lock ? " for update" : ""}`,
    [seriesId],
  );
  const part = found.rows[0] ?? null;
  return part && ownsSeries(actor, part) ? part : null;
}

async function othersPart(db: Db, seriesId: string) {
  const found = await db.query<{ hidden: boolean }>(
    "select exists (select 1 from crm.series_later_parts($1) l where not exists (select 1 from crm.task_series s where s.id = l.id)) as hidden",
    [seriesId],
  );
  return Boolean(found.rows[0]?.hidden);
}

async function firstOfPart(db: Db, part: SeriesRow) {
  const changes = await changesOf(db, part.id);
  return { changes, first: nextOccurrence(patternOf(part), changes, shiftDay(part.starts_on, -1)) };
}

async function rollIntoPartAt(db: Db, actor: Actor, row: SeriesRow, task: RollFrom | null) {
  if (stopped(row) || !task || task.completedAt || task.archivedAt || !task.occursOn) return null;
  const part = await waitingPart(db, actor, row.id);
  if (!part) return null;
  const { first } = await firstOfPart(db, part);
  return first ? rollThreshold(patternOf(part), first, part.remind_minutes, endOf(row, task)) : null;
}

async function moveIntoPart(
  db: Db,
  actor: Actor,
  row: SeriesRow,
  task: Task & { occursOn: string },
  now: number,
  kind: "missed" | "skipped",
  provenance: Provenance,
  extra: Record<string, unknown> = {},
) {
  const part = await waitingPart(db, actor, row.id, true);
  if (!part) return null;
  const { changes, first } = await firstOfPart(db, part);
  if (!first) return null;
  const { target: due, passed } = latestDue(part, changes, first, now, taskDueDay(task.dueAt));
  const target = await freeFrom(db, part, due, task.id, changes);
  if (!target) return null;
  await db.query("update crm.tasks set series_id = $2, occurs_on = $3 where id = $1", [task.id, part.id, target.occursOn]);
  await db.query("update crm.task_series set current_task_id = $2 where id = $1", [part.id, task.id]);
  const moving: SeriesRow = { ...part, current_task_id: task.id };
  return moveCurrent(db, actor, moving, { ...task, seriesId: part.id }, target, [task.occursOn, ...passed], kind, provenance, { fromSeriesId: row.id, ...extra });
}

async function takenDays(db: Db, seriesId: string, exceptId: string | null) {
  const found = await db.query<{ day: string }>("select day::text as day from crm.series_taken_days($1, $2)", [seriesId, exceptId]);
  return new Set(found.rows.map((row) => row.day));
}

async function freeFrom(db: Db, row: SeriesRow, occurrence: Occurrence | null, exceptId: string | null, changes: OccurrenceChange[]) {
  if (!occurrence) return null;
  const taken = await takenDays(db, row.id, exceptId);
  let next: Occurrence | null = occurrence;
  for (let guard = 0; next && taken.has(next.occursOn) && guard <= MAX_EXPANSION; guard += 1) next = nextOccurrence(patternOf(row), changes, next.occursOn);
  return next && !taken.has(next.occursOn) ? next : null;
}

export type StateScope = "all" | "open" | { day: string };

export async function seriesState(db: Db, seriesId: string, scope: StateScope = "all", openOn?: string | null) {
  const row = await readSeries(db, seriesId);
  if (!row) return null;
  const shape: Record<string, unknown> = { startsOn: row.starts_on, rule: row.rule, ends: row.ends, ended: Boolean(row.ended_at), archived: Boolean(row.archived_at) };
  if (scope !== "all" && scope !== "open") shape.change = (await changesOf(db, seriesId)).find((change) => change.occursOn === scope.day) ?? null;
  else {
    shape.current = row.current_task_id;
    shape.open = openOn !== undefined ? openOn : row.current_task_id ? ((await db.query<{ day: string | null }>("select occurs_on::text as day from crm.tasks where id = $1", [row.current_task_id])).rows[0]?.day ?? null) : null;
    if (scope === "all") shape.changes = await changesOf(db, seriesId);
  }
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 32);
}

const WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function readWeekday(value: unknown): Weekday | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text.length < 2) return null;
  const found = WEEKDAY_NAMES.flatMap((name, index) => (name.startsWith(text) ? [index] : []));
  return found.length === 1 ? WEEKDAYS[found[0]] : null;
}

function repeatError(message: string, field = "repeat"): never {
  throw new CrmError("invalid_input", message, 400, { field });
}

const REPEAT_INPUT_KEYS = new Set(["every", "interval", "days", "monthDay", "monthWeek", "ends"]);
const ENDS_INPUT_KEYS = new Set(["after", "on"]);

export function readRepeat(input: unknown, startsOn: string, now = Date.now()): { rule: RepeatRule; ends: RepeatEnds } {
  if (!input || typeof input !== "object" || Array.isArray(input)) repeatError("Choose how it repeats.");
  const unknown = Object.keys(input).find((key) => !REPEAT_INPUT_KEYS.has(key));
  if (unknown) repeatError(`repeat doesn't take ${unknown}. Send every, interval, days, monthDay, monthWeek and ends, such as ends: { after: 5 }.`);
  const value = Object.fromEntries(Object.entries(input).filter(([, field]) => field !== null)) as Partial<RepeatInput>;
  if ((input as { ends?: unknown }).ends === null) value.ends = null;
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
    if (value.monthWeek !== undefined) {
      const week = value.monthWeek as unknown;
      if (!week || typeof week !== "object" || Array.isArray(week) || Object.keys(week).some((key) => key !== "n" && key !== "weekday")) repeatError("Choose which week of the month as { n, weekday }.");
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
    const unknownEnd = Object.keys(value.ends).find((key) => !ENDS_INPUT_KEYS.has(key));
    if (unknownEnd) repeatError(`ends doesn't take ${unknownEnd}. Send { after: N } or { on: YYYY-MM-DD }.`, "repeat.ends");
    if ("after" in value.ends && "on" in value.ends) repeatError("Choose after or on, not both.", "repeat.ends");
    if ("after" in value.ends) ends = { count: value.ends.after };
    else if ("on" in value.ends) ends = { until: value.ends.on };
    else repeatError("Choose when it ends: { after: N } or { on: YYYY-MM-DD }.", "repeat.ends");
  }
  const endsError = checkEnds(ends, startsOn, today(now));
  if (endsError) repeatError(endsError, "repeat.ends");
  return { rule: normalRule(rule), ends };
}

export const THEIR_SERIES_FULL = "They can't take more repeating tasks. Ask them to end one first.";

async function assertRoom(db: Db, actor: Actor, ownerId: string | null, field = "repeat") {
  const keeperId = ownerId ?? (await workspaceOwner(db, actor.workspaceId));
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`task-series-room:${actor.workspaceId}:${keeperId ?? "owner"}`]);
  const counted = await db.query<{ at_limit: boolean; keeper: string | null }>("select at_limit, keeper from crm.series_at_limit($1, $2)", [actor.workspaceId, keeperId]);
  const { at_limit: full, keeper } = counted.rows[0] ?? { at_limit: false, keeper: null };
  if (!full) return;
  const mine = actor.type === "user" ? keeper === actor.userId : false;
  throw new CrmError("invalid_input", mine || actor.type === "agent" ? TOO_MANY_SERIES : THEIR_SERIES_FULL, 400, { field });
}

function startOf(task: Pick<Task, "dueAt" | "dueHasTime">, now = Date.now()) {
  const day = taskDueDay(task.dueAt) ?? today(now);
  return { day, at: task.dueHasTime && task.dueAt ? clockLabel(task.dueAt) : null };
}

function patternAnchor(rule: RepeatRule, start: string) {
  return rule.freq === "weekly" || rule.freq === "monthly" ? (firstPatternDay({ ...rule, interval: 1 }, start) ?? start) : start;
}

export function firstDay(rule: RepeatRule, at: string | null, start: string, now: number) {
  const anchor = patternAnchor(rule, start);
  const from = anchor < today(now) ? today(now) : anchor;
  let day = firstPatternDay(rule, anchor, from);
  if (day && at && Date.parse(occurrenceTiming(at, day).dueAt) <= now) day = firstPatternDay(rule, anchor, shiftDay(day, 1));
  return day;
}

const MIN_REMINDER_ROOM = 60;

function shortestGapDays(rule: RepeatRule) {
  const interval = Math.max(1, rule.interval);
  if (rule.freq === "daily") return interval;
  if (rule.freq !== "weekly") return 28;
  const days = WEEKDAYS.flatMap((day, index) => (rule.weekdays?.includes(day) ? [index] : []));
  if (days.length === 0) return 7 * interval;
  const gaps = days.slice(1).map((day, index) => day - days[index]);
  gaps.push(7 * interval - days[days.length - 1] + days[0]);
  return Math.min(...gaps);
}

export const REMINDER_TOO_LONG = "Choose a reminder shorter than the time between its dates.";

function checkReminderRoom(rule: RepeatRule, at: string | null, remindMinutes: number | null | undefined, durationMinutes: number | null | undefined) {
  if (!at || typeof remindMinutes !== "number") return;
  if (remindMinutes + (durationMinutes ?? 15) + MIN_REMINDER_ROOM > shortestGapDays(rule) * 1440) {
    throw new CrmError("invalid_input", REMINDER_TOO_LONG, 400, { field: "remindMinutes" });
  }
}

export const END_TOO_FAR = "That end is too far ahead. Choose fewer times.";
export const TOO_FEW_TIMES = "Choose more times than have already passed.";

function checkReachesEnd(pattern: RepeatPattern) {
  if (!reachesEnd(pattern)) throw new CrmError("invalid_input", END_TOO_FAR, 400, { field: "repeat.ends" });
}

const TASK_PRIORITIES = ["low", "normal", "high"];

async function checkNewSeries(db: Db, actor: Actor, input: TaskWrite, ownerId: string | null) {
  if (input.priority !== undefined && !TASK_PRIORITIES.includes(input.priority)) throw new CrmError("invalid_input", "Unknown priority.", 400, { field: "priority" });
  if (ownerId && !(await memberOrNull(db, actor.workspaceId, ownerId))) throw new CrmError("invalid_input", "Choose an assignee in this workspace.", 400, { field: "ownerId" });
}

async function seriesAudit(db: Db, row: SeriesRow, after: SeriesRow | null, extra: Record<string, unknown> = {}) {
  const day = typeof extra.changed === "string" ? extra.changed : typeof extra.skipped === "string" ? extra.skipped : null;
  const stateScope: StateScope = day ? { day } : "all";
  return { series: { id: row.id, before: snapshotOf(row), after: after ? snapshotOf(after) : null, state: await seriesState(db, row.id, stateScope), stateScope }, ...extra };
}

async function eventIds(db: Db, entityIds: string[]) {
  const result = await db.query<{ id: string }>(
    `select e.id from crm.audit_events e
     where e.entity_id = any($1::uuid[]) and e.created_at = now()
       and e.event_type not like '%.undone' and e.event_type not like 'task.participant_%'
       and not coalesce((e.changes ->> 'followsChange')::boolean, false)
       and (e.changes ->> 'undoing') is distinct from 'true'
       and not (e.event_type = 'task.archived' and exists (select 1 from crm.audit_events d where d.entity_id = e.entity_id and d.created_at = e.created_at and d.event_type = 'task_series.deleted'))
       and not (e.event_type = 'task.created' and e.changes -> 'after' ->> 'seriesId' is not null)
     order by e.created_at desc, e.id desc`,
    [entityIds],
  );
  return result.rows.map((row) => row.id);
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
  checkTaskWrite(input);
  const ownerId = input.ownerId === undefined ? (actor.type === "user" ? actor.userId : null) : input.ownerId || null;
  await checkNewSeries(db, actor, input, ownerId);
  const keeper = ownerId ?? (actor.type === "agent" ? await workspaceOwner(db, actor.workspaceId) : null);
  await assertRoom(db, actor, keeper);
  const probe = createTaskProbe(input);
  const asked = startOf(probe, now);
  const forColleague = colleagueTime(actor, ownerId, { created_by_agent_id: actor.type === "agent" ? actor.agentId : null });
  const start = forColleague ? { ...asked, at: null } : asked;
  const read = readRepeat(repeat, start.day, now);
  const ends = read.ends;
  const first = firstDay(read.rule, start.at, start.day, now);
  if (!first || ("until" in ends && ends.until < first)) throw new CrmError("invalid_input", END_BEFORE_THIS, 400, { field: "repeat.ends" });
  const rule = anchoredRule(read.rule, { rule: read.rule, startsOn: start.day }, first);
  checkReachesEnd({ startsOn: first, at: start.at, rule, ends });
  const remindMinutes = forColleague ? undefined : input.remindMinutes;
  checkReminderRoom(rule, start.at, remindMinutes, input.durationMinutes);
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
  if (forColleague) delete write.remindMinutes;
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

function createTaskProbe(input: TaskWrite): Pick<Task, "dueAt" | "dueHasTime"> {
  const due = readDue(input);
  return due ? { dueAt: due.dueAt, dueHasTime: due.dueHasTime } : { dueAt: null, dueHasTime: false };
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
  const stored = found.rows[0];
  const followed = await currentLinksInDb(db, row.workspace_id, { companyId: stored.company_id, contactId: stored.contact_id, opportunityId: stored.opportunity_id });
  return { company_id: followed.companyId, contact_id: followed.contactId, opportunity_id: followed.opportunityId };
}

async function keeperOf(db: Db, row: Pick<SeriesRow, "workspace_id" | "owner_id" | "split_from_id" | "current_task_id">, previousOwner: string | null) {
  if (!row.owner_id && !(row.split_from_id && !row.current_task_id)) return null;
  return (await memberOrNull(db, row.workspace_id, row.owner_id)) ?? (await memberOrNull(db, row.workspace_id, previousOwner));
}

type Previous = Pick<Task, "id" | "ownerId" | "clickupListId"> & { mailThreadKey?: string | null };

async function insertOccurrence(
  db: Db,
  actor: Actor,
  row: SeriesRow,
  occurrence: Occurrence,
  previous: Previous | null,
  provenance: Provenance | undefined,
  passed: string[] = [],
  consumed: ChangeRow[] = [],
) {
  const ownerId = await keeperOf(db, row, previous?.ownerId ?? null);
  const links = await linksInWorkspace(db, row);
  const thread = previous?.mailThreadKey && ownerId && ownerId === previous.ownerId ? previous.mailThreadKey : null;
  const timed = occurrence.dueHasTime;
  const id = randomUUID();
  await db.query(
    `insert into crm.tasks (
       workspace_id, title, description, due_at, priority, owner_id, company_id, contact_id, opportunity_id,
       created_by_user_id, created_by_agent_id, remind_minutes, due_has_time, scheduled_by, duration_minutes,
       clickup_list_id, series_id, occurs_on, id, mail_thread_key
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
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
      thread,
    ],
  );
  queueTaskBlock(db, id);
  const task = await readTaskInDb(db, actor, id);
  await recordAudit(db, actor, "task.created", "task", id, { operation: "repeat_task", source: provenance?.source ?? null }, {
    after: task ? withoutViewerLinks(task) : { title: occurrence.title ?? row.title, dueAt: occurrence.dueAt, dueHasTime: timed, ownerId, seriesId: row.id, occursOn: occurrence.occursOn },
    repeat: { seriesId: row.id, occursOn: occurrence.occursOn, after: previous?.id ?? null, ...(passed.length ? { kind: "missed", passed } : {}), ...(consumed.length ? { consumed } : {}) },
  });
  if (ownerId !== row.owner_id && ownsSeries(actor, row)) await db.query("update crm.task_series set owner_id = $2 where id = $1", [row.id, ownerId]);
  return { id, task };
}

async function finishSeries(db: Db, actor: Actor, row: SeriesRow, previous: Task | null, provenance: Provenance | undefined) {
  if (!ownsSeries(actor, row)) {
    if (!stopped(row)) await db.query("update crm.task_series set roll_pending = true where id = $1 and not roll_pending", [row.id]);
    return;
  }
  await db.query("update crm.task_series set ended_at = coalesce(ended_at, now()), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
  const child = await db.query<SeriesRow>(
    `${SERIES_SQL} where s.split_from_id = $1 and s.current_task_id is null and s.archived_at is null and s.ended_at is null for update`,
    [row.id],
  );
  for (const split of child.rows) if (ownsSeries(actor, split)) await startSplit(db, actor, split, previous, provenance, taskDueDay(previous?.dueAt));
}

async function startSplit(db: Db, actor: Actor, split: SeriesRow, previous: Previous | null, provenance: Provenance | undefined, notBefore: string | null = null) {
  const changes = await changesOf(db, split.id);
  const opening = nextOccurrence(patternOf(split), changes, shiftDay(split.starts_on, -1));
  const { target: due, passed } = opening ? latestDue(split, changes, opening, Date.now(), notBefore) : { target: null, passed: [] };
  const first = await freeFrom(db, split, due, null, changes);
  if (!first) {
    await db.query("update crm.task_series set ended_at = coalesce(ended_at, now()), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [split.id]);
    await consumeChanges(db, split.id, "9999-12-31");
    return null;
  }
  const consumed = changes.filter((change) => change.occursOn <= first.occursOn);
  await consumeChanges(db, split.id, first.occursOn);
  const created = await insertOccurrence(db, actor, split, first, previous ?? (await splitPrevious(db, split.id)), provenance, passed, consumed);
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
  const { target: due, passed } = latestDue(row, changes, first, now, taskDueDay(done.dueAt));
  const next = await freeFrom(db, row, due, done.id, changes);
  if (!next) {
    await finishSeries(db, actor, row, done, provenance);
    return null;
  }
  const consumed = changes.filter((change) => change.occursOn <= next.occursOn);
  await consumeChanges(db, row.id, next.occursOn);
  const rollAt = rollAtFor(row, next, changes.filter((change) => change.occursOn > next.occursOn)) ?? (await rollIntoPartAt(db, actor, row, next));
  const owner = await keeperOf(db, row, done.ownerId);
  const owns = ownsSeries(actor, row);
  if (owns) await db.query("update crm.task_series set roll_at = $2, roll_pending = false, roll_retry_at = null, owner_id = $3 where id = $1", [row.id, rollAt, owner]);
  else await db.query("update crm.task_series set roll_pending = true where id = $1 and not roll_pending", [row.id]);
  const created = await insertOccurrence(db, actor, { ...row, owner_id: owner }, next, done, provenance, passed, consumed);
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
  const retimed =
    before.dueAt !== task.dueAt || before.dueHasTime !== task.dueHasTime || before.durationMinutes !== task.durationMinutes || Boolean(before.completedAt) !== Boolean(task.completedAt);
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

async function keepOwnChange(db: Db, row: SeriesRow, task: Task, actor: Actor) {
  if (!task.occursOn) return;
  const base = occurrenceFor(patternOf(row), task.occursOn, undefined);
  const moved = task.dueAt !== base.dueAt || task.dueHasTime !== base.dueHasTime;
  const longer = task.durationMinutes !== row.duration_minutes;
  const retitled = task.title !== row.title;
  const described = (task.description ?? null) !== (row.description ?? null);
  if (!moved && !longer && !retitled && !described) return;
  await db.query(
    `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, due_at, due_has_time, duration_minutes, title, description, created_by)
     values ($1, $2, false, $3, $4, $5, $6, $7, $8) on conflict (series_id, occurs_on) do nothing`,
    [
      row.id,
      task.occursOn,
      moved ? task.dueAt : null,
      moved ? task.dueHasTime : null,
      longer ? task.durationMinutes : null,
      retitled ? task.title : null,
      described ? task.description : null,
      actor.type === "user" ? actor.userId : null,
    ],
  );
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
  if (row.current_task_id === task.id) {
    if (row.ended_at && !row.archived_at && task.occursOn && ownsSeries(actor, row) && !nextOccurrence(patternOf(row), await changesOf(db, row.id, task.occursOn), task.occursOn)) {
      if (!(await hasRoom(db, actor, row.owner_id))) return;
      if (await unstartParts(db, actor, row, provenance)) await db.query("update crm.task_series set ended_at = null where id = $1", [row.id]);
      else await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    }
    return;
  }
  const current = await readTask(db, actor, row.current_task_id);
  const near = await neighboursOf(db, task.id);
  const later = current && !current.completedAt && !current.archivedAt && (current.occursOn ?? "") > (task.occursOn ?? "");
  const predecessor = current ? near.beforeOpen === task.id : false;
  if (later && predecessor && (await untouched(db, current.id))) {
    if (ownsSeries(actor, row)) await restoreConsumed(db, actor, row.id, current.id);
    await keepOwnChange(db, row, current, actor);
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

async function hasRoom(db: Db, actor: Actor, ownerId: string | null) {
  try {
    await assertRoom(db, actor, ownerId);
    return true;
  } catch (error) {
    if (error instanceof CrmError) return false;
    throw error;
  }
}

async function restoreConsumed(db: Db, actor: Actor, seriesId: string, taskId: string) {
  const found = await db.query<{ consumed: ChangeRow[] | null }>(
    "select changes -> 'repeat' -> 'consumed' as consumed from crm.audit_events where entity_type = 'task' and entity_id = $1 and event_type = 'task.created' order by created_at desc limit 1",
    [taskId],
  );
  for (const change of found.rows[0]?.consumed ?? []) if (isDayKey(change.occursOn)) await putChange(db, actor, seriesId, change);
}

async function unstartParts(db: Db, actor: Actor, row: SeriesRow, provenance: Provenance | undefined) {
  const started = await db.query<SeriesRow>(`${SERIES_SQL} where s.split_from_id = $1 and s.current_task_id is not null and s.archived_at is null for update`, [row.id]);
  const firsts: Task[] = [];
  for (const part of started.rows) {
    const first = await readTaskInDb(db, actor, part.current_task_id!);
    if (!first || !ownsSeries(actor, part) || first.seriesId !== part.id || first.completedAt || first.archivedAt || !(await untouched(db, first.id))) return false;
    firsts.push(first);
  }
  for (const [index, part] of started.rows.entries()) {
    const first = firsts[index];
    await restoreConsumed(db, actor, part.id, first.id);
    await archiveTaskInDb(db, actor, first.id, { operation: "undo_repeat", source: provenance?.source ?? null }, { keepSeries: true, series: seriesRights(part) });
    if (first.clickupTaskId || first.clickupListId) await db.query(`update crm.tasks set clickup_sync = clickup_sync || '{"deleteRemote": true}'::jsonb where id = $1`, [first.id]);
    await db.query("update crm.task_series set current_task_id = null, roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [part.id]);
    await db.query("update crm.task_series set ended_at = null where id = $1", [part.id]);
  }
  return true;
}

export async function seriesAfterArchive(db: Db, actor: Actor, task: Task) {
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || stopped(row)) return;
  if (!ownsSeries(actor, row)) {
    await db.query("select crm.series_end_with_archived($1)", [task.id]);
    return;
  }
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

export async function seriesAfterUnarchive(db: Db, actor: Actor, task: Task, archivedAt: string | null = null) {
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id) return;
  if (!row.archived_at) {
    const endedWithIt = Boolean(row.ended_at && archivedAt && iso(row.ended_at) === archivedAt);
    if (!endedWithIt || !ownsSeries(actor, row) || task.completedAt) return;
    const started = await db.query("select 1 from crm.task_series where split_from_id = $1 and current_task_id is not null and archived_at is null", [row.id]);
    if ((started.rowCount ?? 0) > 0 || !(await hasRoom(db, actor, row.owner_id))) return;
    await db.query("update crm.task_series set ended_at = null where id = $1", [row.id]);
    await refreshRoll(db, actor, row.id);
    return;
  }
  if (!ownsSeries(actor, row)) {
    await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
    return;
  }
  if (!row.ended_at) await assertRoom(db, actor, row.owner_id);
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

type OccurrenceWriteOptions = { auditExtra?: Record<string, unknown>; occursOn?: string; archive?: boolean; detach?: boolean; restoring?: boolean; seriesMove?: boolean };

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
  return (await updateTaskInDb(db, actor, task.id, write, provenance, { restoring: options.restoring, auditExtra: options.auditExtra, series: seriesRights(row), seriesMove: options.seriesMove })).task;
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
  await consumeChanges(db, row.id, target.occursOn);
  const state = await seriesState(db, row.id, "open", target.occursOn);
  const moved = await writeOccurrence(db, actor, row, task, write, provenance, {
    occursOn: target.occursOn,
    restoring: true,
    seriesMove: true,
    auditExtra: { repeat: { seriesId: row.id, kind, from: task.occursOn, to: target.occursOn, passed, consumed, state, stateScope: "open", ...extra } },
  });
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
  const pattern = patternOf(row);
  const changes = await changesOf(db, row.id, from);
  if (row.roll_pending) {
    if (ownsSeries(actor, row)) {
      await refreshRoll(db, actor, row.id);
      const fresh = await readSeries(db, row.id);
      row.roll_at = fresh?.roll_at ?? null;
    } else row.roll_at = rollAtFor(row, task, changes);
  }
  if (!row.roll_at || new Date(row.roll_at).getTime() > now) return null;
  const first = nextOccurrence(pattern, changes, from);
  if (!first) {
    if (ownsSeries(actor, row)) {
      const handed = await moveIntoPart(db, actor, row, task, now, "missed", { operation: "repeat_roll", automatic: true });
      if (handed) return handed;
      if (!(await othersPart(db, row.id))) await db.query("update crm.task_series set roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
    }
    return null;
  }
  const { target: due, passed } = latestDue(row, changes, first, now, taskDueDay(task.dueAt));
  const target = await freeFrom(db, row, due, task.id, changes);
  if (!target) {
    if (ownsSeries(actor, row)) await db.query("update crm.task_series set roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
    return null;
  }
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
  const due = await query<DueRoll>("select * from private.series_due_to_roll($1, $2)", [new Date(now).toISOString(), options.limit ?? 200]);
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

export async function unstartedAnchor(db: Db, part: Pick<SeriesRow, "id" | "split_from_id" | "current_task_id">) {
  const chain: string[] = [];
  let level: Pick<SeriesRow, "id" | "split_from_id" | "current_task_id"> | null = part;
  for (let depth = 0; level && !level.current_task_id && level.split_from_id && depth < 20; depth += 1) {
    chain.push(level.id);
    const parent: SeriesRow | null = await readSeries(db, level.split_from_id);
    if (parent?.current_task_id && !parent.archived_at) return parent.current_task_id;
    level = parent;
  }
  for (const id of chain) {
    const previous = await splitPrevious(db, id);
    if (previous) return previous.id;
  }
  return null;
}

async function lockAnchor(db: Db, actor: Actor, id: string) {
  await lockOccurrence(db, id);
  const task = await readTaskInDb(db, actor, id);
  return task && !task.archivedAt ? task : null;
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
  const anchorId = !peek.current_task_id && peek.split_from_id && !stopped(peek) ? await unstartedAnchor(db, peek) : null;
  const anchor = anchorId ? await lockAnchor(db, actor, anchorId) : null;
  let current = peek.current_task_id ? await lockOpenTask(db, actor, peek.current_task_id) : null;
  const row = await lockSeries(db, target.seriesId);
  if (!row) throw notFound("task");
  if (row.current_task_id !== (current?.id ?? peek.current_task_id)) current = row.current_task_id ? await lockOpenTask(db, actor, row.current_task_id) : null;
  if (current && current.occursOn === target.occursOn) return { task: current, row, occursOn: current.occursOn, future: false };
  if (!current && !row.current_task_id && anchor && !stopped(row) && target.occursOn >= row.starts_on) {
    if (occurrenceOnOrAfter(patternOf(row), target.occursOn) === target.occursOn) return { task: anchor, row, occursOn: target.occursOn, future: true };
  }
  if (!current || !current.occursOn || target.occursOn <= current.occursOn || stopped(row)) {
    throw new CrmError("invalid_input", "That date isn't an upcoming one. Change the open task instead.", 400, { field: "occursOn" });
  }
  if (occurrenceOnOrAfter(patternOf(row), target.occursOn) !== target.occursOn) {
    throw new CrmError("invalid_input", "That date isn't one of its dates.", 400, { field: "occursOn" });
  }
  return { task: current, row, occursOn: target.occursOn, future: true };
}

export const KEEPS_DAY = "These dates haven't started yet, so the first one keeps its day. Change its time on that day, or move just this one.";
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
  if (!found.future && task.completedAt) throw new CrmError("invalid_input", "This one is done. Reopen it to skip it.", 400, { field: "skip" });
  if (found.future) {
    await assertChangeRoom(db, row, task, found.occursOn!);
    const before = (await changesOf(db, row.id)).find((change) => change.occursOn === found.occursOn) ?? null;
    await db.query(
      `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, created_by)
       values ($1, $2, true, $3)
       on conflict (series_id, occurs_on) do update set skip = true`,
      [row.id, found.occursOn, actor.type === "user" ? actor.userId : null],
    );
    await refreshAround(db, actor, row, task);
    const after = await readSeries(db, row.id);
    await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, await seriesAudit(db, row, after, { skipped: found.occursOn, changeBefore: before }));
    return { task: (await readTaskInDb(db, actor, task.id))!, skipped: found.occursOn! };
  }
  if (stopped(row)) throw new CrmError("invalid_input", "It doesn't repeat any more. Mark it done or delete it.", 400, { field: "skip" });
  const moved = await skipCurrent(db, actor, row, { ...task, occursOn: task.occursOn! }, provenance, extra);
  if (!moved) throw new CrmError("invalid_input", "This is the last one. Mark it done or delete it.", 400, { field: "skip" });
  return { task: moved, skipped: task.occursOn! };
}

async function skipTarget(db: Db, row: SeriesRow, task: Task & { occursOn: string }) {
  const changes = await changesOf(db, row.id, task.occursOn);
  const first = nextOccurrence(patternOf(row), changes, task.occursOn);
  const { target, passed } = first ? latestDue(row, changes, first, 0, taskDueDay(task.dueAt)) : { target: null, passed: [] };
  return { next: await freeFrom(db, row, target, task.id, changes), passed };
}

async function skipCurrent(db: Db, actor: Actor, row: SeriesRow, task: Task & { occursOn: string }, provenance: Provenance, extra: Record<string, unknown>) {
  const { next, passed } = await skipTarget(db, row, task);
  if (next) return moveCurrent(db, actor, row, task, next, [task.occursOn, ...passed], "skipped", provenance, extra);
  return ownsSeries(actor, row) ? moveIntoPart(db, actor, row, task, 0, "skipped", provenance, extra) : null;
}

async function refreshAround(db: Db, actor: Actor, row: SeriesRow, task: Task) {
  await refreshRoll(db, actor, row.id);
  if (task.seriesId && task.seriesId !== row.id) await refreshRoll(db, actor, task.seriesId);
  queueTaskBlock(db, task.id);
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
  const occurring = { ...task, occursOn: task.occursOn };
  return skipCurrent(db, actor, row, occurring, { ...provenance, operation: provenance.operation === "archive_task" ? "skip_occurrence" : provenance.operation }, { archived: true });
}

export async function skipDeletedOccurrenceInDb(db: Db, actor: Actor, taskId: string, provenance: Provenance) {
  const task = await readTaskInDb(db, actor, taskId);
  if (!task?.seriesId || !task.occursOn || task.completedAt || task.archivedAt) return false;
  const row = await readSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || stopped(row)) return false;
  if (!ownsSeries(actor, row) && !canChangeTask(actor, task)) return false;
  const { next } = await skipTarget(db, row, { ...task, occursOn: task.occursOn });
  if (!next && !(ownsSeries(actor, row) && (await waitingPart(db, actor, row.id)))) return false;
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
  if (input.dueAt === undefined && input.dueDate === undefined) return false;
  const due = readDue(input);
  if (!due?.dueAt) return true;
  const sameDay = taskDueDay(due.dueAt) === taskDueDay(task.dueAt);
  if (!due.dueHasTime) return task.dueHasTime && sameDay;
  return sameDay && (!task.dueHasTime || clockLabel(due.dueAt) !== (task.dueAt ? clockLabel(task.dueAt) : null));
}

function colleagueTime(actor: Actor, ownerId: string | null, row: Pick<SeriesRow, "created_by_agent_id">) {
  if (actor.type === "agent" && row.created_by_agent_id === actor.agentId) return false;
  return Boolean(ownerId) && !(actor.type === "user" && actor.userId === ownerId);
}

function handedAway(actor: Actor, row: SeriesRow, ownerId: string | null) {
  return (ownerId ?? null) !== (row.owner_id ?? null) && colleagueTime(actor, ownerId, row);
}

export const MAX_CHANGED_DATES = 200;
export const TOO_MANY_CHANGES = "This repeating task has 200 changed dates. Change how it repeats instead.";

async function assertChangeRoom(db: Db, row: SeriesRow, task: Task, occursOn: string) {
  const open = task.seriesId === row.id ? task.occursOn : null;
  const found = await db.query<{ total: number; mine: boolean | null }>(
    "select count(*)::int as total, bool_or(occurs_on = $2::date) as mine from crm.task_occurrence_changes where series_id = $1 and ($3::date is null or occurs_on > $3::date)",
    [row.id, occursOn, open],
  );
  const { total, mine } = found.rows[0] ?? { total: 0, mine: false };
  if (!mine && total >= MAX_CHANGED_DATES) throw new CrmError("invalid_input", TOO_MANY_CHANGES, 400, { field: "occursOn" });
}

async function neighbourDays(db: Db, actor: Actor, row: SeriesRow, task: Task, occursOn: string) {
  const pattern = patternOf(row);
  const own = task.seriesId === row.id;
  const dueDay = taskDueDay(task.dueAt);
  const eve = shiftDay(row.starts_on, -1);
  const from = own ? task.occursOn : eve;
  const changes = await changesOf(db, row.id, from);
  let before = own ? (dueDay ?? task.occursOn ?? occursOn) : dueDay && dueDay > eve ? dueDay : eve;
  let lastKey = own && task.occursOn ? task.occursOn : eve;
  let walk = from ? nextOccurrence(pattern, changes, from) : null;
  for (let guard = 0; walk && walk.occursOn < occursOn && guard <= MAX_EXPANSION; guard += 1) {
    if (walk.day > before) before = walk.day;
    lastKey = walk.occursOn;
    walk = nextOccurrence(pattern, changes, walk.occursOn);
  }
  const after = nextOccurrence(pattern, changes, occursOn)?.day ?? null;
  if (after !== null) return { before, after, lastKey };
  const part = await waitingPart(db, actor, row.id);
  return { before, after: part ? ((await firstOfPart(db, part)).first?.day ?? null) : null, lastKey };
}

const CHANGE_ROW_FIELDS = new Set(["title", "description", "dueAt", "dueDate", "dueHasTime", "durationMinutes", "scheduledBy"]);
const CHANGE_ROW_VALUES = ["title", "description", "dueAt", "dueDate", "durationMinutes"] as const;

async function writeChangeRow(db: Db, actor: Actor, row: SeriesRow, task: Task, occursOn: string, input: TaskWrite, provenance: Provenance) {
  const unsupported = Object.keys(input).find((field) => input[field as keyof TaskWrite] !== undefined && !CHANGE_ROW_FIELDS.has(field));
  if (unsupported) {
    throw new CrmError("invalid_input", "Only the day, time, length, title and description can change for one upcoming date. Use repeatScope all for the rest.", 400, { field: unsupported });
  }
  if (!CHANGE_ROW_VALUES.some((field) => input[field] !== undefined)) {
    throw new CrmError("invalid_input", "Send the day, time, length, title or description to change for that date.", 400, { field: "occursOn" });
  }
  checkTaskWrite(input);
  await assertChangeRoom(db, row, task, occursOn);
  const before = (await changesOf(db, row.id)).find((change) => change.occursOn === occursOn) ?? null;
  if (before?.skip && input.dueAt === undefined && input.dueDate === undefined) {
    throw new CrmError("invalid_input", "That date is skipped. Send its day to bring it back.", 400, { field: "occursOn" });
  }
  const base = occurrenceFor(patternOf(row), occursOn, before ?? undefined);
  let dueAt: string | null = before?.dueAt ?? null;
  let dueHasTime: boolean | null = before?.dueHasTime ?? null;
  const probe = input.dueAt !== undefined || input.dueDate !== undefined ? createTaskProbe(input) : null;
  if (probe) {
    if (!probe.dueAt) throw new CrmError("invalid_input", "An upcoming date needs a day. Skip it instead.", 400, { field: "dueAt" });
    const day = taskDueDay(probe.dueAt)!;
    const field = input.dueAt !== undefined ? "dueAt" : "dueDate";
    const openDay = task.seriesId === row.id ? [task.occursOn, taskDueDay(task.dueAt)].filter((open): open is string => Boolean(open)).sort().at(-1) : null;
    if (openDay && day <= openDay) {
      throw new CrmError("invalid_input", `Move it to a day after the open one (${shortDay(openDay)}).`, 400, { field });
    }
    const near = await neighbourDays(db, actor, row, task, occursOn);
    if (day <= near.before || (near.after !== null && day >= near.after)) {
      throw new CrmError("invalid_input", `Choose a day after ${shortDay(near.before)}${near.after ? ` and before ${shortDay(near.after)}` : ""}.`, 400, { field });
    }
    dueAt = probe.dueAt;
    dueHasTime = probe.dueHasTime;
    if (dueHasTime && colleagueTime(actor, row.owner_id, row)) {
      dueAt = dayStartIso(day);
      dueHasTime = false;
    }
  }
  if (input.durationMinutes !== undefined && colleagueTime(actor, row.owner_id, row) && (dueAt ? Boolean(dueHasTime) : Boolean(row.at))) {
    throw new CrmError("forbidden", OWNER_SETS_LENGTH, 403, { field: "durationMinutes" });
  }
  const title = input.title !== undefined ? input.title.trim().slice(0, 200) || null : (before?.title ?? null);
  await db.query(
    `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, due_at, due_has_time, duration_minutes, title, description, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (series_id, occurs_on) do update set skip = excluded.skip, due_at = excluded.due_at, due_has_time = excluded.due_has_time,
       duration_minutes = excluded.duration_minutes, title = excluded.title, description = excluded.description`,
    [
      row.id,
      occursOn,
      false,
      dueAt,
      dueAt ? dueHasTime : null,
      input.durationMinutes ?? before?.durationMinutes ?? null,
      title,
      input.description !== undefined ? input.description : (before?.description ?? null),
      actor.type === "user" ? actor.userId : null,
    ],
  );
  await refreshAround(db, actor, row, task);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, await seriesAudit(db, row, after, { changed: occursOn, changeBefore: before, was: { dueAt: base.dueAt }, ...(probe && dueAt !== base.dueAt ? { moved: true } : {}) }));
}

function retimedChange(change: OccurrenceChange & { occursOn: string }, at: string | null) {
  const day = taskDueDay(change.dueAt);
  return day && day !== change.occursOn ? occurrenceTiming(at, day) : null;
}

async function resetTimedChanges(db: Db, seriesId: string, after: string, at: string | null) {
  const rows = await changesOf(db, seriesId, after);
  const timed = rows.filter((row) => row.dueAt && !row.skip);
  if (timed.length === 0) return [];
  for (const change of timed) {
    const moved = retimedChange(change, at);
    await db.query("update crm.task_occurrence_changes set due_at = $3, due_has_time = $4 where series_id = $1 and occurs_on = $2", [seriesId, change.occursOn, moved?.dueAt ?? null, moved ? moved.dueHasTime : null]);
  }
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

type SeriesValues = {
  title: string;
  description: string | null;
  priority: TaskPriority;
  owner_id: string | null;
  company_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  duration_minutes: number;
  at: string | null;
  remind_minutes: number | null;
};

function wantedClock(write: TaskWrite) {
  if (write.dueAt === undefined && write.dueDate === undefined) return undefined;
  const probe = createTaskProbe(write);
  return probe.dueHasTime && probe.dueAt ? clockLabel(probe.dueAt) : null;
}

function seriesUpdate(actor: Actor, row: SeriesRow, task: Task, input: TaskWrite): SeriesValues {
  const companyFollows = LINK_FIELDS.some((field) => input[field] !== undefined);
  const ownerId = input.ownerId !== undefined ? task.ownerId : row.owner_id;
  const ownerChanges = (ownerId ?? null) !== (row.owner_id ?? null);
  const clock = wantedClock(input);
  const colleague = colleagueTime(actor, ownerId, row);
  const at = clock !== undefined && clock !== row.at ? (colleague ? null : clock) : ownerChanges && colleague ? null : row.at;
  const remind =
    input.remindMinutes !== undefined ? (input.remindMinutes ?? null) : clock !== undefined && task.dueHasTime ? task.remindMinutes : (row.remind_minutes as number | null);
  return {
    title: input.title !== undefined ? task.title : row.title,
    description: input.description !== undefined ? task.description : row.description,
    priority: input.priority !== undefined ? task.priority : row.priority,
    owner_id: ownerId,
    company_id: companyFollows ? task.companyId : row.company_id,
    contact_id: input.contactId !== undefined ? task.contactId : row.contact_id,
    opportunity_id: input.opportunityId !== undefined ? task.opportunityId : row.opportunity_id,
    duration_minutes: input.durationMinutes !== undefined ? (input.durationMinutes ?? row.duration_minutes) : row.duration_minutes,
    at,
    remind_minutes: at ? remind : null,
  };
}

async function writeSeries(db: Db, id: string, values: SeriesValues) {
  await db.query(
    `update crm.task_series set title = $2, description = $3, priority = $4, owner_id = $5, company_id = $6, contact_id = $7,
       opportunity_id = $8, duration_minutes = $9, at = $10::time, remind_minutes = $11
     where id = $1`,
    [id, values.title, values.description, values.priority, values.owner_id, values.company_id, values.contact_id, values.opportunity_id, values.duration_minutes, values.at, values.remind_minutes],
  );
}

export const NEW_DAY_ALL = "A new day only changes that date. Send repeatScope this, or this and following to move the dates from there.";
export const NEW_DAY_OPEN = "A new day only changes this one. Send repeatScope this.";

function newDayOf(row: SeriesRow, occursOn: string, change: OccurrenceChange | undefined, input: TaskWrite) {
  if (input.dueAt === undefined && input.dueDate === undefined) return null;
  const probe = createTaskProbe(input);
  const day = taskDueDay(probe.dueAt);
  const current = occurrenceFor(patternOf(row), occursOn, change).day;
  return day && day !== current ? day : null;
}

function currentWrite(task: Task, input: TaskWrite, future: boolean): TaskWrite {
  if (!future) return input;
  const write: TaskWrite = { ...input };
  delete write.dueDate;
  delete write.dueAt;
  delete write.dueHasTime;
  if (input.dueAt === undefined && input.dueDate === undefined) return write;
  const probe = createTaskProbe(input);
  const day = taskDueDay(task.dueAt) ?? today();
  if (probe.dueAt && probe.dueHasTime) {
    write.dueAt = occurrenceTiming(clockLabel(probe.dueAt), day).dueAt;
    write.dueHasTime = true;
  } else if (probe.dueAt && task.dueAt) write.dueDate = day;
  return write;
}

const UNSTARTED_REFUSED = ["mailThreadKey", "docIds", "completed", "scheduledBy"] as const;

async function editUnstarted(db: Db, actor: Actor, row: SeriesRow, anchor: Task, given: TaskWrite, provenance: Provenance, chained = false) {
  const input: TaskWrite = { ...given };
  if (chained) for (const field of UNSTARTED_REFUSED) delete input[field];
  const ownerId = chained && input.ownerId !== undefined ? input.ownerId || null : row.owner_id;
  if (!chained && input.ownerId !== undefined && (input.ownerId || null) !== row.owner_id) {
    throw new CrmError("invalid_input", `These dates start on ${shortDay(row.starts_on)}. Change who they're for once they start.`, 400, { field: "ownerId" });
  }
  const unsupported = UNSTARTED_REFUSED.find((field) => input[field] !== undefined);
  if (unsupported) throw new CrmError("invalid_input", "Only the time, length, title, description, priority, reminder and links change for dates that haven't started.", 400, { field: unsupported });
  checkTaskWrite(input);
  checkLengths(input);
  const clock = wantedClock(input);
  const colleague = colleagueTime(actor, ownerId, row);
  const at = clock !== undefined && clock !== row.at ? (colleague ? null : clock) : ownerId !== row.owner_id && colleague ? null : row.at;
  const links = await chosenLinks(db, row, input);
  const values: SeriesValues = {
    title: input.title?.trim().slice(0, 200) || row.title,
    description: input.description !== undefined ? input.description : row.description,
    priority: input.priority ?? row.priority,
    owner_id: ownerId,
    ...links,
    duration_minutes: input.durationMinutes ?? row.duration_minutes,
    at,
    remind_minutes: at ? (input.remindMinutes !== undefined ? input.remindMinutes : row.remind_minutes) : null,
  };
  checkReminderRoom(row.rule, values.at, values.remind_minutes, values.duration_minutes);
  const reset = values.at !== row.at || handedAway(actor, row, values.owner_id) ? await resetTimedChanges(db, row.id, shiftDay(row.starts_on, -1), values.at) : [];
  await writeSeries(db, row.id, values);
  await refreshAround(db, actor, row, anchor);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", anchor.id, provenance, await seriesAudit(db, row, after, { scope: "all", resetChanges: reset }));
  return (await readTaskInDb(db, actor, anchor.id))!;
}

function overdue(task: Task, now = Date.now()) {
  return Boolean(task.dueAt && Date.parse(task.dueAt) <= now);
}

async function editChain(db: Db, actor: Actor, row: SeriesRow, task: Task, input: TaskWrite, future: boolean, provenance: Provenance) {
  const head = task.seriesId && task.seriesId !== row.id ? await lockSeries(db, task.seriesId) : null;
  const first = head && !stopped(head) && head.current_task_id === task.id && !task.completedAt && ownsSeries(actor, head) ? head : row;
  if (first !== row && input.completed !== undefined) {
    throw new CrmError("invalid_input", "Only the time, length, title, description, priority, reminder and links change for dates that haven't started.", 400, { field: "completed" });
  }
  const given: TaskWrite = { ...input };
  delete given.completed;
  if (task.seriesId !== first.id) await editUnstarted(db, actor, first, task, input, provenance, first !== row);
  else await editAll(db, actor, first, task, given, future || first !== row, provenance);
  const parts = await liveParts(db, actor, first.id);
  if (given.ownerId !== undefined && parts.some((part) => (given.ownerId || null) !== part.owner_id)) await assertRoom(db, actor, given.ownerId || null, "ownerId");
  for (const part of parts) await editUnstarted(db, actor, part, (await readTaskInDb(db, actor, task.id))!, given, provenance, true);
  if (input.completed === true && task.seriesId === first.id) {
    const after = await readSeries(db, first.id);
    const fresh = await readTaskInDb(db, actor, task.id);
    if (after && fresh && !fresh.completedAt) await writeOccurrence(db, actor, after, fresh, { completed: true }, provenance);
  }
  return (await readTaskInDb(db, actor, task.id))!;
}

async function editAll(db: Db, actor: Actor, row: SeriesRow, task: Task, given: TaskWrite, future: boolean, provenance: Provenance) {
  const write = currentWrite(task, given, future);
  const forTask: TaskWrite = { ...write };
  if (forTask.remindMinutes !== undefined && forTask.dueAt === undefined && forTask.dueDate === undefined && overdue(task)) delete forTask.remindMinutes;
  const handed = task.dueHasTime && task.ownerId !== row.owner_id && write.ownerId === undefined && colleagueTime(actor, task.ownerId, row);
  if (handed) {
    delete forTask.durationMinutes;
    delete forTask.dueAt;
    delete forTask.dueDate;
    delete forTask.dueHasTime;
    delete forTask.remindMinutes;
  }
  if (write.ownerId !== undefined && (write.ownerId || null) !== row.owner_id) await assertRoom(db, actor, write.ownerId || null, "ownerId");
  const planned = seriesUpdate(actor, row, { ...task, ownerId: write.ownerId !== undefined ? write.ownerId || null : task.ownerId }, write);
  checkReminderRoom(row.rule, planned.at, planned.remind_minutes, planned.duration_minutes);
  const saved = Object.keys(forTask).length > 0 ? await writeOccurrence(db, actor, row, task, forTask, provenance) : task;
  const values = seriesUpdate(actor, row, saved, write);
  const reset = values.at !== row.at || handedAway(actor, row, values.owner_id) ? await resetTimedChanges(db, row.id, saved.occursOn ?? row.starts_on, values.at) : [];
  await writeSeries(db, row.id, values);
  await refreshRoll(db, actor, row.id);
  const after = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, await seriesAudit(db, row, after, { scope: "all", resetChanges: reset }));
}

const FOLLOWING_REFUSED = ["docIds", "mailThreadKey", "completed"] as const;

async function chosenLinks(db: Db, row: SeriesRow, input: TaskWrite) {
  const followed = await currentLinksInDb(db, row.workspace_id, { companyId: row.company_id, contactId: row.contact_id, opportunityId: row.opportunity_id });
  const links = { company_id: followed.companyId, contact_id: followed.contactId, opportunity_id: followed.opportunityId };
  if (!LINK_FIELDS.some((field) => input[field] !== undefined)) return links;
  const found = await db.query<{ company: string | null; contact: string | null; contact_company: string | null; opportunity: string | null; opportunity_company: string | null }>(
    `select
       (select c.id from crm.companies c where c.id = $2 and c.workspace_id = $1 and c.archived_at is null) as company,
       (select c.id from crm.contacts c where c.id = $3 and c.workspace_id = $1 and c.archived_at is null) as contact,
       (select c.company_id from crm.contacts c where c.id = $3 and c.workspace_id = $1) as contact_company,
       (select o.id from crm.opportunities o where o.id = $4 and o.workspace_id = $1 and o.archived_at is null) as opportunity,
       (select o.company_id from crm.opportunities o where o.id = $4 and o.workspace_id = $1) as opportunity_company`,
    [row.workspace_id, isUuid(input.companyId ?? "") ? input.companyId : null, isUuid(input.contactId ?? "") ? input.contactId : null, isUuid(input.opportunityId ?? "") ? input.opportunityId : null],
  );
  const hit = found.rows[0];
  const missing = (field: (typeof LINK_FIELDS)[number], value: string | null) => {
    if (input[field] && !value) throw new CrmError("invalid_input", `That ${field === "companyId" ? "company" : field === "contactId" ? "person" : "opportunity"} isn't in this workspace.`, 400, { field });
  };
  missing("companyId", hit.company);
  missing("contactId", hit.contact);
  missing("opportunityId", hit.opportunity);
  if (input.companyId !== undefined) links.company_id = hit.company;
  if (input.contactId !== undefined) {
    links.contact_id = hit.contact;
    if (input.companyId === undefined && hit.contact_company) links.company_id = hit.contact_company;
  }
  if (input.opportunityId !== undefined) {
    links.opportunity_id = hit.opportunity;
    if (input.companyId === undefined && input.contactId === undefined && hit.opportunity_company) links.company_id = hit.opportunity_company;
  }
  return links;
}

function daysApart(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function pairedDays(from: RepeatPattern, to: RepeatPattern, first: string, last: string) {
  const old = occurrenceDays({ ...from, ends: { never: true } }, first, last);
  const fresh = occurrenceDays(to, to.startsOn, "9999-12-31", old.length);
  return new Map(old.flatMap((day, index) => (fresh[index] ? [[day, fresh[index]] as const] : [])));
}

function shiftedRule(rule: RepeatRule, from: string, to: string): RepeatRule {
  if (rule.freq === "weekly") {
    const shift = weekdayIndex(to) - weekdayIndex(from);
    return normalRule({ ...rule, weekdays: (rule.weekdays ?? []).map((day) => WEEKDAYS[(((WEEKDAYS.indexOf(day) + shift) % 7) + 7) % 7]) });
  }
  if (rule.freq === "monthly") {
    if (rule.monthWeek) {
      const week = monthWeekOf(to);
      return { freq: "monthly", interval: rule.interval, monthWeek: rule.monthWeek.n === -1 && isLastWeekOfMonth(to) ? { n: -1, weekday: week.weekday } : week };
    }
    return { freq: "monthly", interval: rule.interval, monthDay: Number(to.slice(8, 10)) };
  }
  if (rule.freq === "yearly") return { freq: "yearly", interval: rule.interval };
  return rule;
}

export const FOLLOWING_BEFORE_OPEN = "Choose a day after the open one.";
export const SPLITS_WEEKS = "That day would split its weeks. Choose another day.";

function splitsWeeks(rule: RepeatRule, from: string, to: string) {
  if (rule.freq !== "weekly" || rule.interval < 2) return false;
  const shift = weekdayIndex(to) - weekdayIndex(from);
  const wraps = (rule.weekdays ?? []).map((day) => WEEKDAYS.indexOf(day) + shift).map((index) => index < 0 || index > 6);
  return wraps.some(Boolean) && !wraps.every(Boolean);
}

async function editFollowing(db: Db, actor: Actor, row: SeriesRow, task: Task, occursOn: string, input: TaskWrite, provenance: Provenance) {
  const refused = FOLLOWING_REFUSED.find((field) => input[field] !== undefined);
  if (refused) throw new CrmError("invalid_input", "Change that on the open task.", 400, { field: refused });
  checkTaskWrite(input);
  checkLengths(input);
  const pattern = patternOf(row);
  const changes = await changesOf(db, row.id, shiftDay(occursOn, -1));
  const firstChange = changes.find((change) => change.occursOn === occursOn);
  const newDay = newDayOf(row, occursOn, firstChange, input);
  const dayField = input.dueAt !== undefined ? "dueAt" : "dueDate";
  if (newDay && newDay <= (taskDueDay(task.dueAt) ?? task.occursOn ?? occursOn)) throw new CrmError("invalid_input", FOLLOWING_BEFORE_OPEN, 400, { field: dayField });
  if (newDay) {
    const near = await neighbourDays(db, actor, row, task, occursOn);
    const before = near.lastKey > near.before ? near.lastKey : near.before;
    if (newDay <= before || (near.after !== null && newDay >= near.after)) {
      throw new CrmError("invalid_input", `Choose a day after ${shortDay(before)}${near.after ? ` and before ${shortDay(near.after)}` : ""}.`, 400, { field: dayField });
    }
    if (splitsWeeks(row.rule, occursOn, newDay)) throw new CrmError("invalid_input", SPLITS_WEEKS, 400, { field: dayField });
  }
  const startsOn = newDay ?? occursOn;
  const ownerId = input.ownerId !== undefined ? input.ownerId || null : row.owner_id;
  if (input.ownerId !== undefined && ownerId && !(await memberOrNull(db, row.workspace_id, ownerId))) throw new CrmError("invalid_input", "Choose an assignee in this workspace.", 400, { field: "ownerId" });
  const links = await chosenLinks(db, row, input);
  const clock = wantedClock(input);
  const colleague = colleagueTime(actor, ownerId, row);
  const at = clock !== undefined && clock !== row.at ? (colleague ? null : clock) : ownerId !== row.owner_id && colleague ? null : row.at;
  const remind = at ? (input.remindMinutes !== undefined ? (input.remindMinutes ?? null) : row.remind_minutes) : null;
  const duration = input.durationMinutes ?? row.duration_minutes;
  const rule = newDay ? anchoredRule(shiftedRule(row.rule, occursOn, newDay), null, newDay) : anchoredRule(row.rule, { rule: row.rule, startsOn: row.starts_on }, startsOn);
  checkReminderRoom(rule, at, remind, duration);
  let ends: RepeatEnds = row.ends;
  if ("count" in row.ends) {
    const last = lastOccurrence(pattern);
    let left = 0;
    for (let day: string | null = occursOn; day && last && day <= last; day = occurrenceAfter(pattern, day)) left += 1;
    ends = { count: Math.max(1, left) };
  }
  if ("until" in ends && newDay) {
    const left = occurrenceDays(pattern, occursOn, ends.until, MAX_COUNT + 1).length;
    const moved = left > 0 ? occurrenceDays({ startsOn, at, rule, ends: { never: true } }, startsOn, "9999-12-31", left).at(-1) : null;
    if (moved) ends = { until: moved };
  }
  if ("until" in ends && ends.until < startsOn) throw new CrmError("invalid_input", END_BEFORE_THIS, 400, { field: "dueAt" });
  const keepsCreator = actor.type === "user" && ownerId === actor.userId && row.created_by_agent_id !== null;
  const split = await db.query<{ id: string }>(
    `insert into crm.task_series (
       workspace_id, owner_id, created_by_user_id, created_by_agent_id, title, description, priority, company_id, contact_id, opportunity_id,
       starts_on, at, duration_minutes, remind_minutes, rule, ends, split_from_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::time, $13, $14, $15::jsonb, $16::jsonb, $17)
     returning id`,
    [
      row.workspace_id,
      ownerId,
      keepsCreator ? row.created_by_user_id : actor.type === "user" ? actor.userId : null,
      keepsCreator ? row.created_by_agent_id : actor.type === "agent" ? actor.agentId : null,
      input.title?.trim().slice(0, 200) || row.title,
      input.description !== undefined ? input.description : row.description,
      input.priority ?? row.priority,
      links.company_id,
      links.contact_id,
      links.opportunity_id,
      startsOn,
      at,
      duration,
      remind,
      JSON.stringify(rule),
      JSON.stringify(ends),
      row.id,
    ],
  );
  const newId = split.rows[0].id;
  const later = await db.query<SeriesRow>(`${SERIES_SQL} where s.split_from_id = $1 and s.id <> $2 and s.current_task_id is null and s.archived_at is null for update`, [row.id, newId]);
  const reparented = later.rows.filter((part) => ownsSeries(actor, part)).map((part) => part.id);
  if (reparented.length) await db.query("update crm.task_series set split_from_id = $2 where id = any($1::uuid[])", [reparented, newId]);
  const moving = changes.filter((change) => change.occursOn >= occursOn);
  const shifted = newDay ? pairedDays(pattern, { startsOn, at, rule, ends: { never: true } }, occursOn, moving.at(-1)?.occursOn ?? occursOn) : null;
  const dropped: ChangeRow[] = [];
  for (const change of moving) {
    const own = change.occursOn === occursOn;
    const target = shifted ? shifted.get(change.occursOn) : change.occursOn;
    if (!target) {
      dropped.push(change);
      continue;
    }
    const retimed = (at !== row.at || handedAway(actor, row, ownerId)) && change.dueAt && !own;
    const moved = retimed ? retimedChange(change, at) : null;
    const title = own && input.title !== undefined ? null : (change.title ?? null);
    const description = own && input.description !== undefined ? null : (change.description ?? null);
    const duration = own && input.durationMinutes !== undefined ? null : (change.durationMinutes ?? null);
    let dueAt = retimed ? (moved?.dueAt ?? null) : (change.dueAt ?? null);
    let dueHasTime = dueAt ? Boolean(retimed ? moved!.dueHasTime : change.dueHasTime) : null;
    if (shifted && dueAt) {
      if (own) dueAt = null;
      else {
        const due = occurrenceTiming(dueHasTime ? clockLabel(dueAt) : null, shiftDay(taskDueDay(dueAt)!, daysApart(change.occursOn, target)));
        dueAt = due.dueAt;
        dueHasTime = due.dueHasTime;
      }
    }
    if (!change.skip && !dueAt && !title && description === null && duration === null) continue;
    await db.query(
      `insert into crm.task_occurrence_changes (series_id, occurs_on, skip, due_at, due_has_time, duration_minutes, title, description, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
      [newId, target, change.skip ?? false, dueAt, dueAt ? dueHasTime : null, duration, title, description, actor.type === "user" ? actor.userId : null],
    );
  }
  const probe = input.dueAt !== undefined || input.dueDate !== undefined ? createTaskProbe(input) : null;
  if (!newDay && probe?.dueAt && firstChange?.dueAt) {
    await db.query("update crm.task_occurrence_changes set due_at = $3, due_has_time = $4 where series_id = $1 and occurs_on = $2", [newId, occursOn, at ? probe.dueAt : dayStartIso(taskDueDay(probe.dueAt)!), Boolean(at)]);
  }
  await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on >= $2::date", [row.id, occursOn]);
  const until = shiftDay(startsOn < occursOn ? startsOn : occursOn, -1);
  await db.query(`update crm.task_series set ends = jsonb_build_object('until', $2::text) where id = $1`, [row.id, until]);
  const parent = (await readSeries(db, row.id))!;
  const parentNext = task.completedAt ? null : nextOccurrence(patternOf(parent), await changesOf(db, row.id, task.occursOn), task.occursOn ?? until);
  if (task.seriesId === row.id && !parentNext && (task.completedAt || row.current_task_id !== task.id)) await finishSeries(db, actor, parent, task, provenance);
  await refreshRoll(db, actor, row.id);
  const after = await readSeries(db, row.id);
  const splitRow = await readSeries(db, newId);
  await recordAudit(
    db,
    actor,
    "task_series.updated",
    "task",
    task.id,
    provenance,
    await seriesAudit(db, row, after, { scope: "following", split: { seriesId: newId, from: occursOn }, movedChanges: moving, ...(dropped.length ? { droppedChanges: dropped } : {}), ...(reparented.length ? { reparented } : {}) }),
  );
  if (splitRow?.current_task_id) {
    await recordAudit(db, actor, "task_series.created", "task", splitRow.current_task_id, provenance, { series: { id: newId, before: null, after: snapshotOf(splitRow) }, splitFrom: row.id });
  }
  return (await readTaskInDb(db, actor, task.id))!;
}

export const DONE_ALREADY = "This one is done now. Change the open one instead.";

async function withoutResent(db: Db, actor: Actor, row: SeriesRow, task: Task, occursOn: string, future: boolean, input: TaskWrite) {
  const owner = input.ownerId !== undefined ? input.ownerId || null : future ? row.owner_id : task.ownerId;
  if (!colleagueTime(actor, owner, row)) return input;
  const change = future ? (await changesOf(db, row.id)).find((item) => item.occursOn === occursOn) : undefined;
  const current = future ? occurrenceFor(patternOf(row), occursOn, change) : { dueAt: task.dueAt, dueHasTime: task.dueHasTime };
  const duration = future ? (change?.durationMinutes ?? row.duration_minutes) : task.durationMinutes;
  const kept: TaskWrite = { ...input };
  const due = input.dueAt !== undefined || input.dueDate !== undefined ? readDue(input) : undefined;
  if (due?.dueAt && current.dueAt && due.dueHasTime && current.dueHasTime && Date.parse(due.dueAt) === Date.parse(current.dueAt)) {
    delete kept.dueAt;
    delete kept.dueDate;
    delete kept.dueHasTime;
  }
  if (input.durationMinutes !== undefined && input.durationMinutes === duration) delete kept.durationMinutes;
  return kept;
}

export async function updateOccurrenceInDb(db: Db, actor: Actor, target: OccurrenceTarget, input: TaskWrite, scope: RepeatScope | undefined, provenance: Provenance) {
  const found = await resolveTarget(db, actor, target);
  const { task, row } = found;
  if (row && found.occursOn && !stopped(row) && (found.future || (row.current_task_id === task.id && !task.completedAt))) {
    const sent = Object.keys(input).filter((key) => input[key as keyof TaskWrite] !== undefined).length;
    input = await withoutResent(db, actor, row, task, found.occursOn, found.future, input);
    if (sent > 0 && Object.keys(input).every((key) => input[key as keyof TaskWrite] === undefined)) return (await readTaskInDb(db, actor, task.id))!;
  }
  if (!row && (scope === "all" || scope === "following")) {
    hiddenSeries(actor, task, "repeatScope");
    throw new CrmError("invalid_input", "This task doesn't repeat. Leave out repeatScope.", 400, { field: "repeatScope" });
  }
  const live = row && !stopped(row);
  if (live && !found.future && (scope === "all" || scope === "following") && (task.completedAt || row.current_task_id !== task.id)) {
    throw new CrmError("conflict", DONE_ALREADY, 409, { field: "repeatScope" });
  }
  const plain = !row || !found.occursOn || (!found.future && (stopped(row) || task.completedAt || row.current_task_id !== task.id));
  if (plain) return (await updateTaskInDb(db, actor, task.id, input, provenance)).task;
  if (input.dueAt === null || input.dueDate === null || input.dueAt === "" || input.dueDate === "") {
    throw new CrmError("invalid_input", "A repeating task needs a day. Stop repeating first.", 400, { field: "dueAt" });
  }
  const touches = touchesSeries(task, input) || found.future;
  if (touches && !scope) throw new CrmError("invalid_input", NEEDS_SCOPE, 400, { field: "repeatScope" });
  const relinks = LINK_FIELDS.some((field) => input[field] !== undefined);
  const movesDay = (input.dueAt !== undefined || input.dueDate !== undefined) && taskDueDay(readDue(input)?.dueAt ?? null) !== taskDueDay(task.dueAt);
  if (!found.future && (scope === "all" || scope === "following") && movesDay) {
    throw new CrmError("invalid_input", NEW_DAY_OPEN, 400, { field: input.dueAt !== undefined ? "dueAt" : "dueDate" });
  }
  if ((!touches && !(relinks && (scope === "all" || scope === "following"))) || scope === "this") {
    if (!found.future) {
      const follows = !scope;
      const saved = (await updateTaskInDb(db, actor, task.id, input, provenance, { series: seriesRights(row), ...(follows ? { beforeAudit: followSeriesLinksOnSave(db, actor, provenance) } : {}) })).task;
      if (input.ownerId !== undefined && row.owner_id && row.owner_id !== (input.ownerId || null) && (await memberOrNull(db, row.workspace_id, row.owner_id))) {
        if (actor.type === "user") await addTaskParticipantsInDb(db, actor, task.id, [row.owner_id], provenance, { alert: false });
        else await db.query("select crm.series_tag_owner($1)", [task.id]);
      }
      return follows ? (await readTaskInDb(db, actor, task.id))! : saved;
    }
    assertSeriesChange(actor, row);
    await writeChangeRow(db, actor, row, task, found.occursOn!, input, provenance);
    return (await readTaskInDb(db, actor, task.id))!;
  }
  assertSeriesChange(actor, row);
  if (stopped(row) && found.future) throw new CrmError("invalid_input", "It doesn't repeat any more.", 400, { field: "repeatScope" });
  if (scope === "following" && found.future && task.seriesId !== row.id && occurrenceOnOrAfter(patternOf(row), row.starts_on) === found.occursOn) {
    const change = (await changesOf(db, row.id)).find((item) => item.occursOn === found.occursOn);
    if (newDayOf(row, found.occursOn!, change, input)) throw new CrmError("invalid_input", KEEPS_DAY, 400, { field: input.dueAt !== undefined ? "dueAt" : "dueDate" });
    return editUnstarted(db, actor, row, task, input, provenance);
  }
  if (scope === "following" && found.future) return editFollowing(db, actor, row, task, found.occursOn!, input, provenance);
  if (found.future) {
    const change = (await changesOf(db, row.id)).find((item) => item.occursOn === found.occursOn);
    if (newDayOf(row, found.occursOn!, change, input)) throw new CrmError("invalid_input", NEW_DAY_ALL, 400, { field: input.dueAt !== undefined ? "dueAt" : "dueDate" });
  }
  return editChain(db, actor, row, task, input, found.future, provenance);
}

async function liveParts(db: Db, actor: Actor, seriesId: string) {
  const parts = await db.query<SeriesRow>(
    `${SERIES_SQL} where s.id in (select id from crm.series_later_parts($1)) and s.current_task_id is null and s.ended_at is null and s.archived_at is null order by s.starts_on for update`,
    [seriesId],
  );
  return parts.rows.filter((part) => ownsSeries(actor, part));
}

async function stopLaterParts(db: Db, actor: Actor, seriesId: string) {
  const mine = (await liveParts(db, actor, seriesId)).map((part) => part.id);
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
    if (task.completedAt || row.current_task_id !== task.id) throw new CrmError("conflict", DONE_ALREADY, 409, { field: "repeat" });
    await db.query("update crm.task_series set ended_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
    const stoppedParts = await stopLaterParts(db, actor, row.id);
    const dropped = await changesOf(db, row.id, task.occursOn);
    await db.query("delete from crm.task_occurrence_changes where series_id = $1", [row.id]);
    const after = await readSeries(db, row.id);
    await recordAudit(db, actor, "task_series.ended", "task", task.id, provenance, await seriesAudit(db, row, after, { droppedChanges: dropped, ...(stoppedParts.length ? { stoppedParts } : {}) }));
    return (await readTaskInDb(db, actor, task.id))!;
  }
  if (task.completedAt) throw new CrmError("invalid_input", "This task is done. Reopen it first.", 400, { field: "repeat" });
  const live = row && !stopped(row) ? row : null;
  const start = startOf(task, now);
  const anchor = live && task.occursOn ? task.occursOn : start.day;
  const parts = live && ownsSeries(actor, live) ? await liveParts(db, actor, live.id) : [];
  const chain = live ? chainEnds(patternOf(live), parts.map(patternOf)) : null;
  const keepsEnd = live && repeat && typeof repeat === "object" && !Array.isArray(repeat) && !("ends" in repeat);
  const read = readRepeat(keepsEnd ? { ...(repeat as object), ends: repeatInputOf(live.rule, chain!).ends ?? null } : repeat, anchor, now);
  if (!live) return repeatTaskInDb(db, actor, task, row, read, start, provenance, now);
  assertSeriesChange(actor, live);
  const spent = "count" in live.ends ? (live.ends.spent ?? 0) : 0;
  const consumed = spent + (task.occursOn ? occurrenceDays({ ...patternOf(live), ends: { never: true } }, live.starts_on, shiftDay(task.occursOn, -1), MAX_COUNT + 1).length : 0);
  const asked = anchoredRule(read.rule, { rule: live.rule, startsOn: live.starts_on }, anchor);
  const samePattern = sameRule(asked, anchoredRule(live.rule, { rule: live.rule, startsOn: live.starts_on }, anchor));
  let ends: RepeatEnds = read.ends;
  if (samePattern && "count" in ends && spent > 0) ends = { count: ends.count, spent: Math.min(spent, ends.count - 1) };
  if (samePattern && parts.length > 0 && sameEnds(read.ends, chain!)) return task;
  if (samePattern && JSON.stringify(ends) === JSON.stringify(live.ends)) return task;
  if (samePattern && parts.length > 0) return endChainInDb(db, actor, live, parts, task, read.ends, provenance);
  if (samePattern) {
    if ("until" in ends && ends.until < (task.occursOn ?? anchor)) throw new CrmError("invalid_input", END_BEFORE_THIS, 400, { field: "repeat.ends" });
    checkReachesEnd({ ...patternOf(live), ends });
    const oldLast = lastOccurrence(patternOf(live));
    const newLast = lastOccurrence({ ...patternOf(live), ends });
    if ("count" in ends && task.occursOn && newLast !== null && newLast < task.occursOn) throw new CrmError("invalid_input", TOO_FEW_TIMES, 400, { field: "repeat.ends" });
    const stoppedParts = newLast === null || (oldLast !== null && newLast > oldLast) ? await stopLaterParts(db, actor, live.id) : [];
    await db.query("update crm.task_series set ends = $2::jsonb where id = $1", [live.id, JSON.stringify(ends)]);
    const removed = "until" in ends ? await changesOf(db, live.id, ends.until) : [];
    if ("until" in ends) await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on > $2::date", [live.id, ends.until]);
    await refreshRoll(db, actor, live.id);
    const after = await readSeries(db, live.id);
    await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, await seriesAudit(db, live, after, { droppedChanges: removed, ...(stoppedParts.length ? { stoppedParts } : {}) }));
    return (await readTaskInDb(db, actor, task.id))!;
  }
  const onPattern = firstPatternDay(asked, patternAnchor(asked, anchor), anchor);
  const taken = await takenDays(db, live.id, task.id);
  let startDay = onPattern;
  for (let guard = 0; startDay && taken.has(startDay) && guard <= MAX_EXPANSION; guard += 1) startDay = firstPatternDay(asked, patternAnchor(asked, anchor), shiftDay(startDay, 1));
  if (!startDay) throw new CrmError("invalid_input", "That repeat has no dates. Choose another.", 400, { field: "repeat" });
  const rule = anchoredRule(asked, { rule: live.rule, startsOn: live.starts_on }, startDay);
  if ("count" in ends && ends.count <= consumed) throw new CrmError("invalid_input", TOO_FEW_TIMES, 400, { field: "repeat.ends" });
  const kept: RepeatEnds = "count" in ends ? { count: ends.count, spent: Math.min(consumed, ends.count - 1) } : ends;
  if ("until" in kept && kept.until < startDay) throw new CrmError("invalid_input", END_BEFORE_THIS, 400, { field: "repeat.ends" });
  checkReachesEnd({ startsOn: startDay, at: live.at, rule, ends: kept });
  checkReminderRoom(rule, live.at, live.remind_minutes, live.duration_minutes);
  const stoppedParts = await stopLaterParts(db, actor, live.id);
  const existing = await changesOf(db, live.id);
  const movedDays = existing.filter((change) => change.dueAt && taskDueDay(change.dueAt) !== change.occursOn).map((change) => change.occursOn);
  const lost = new Set(lostChangeDays(existing.map((change) => change.occursOn), { startsOn: startDay, at: live.at, rule, ends: kept }, movedDays));
  const dropped = existing.filter((change) => lost.has(change.occursOn));
  await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on = any($2::date[])", [live.id, [...lost]]);
  await db.query("update crm.task_series set rule = $2::jsonb, ends = $3::jsonb, starts_on = $4 where id = $1", [live.id, JSON.stringify(rule), JSON.stringify(kept), startDay]);
  await db.query("update crm.tasks set occurs_on = $2 where id = $1", [task.id, startDay]);
  if (startDay !== anchor && taskDueDay(task.dueAt) === anchor) {
    const moved = occurrenceFor({ startsOn: startDay, at: task.dueHasTime && task.dueAt ? clockLabel(task.dueAt) : null, rule, ends: kept }, startDay, undefined);
    const fresh = (await readSeries(db, live.id))!;
    await writeOccurrence(db, actor, fresh, (await readTaskInDb(db, actor, task.id))!, moveWrite(moved, task), provenance, { seriesMove: true, auditExtra: { repeat: { seriesId: live.id, kind: "pattern", from: task.occursOn, to: startDay, passed: [] } } });
  }
  await refreshRoll(db, actor, live.id);
  const after = await readSeries(db, live.id);
  await recordAudit(
    db,
    actor,
    "task_series.updated",
    "task",
    task.id,
    provenance,
    await seriesAudit(db, live, after, { scope: "all", droppedChanges: dropped, occursOnBefore: task.occursOn, ...(stoppedParts.length ? { stoppedParts } : {}) }),
  );
  return (await readTaskInDb(db, actor, task.id))!;
}

async function endChainInDb(db: Db, actor: Actor, live: SeriesRow, parts: SeriesRow[], task: Task, ends: RepeatEnds, provenance: Provenance) {
  const patterns = [live, ...parts].map(patternOf);
  let until = "until" in ends ? ends.until : null;
  let lastCount: number | null = null;
  if ("count" in ends) {
    let left = ends.count;
    for (const [index, pattern] of patterns.entries()) {
      if (index === patterns.length - 1) {
        lastCount = left;
        break;
      }
      const days = occurrenceDays(pattern, pattern.startsOn, lastOccurrence(pattern) ?? pattern.startsOn, MAX_COUNT + 1);
      if (left <= days.length) {
        until = days[left - 1];
        break;
      }
      left -= days.length;
    }
  }
  if (until !== null && task.occursOn && until < task.occursOn) {
    throw new CrmError("invalid_input", "count" in ends ? TOO_FEW_TIMES : END_BEFORE_THIS, 400, { field: "repeat.ends" });
  }
  const kept = until === null ? parts : parts.filter((part) => part.starts_on <= until);
  const stoppedParts = parts.filter((part) => !kept.includes(part)).map((part) => part.id);
  const holder = kept.at(-1) ?? null;
  const holderEnds: RepeatEnds = lastCount !== null ? { count: lastCount } : until !== null ? { until } : { never: true };
  if (holder) checkReachesEnd({ ...patternOf(holder), ends: holderEnds });
  if (stoppedParts.length) await db.query("update crm.task_series set ended_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null where id = any($1::uuid[])", [stoppedParts]);
  const partEnds = holder ? [{ id: holder.id, ends: holder.ends }] : [];
  if (holder) await db.query("update crm.task_series set ends = $2::jsonb where id = $1", [holder.id, JSON.stringify(holderEnds)]);
  let removed: ChangeRow[] = [];
  if (!holder && until !== null) {
    await db.query("update crm.task_series set ends = $2::jsonb where id = $1", [live.id, JSON.stringify({ until })]);
    removed = await changesOf(db, live.id, until);
    await db.query("delete from crm.task_occurrence_changes where series_id = $1 and occurs_on > $2::date", [live.id, until]);
  }
  await refreshRoll(db, actor, live.id);
  const after = await readSeries(db, live.id);
  await recordAudit(
    db,
    actor,
    "task_series.updated",
    "task",
    task.id,
    provenance,
    await seriesAudit(db, live, after, { droppedChanges: removed, ...(stoppedParts.length ? { stoppedParts } : {}), ...(partEnds.length ? { partEnds } : {}) }),
  );
  return (await readTaskInDb(db, actor, task.id))!;
}

async function restorePartEnds(db: Db, actor: Actor, saved: unknown) {
  if (!Array.isArray(saved)) return;
  for (const item of saved as { id?: unknown; ends?: unknown }[]) {
    if (typeof item?.id !== "string" || !isUuid(item.id) || !item.ends || typeof item.ends !== "object") continue;
    const part = await lockSeries(db, item.id);
    if (part && ownsSeries(actor, part)) await db.query("update crm.task_series set ends = $2::jsonb where id = $1", [part.id, JSON.stringify(item.ends)]);
  }
}

async function repeatTaskInDb(
  db: Db,
  actor: Actor,
  task: Task,
  row: SeriesRow | null,
  read: { rule: RepeatRule; ends: RepeatEnds },
  start: { day: string; at: string | null },
  provenance: Provenance,
  now: number,
) {
  await assertRoom(db, actor, task.ownerId);
  checkLengths(task);
  const first = firstDay(read.rule, start.at, start.day, now);
  if (!first || ("until" in read.ends && read.ends.until < first)) throw new CrmError("invalid_input", END_BEFORE_THIS, 400, { field: "repeat.ends" });
  const rule = anchoredRule(read.rule, { rule: read.rule, startsOn: start.day }, first);
  checkReachesEnd({ startsOn: first, at: start.at, rule, ends: read.ends });
  checkReminderRoom(rule, start.at, task.remindMinutes, task.durationMinutes);
  if (row) await db.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [task.id]);
  let current = task;
  if (!task.dueAt || taskDueDay(task.dueAt) !== first) {
    const timing = occurrenceTiming(start.at, first);
    current = (await updateTaskInDb(db, actor, task.id, timing.dueHasTime ? { dueAt: timing.dueAt, dueHasTime: true } : { dueDate: first }, provenance)).task;
  }
  const at = current.dueHasTime && current.dueAt ? clockLabel(current.dueAt) : null;
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
      first,
      at,
      current.durationMinutes,
      at ? current.remindMinutes : null,
      JSON.stringify(rule),
      JSON.stringify(read.ends),
    ],
  );
  await db.query("update crm.tasks set series_id = $2, occurs_on = $3 where id = $1", [current.id, inserted.rows[0].id, first]);
  await db.query("update crm.task_series set current_task_id = $2 where id = $1", [inserted.rows[0].id, current.id]);
  await refreshRoll(db, actor, inserted.rows[0].id);
  const created = (await readSeries(db, inserted.rows[0].id))!;
  await recordAudit(db, actor, "task_series.created", "task", current.id, provenance, {
    series: { id: created.id, before: null, after: snapshotOf(created), state: await seriesState(db, created.id), stateScope: "all" },
    ...(row && task.occursOn ? { previousSeries: { id: row.id, occursOn: task.occursOn } } : {}),
  });
  return (await readTaskInDb(db, actor, current.id))!;
}

export async function endSeriesOnInDb(db: Db, actor: Actor, taskId: string, until: string, provenance: Provenance) {
  if (!isDayKey(until)) throw new CrmError("invalid_input", "Choose an end date.", 400, { field: "until" });
  const found = await resolveTarget(db, actor, { taskId });
  if (!found.row) {
    hiddenSeries(actor, found.task, "until");
    throw new CrmError("invalid_input", "This task doesn't repeat.", 400, { field: "until" });
  }
  if (stopped(found.row)) throw new CrmError("invalid_input", "It doesn't repeat any more.", 400, { field: "until" });
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
  if (peek.ended_at && ownsSeries(actor, peek)) {
    const carried = await db.query<{ task_id: string }>(
      `select s.current_task_id as task_id from crm.task_series s
       where s.id in (select id from crm.series_later_parts($1)) and s.current_task_id is not null and s.ended_at is null and s.archived_at is null
       order by s.starts_on desc limit 1`,
      [peek.id],
    );
    const next = carried.rows[0]?.task_id;
    if (next && next !== taskId) return deleteSeriesInDb(db, actor, next, provenance);
  }
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
  await recordAudit(db, actor, "task_series.deleted", "task", anchor.id, provenance, await seriesAudit(db, row, after, { archivedTask: anchor === open ? open.id : null, ...(stoppedParts.length ? { stoppedParts } : {}) }));
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

export const SPLIT_AGAIN = "Can't undo: its later dates were changed again since. Undo that first.";

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
  if (revives && before) await assertRoom(db, actor, (await memberOrNull(db, row.workspace_id, before.ownerId)) ?? row.owner_id);
  if (!before) {
    await db.query("update crm.task_series set archived_at = coalesce(archived_at, now()), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [row.id]);
    if (row.current_task_id) {
      const task = await readTaskInDb(db, actor, row.current_task_id);
      if (task && changes.withTask && !task.archivedAt) await writeOccurrence(db, actor, row, task, {}, provenance, { archive: true });
      else if (task) {
        await writeOccurrence(db, actor, row, task, {}, provenance, { detach: true });
        await rejoinPrevious(db, actor, task.id, changes.previousSeries);
      }
      await recordUndoneSeries(db, actor, row, row.current_task_id, provenance);
    }
    return;
  }
  const split = changes.split as { seriesId?: string } | undefined;
  if (split?.seriesId) {
    const moved = Array.isArray(changes.reparented) ? changes.reparented.filter((id): id is string => typeof id === "string" && isUuid(id)) : [];
    const splitAgain = await db.query("select 1 from crm.task_series where split_from_id = $1 and archived_at is null and ended_at is null and not (id = any($2::uuid[]))", [split.seriesId, moved]);
    if ((splitAgain.rowCount ?? 0) > 0) throw new CrmError("cannot_undo", SPLIT_AGAIN, 409);
    const child = await lockSeries(db, split.seriesId);
    if (child?.current_task_id) {
      const created = await readTaskInDb(db, actor, child.current_task_id);
      if (created && !created.archivedAt) await writeOccurrence(db, actor, child, created, {}, provenance, { archive: true });
    }
    await db.query("update crm.task_series set archived_at = now(), roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [split.seriesId]);
    const reparented = Array.isArray(changes.reparented) ? changes.reparented.filter((id): id is string => typeof id === "string" && isUuid(id)) : [];
    if (reparented.length) await db.query("update crm.task_series set split_from_id = $2 where id = any($1::uuid[]) and split_from_id = $3", [reparented, row.id, split.seriesId]);
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
  await restorePartEnds(db, actor, changes.partEnds);
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
  await recordUndoneSeries(db, actor, row, row.current_task_id, provenance);
}

async function rejoinPrevious(db: Db, actor: Actor, taskId: string, previous: unknown) {
  const saved = previous as { id?: unknown; occursOn?: unknown } | undefined;
  if (typeof saved?.id !== "string" || !isUuid(saved.id) || !isDayKey(saved.occursOn)) return;
  const row = await lockSeries(db, saved.id);
  if (!row || row.archived_at || (row.current_task_id !== null && row.current_task_id !== taskId) || !ownsSeries(actor, row)) return;
  const moved = await db.query("update crm.tasks set series_id = $2, occurs_on = $3 where id = $1 and series_id is null", [taskId, row.id, saved.occursOn]);
  if ((moved.rowCount ?? 0) > 0) await db.query("update crm.task_series set current_task_id = $2 where id = $1", [row.id, taskId]);
}

async function recordUndoneSeries(db: Db, actor: Actor, row: SeriesRow, taskId: string | null, provenance: Provenance) {
  if (!taskId) return;
  const restored = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", taskId, provenance, { ...(await seriesAudit(db, row, restored)), undoing: true });
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
  if (typeof repeat.fromSeriesId === "string" && isUuid(repeat.fromSeriesId) && (await backIntoEarlierPart(db, actor, taskId, from, seriesId, repeat.fromSeriesId, repeat))) return;
  await db.query("update crm.tasks set occurs_on = $2 where id = $1 and series_id = $3", [taskId, from, seriesId]);
  const row = await readSeries(db, seriesId);
  if (row && ownsSeries(actor, row)) for (const change of (repeat.consumed as ChangeRow[] | undefined) ?? []) await putChange(db, actor, seriesId, change);
  await refreshRoll(db, actor, seriesId);
}

async function backIntoEarlierPart(db: Db, actor: Actor, taskId: string, from: string, partId: string, earlierId: string, repeat: Record<string, unknown>) {
  const earlier = await lockSeries(db, earlierId);
  const part = await lockSeries(db, partId);
  if (!earlier || !part || part.split_from_id !== earlier.id || !ownsSeries(actor, earlier) || !ownsSeries(actor, part)) return false;
  if (part.current_task_id !== taskId || earlier.archived_at || (earlier.current_task_id !== null && earlier.current_task_id !== taskId)) return false;
  await db.query("update crm.task_series set current_task_id = null, roll_at = null, roll_pending = false, roll_retry_at = null where id = $1", [part.id]);
  await db.query("update crm.task_series set ended_at = null where id = $1", [part.id]);
  await db.query("update crm.tasks set series_id = $2, occurs_on = $3 where id = $1", [taskId, earlier.id, from]);
  await db.query("update crm.task_series set current_task_id = $2, ended_at = null where id = $1", [earlier.id, taskId]);
  for (const change of (repeat.consumed as ChangeRow[] | undefined) ?? []) if (isDayKey(change.occursOn)) await putChange(db, actor, part.id, change);
  await refreshRoll(db, actor, earlier.id);
  return true;
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
  const repeats = input.repeat !== undefined && input.repeat !== null;
  const hash = requestHash("create_task", { input: repeats ? input : write, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 201, async () => ({
      task: repeats ? await createRepeatingTaskInDb(db, actor, write, input.repeat, provenance) : (await createTaskInDb(db, actor, write, provenance))!,
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
        if (fields || input.repeat !== undefined || scope !== undefined) throw new CrmError("invalid_input", "Send skip on its own.", 400, { field: "skip" });
        const result = await skipOccurrenceInDb(db, actor, occurrence, { ...provenance, operation: "skip_occurrence" });
        return { task: result.task, skipped: result.skipped };
      }
      if (input.repeat !== undefined && !("taskId" in occurrence)) {
        const open = await openOccurrenceOn(db, actor, occurrence.seriesId, occurrence.occursOn);
        if (!open) throw new CrmError("invalid_input", "Change how it repeats from the open task.", 400, { field: "repeat" });
        occurrence = { taskId: open };
      }
      let task: Task | null = null;
      if (input.repeat !== undefined && "taskId" in occurrence) {
        const repeatProvenance = { ...provenance, operation: input.repeat === null ? "stop_repeating" : "set_repeat" };
        const current = isUuid(occurrence.taskId) ? (given ?? (await readTaskInDb(db, actor, occurrence.taskId))) : null;
        const plainFirst = input.repeat !== null && fields && current && !(await liveSeriesTask(db, current));
        if (plainFirst) task = await updateOccurrenceInDb(db, actor, occurrence, write, scope, provenance);
        task = await setRepeatInDb(db, actor, occurrence.taskId, input.repeat, repeatProvenance);
        if (plainFirst) return { task };
      }
      if (fields || !task) task = await updateOccurrenceInDb(db, actor, occurrence, write, scope, provenance);
      return { task };
    }),
  );
}

async function liveSeriesTask(db: Db, task: Task) {
  const row = task.seriesId ? await readSeries(db, task.seriesId) : null;
  return Boolean(row && !stopped(row) && row.current_task_id === task.id && !task.completedAt);
}

async function openOccurrenceOn(db: Db, actor: Actor, seriesId: string, occursOn: string) {
  if (!isUuid(seriesId)) return null;
  const row = await readSeries(db, seriesId);
  if (!row?.current_task_id || stopped(row)) return null;
  const open = await readTaskInDb(db, actor, row.current_task_id);
  return open && !open.completedAt && open.occursOn === occursOn ? open.id : null;
}

type SeriesLinks = { companyId: string | null; contactId: string | null; opportunityId: string | null };

function seriesLinksOf(row: SeriesRow): SeriesLinks {
  return { companyId: row.company_id, contactId: row.contact_id, opportunityId: row.opportunity_id };
}

const SERIES_LINK_FIELDS = ["companyId", "contactId", "opportunityId"] as const;

async function syncSeriesLinksInDb(db: Db, actor: Actor, task: Task, changed: string[], provenance: Provenance) {
  const fields = SERIES_LINK_FIELDS.filter((field) => changed.includes(field));
  if (!fields.length || !task.seriesId || task.completedAt) return null;
  const row = await lockSeries(db, task.seriesId);
  if (!row || row.current_task_id !== task.id || stopped(row) || !ownsSeries(actor, row)) return null;
  const before = seriesLinksOf(row);
  const after: SeriesLinks = { ...before };
  for (const field of fields) after[field] = task[field] ?? null;
  if (SERIES_LINK_FIELDS.every((field) => before[field] === after[field])) return null;
  await db.query("update crm.task_series set company_id = $2, contact_id = $3, opportunity_id = $4 where id = $1", [row.id, after.companyId, after.contactId, after.opportunityId]);
  const changedRow = await readSeries(db, row.id);
  await recordAudit(db, actor, "task_series.updated", "task", task.id, provenance, await seriesAudit(db, row, changedRow, { scope: "all", followsChange: true }));
  return { seriesLinks: { seriesId: row.id, before, after } };
}

export function followSeriesLinksOnSave(db: Db, actor: Actor, provenance: Provenance) {
  return (task: Task, changed: string[]) => syncSeriesLinksInDb(db, actor, task, changed, provenance);
}

export async function restoreSeriesLinksInDb(db: Db, actor: Actor, record: Record<string, unknown>, provenance: Provenance = { operation: "undo_change" }, undoneTaskId: string | null = null) {
  const seriesId = typeof record.seriesId === "string" && isUuid(record.seriesId) ? record.seriesId : null;
  const before = record.before as Partial<SeriesLinks> | undefined;
  const after = record.after as Partial<SeriesLinks> | undefined;
  if (!seriesId || !before || !after) return;
  const row = await lockSeries(db, seriesId);
  if (!row || stopped(row) || !ownsSeries(actor, row)) return;
  const now = seriesLinksOf(row);
  const same = (["companyId", "contactId", "opportunityId"] as const).every((field) => (now[field] ?? null) === (after[field] ?? null));
  if (!same) return;
  const back = await linksStillThere(db, row.workspace_id, before);
  await db.query("update crm.task_series set company_id = $2, contact_id = $3, opportunity_id = $4 where id = $1", [row.id, back.companyId, back.contactId, back.opportunityId]);
  await recordUndoneSeries(db, actor, row, row.current_task_id, provenance);
  const open = undoneTaskId && row.current_task_id && row.current_task_id !== undoneTaskId ? await readTaskInDb(db, actor, row.current_task_id) : null;
  if (open && !open.completedAt && !open.archivedAt && (["companyId", "contactId", "opportunityId"] as const).every((field) => (open[field] ?? null) === (after[field] ?? null))) {
    await updateTaskInDb(db, actor, open.id, back, provenance, { series: seriesRights(row) });
  }
}

async function linksStillThere(db: Db, workspaceId: string, links: Partial<SeriesLinks>): Promise<SeriesLinks> {
  const found = await db.query<{ company_id: string | null; contact_id: string | null; opportunity_id: string | null }>(
    `select
       (select id from crm.companies where id = $2 and workspace_id = $1 and archived_at is null) as company_id,
       (select id from crm.contacts where id = $3 and workspace_id = $1 and archived_at is null) as contact_id,
       (select id from crm.opportunities where id = $4 and workspace_id = $1 and archived_at is null) as opportunity_id`,
    [workspaceId, links.companyId ?? null, links.contactId ?? null, links.opportunityId ?? null],
  );
  const row = found.rows[0];
  return { companyId: row?.company_id ?? null, contactId: row?.contact_id ?? null, opportunityId: row?.opportunity_id ?? null };
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
