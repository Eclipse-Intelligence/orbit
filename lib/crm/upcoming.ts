import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { assertScope } from "@/lib/crm/scopes";
import { updateOccurrenceInDb, type RepeatScope } from "@/lib/crm/task-series";
import type { Provenance, Task, TaskWrite, UserActor } from "@/lib/crm/types";
import { undoTaskEventsInDb } from "@/lib/crm/undo";
import { dayKeyAt } from "@/lib/crm/working-days";
import type { UpcomingSeries } from "@/lib/task-blocks";
import { upcomingAfter, type OccurrenceChange, type RepeatEnds, type RepeatRule, type SeriesTiming } from "@/lib/task-repeat";

const SERIES_LIMIT = 400;

type ChangeJson = Omit<OccurrenceChange, "dueAt"> & { dueAt: string | null };

type OwnSeriesRow = {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  starts_on: string;
  at: string | null;
  rule: RepeatRule;
  ends: RepeatEnds;
  current_task_id: string | null;
  previous_task_id: string | null;
  current_occurs_on: string | null;
  current_due_at: Date | string | null;
  changes: ChangeJson[] | null;
};

function isoOrNull(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function changesOf(rows: ChangeJson[] | null): OccurrenceChange[] {
  return (rows ?? []).map((change) => ({ ...change, dueAt: isoOrNull(change.dueAt) }));
}

export async function listOwnSeriesInDb(db: Db, actor: UserActor, workspaceIds: string[]): Promise<UpcomingSeries[]> {
  const ids = [...new Set(workspaceIds.length > 0 ? workspaceIds : [actor.workspaceId])];
  const result = await db.query<OwnSeriesRow>(
    `select s.id, s.workspace_id, s.title, s.description, s.duration_minutes, s.starts_on::text as starts_on,
       to_char(s.at, 'HH24:MI') as at, s.rule, s.ends, s.current_task_id,
       case when s.current_task_id is null and s.split_from_id is not null then (select p.id from crm.series_split_previous(s.id) p) end as previous_task_id,
       t.occurs_on::text as current_occurs_on, t.due_at as current_due_at, rc.rows as changes
     from crm.task_series s
     left join crm.tasks t on t.id = s.current_task_id
     left join lateral (
       select coalesce(jsonb_agg(jsonb_build_object(
         'occursOn', c.occurs_on::text, 'skip', c.skip, 'dueAt', c.due_at, 'dueHasTime', c.due_has_time,
         'durationMinutes', c.duration_minutes, 'title', c.title, 'description', c.description
       ) order by c.occurs_on), '[]'::jsonb) as rows
       from (
         select * from crm.task_occurrence_changes c
         where c.series_id = s.id and (t.occurs_on is null or c.occurs_on > t.occurs_on)
         order by c.occurs_on
         limit 200
       ) c
     ) rc on true
     where s.owner_id = $1 and s.workspace_id = any($2::uuid[]) and s.ended_at is null and s.archived_at is null
     order by s.created_at, s.id
     limit ${SERIES_LIMIT}`,
    [actor.userId, ids],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    durationMinutes: row.duration_minutes,
    startsOn: row.starts_on,
    at: row.at,
    rule: row.rule,
    ends: row.ends,
    currentTaskId: row.current_task_id,
    anchorTaskId: row.current_task_id ?? row.previous_task_id,
    after: upcomingAfter(row.current_occurs_on, isoOrNull(row.current_due_at)),
    afterOccurs: row.current_occurs_on,
    changes: changesOf(row.changes),
  }));
}

export async function listOwnSeries(actor: UserActor, workspaceIds: string[]) {
  return withActor(actor, (db) => listOwnSeriesInDb(db, actor, workspaceIds));
}

type BookingSeriesRow = {
  starts_on: string;
  at: string | null;
  duration_minutes: number;
  rule: RepeatRule;
  ends: RepeatEnds;
  current_occurs_on: string | null;
  current_due_at: Date | string | null;
  changes: ChangeJson[] | null;
};

export async function loadBookingSeries(userId: string, from: string, to: string): Promise<SeriesTiming[]> {
  const result = await query<BookingSeriesRow>(
    "select starts_on::text as starts_on, at, duration_minutes, rule, ends, current_occurs_on::text as current_occurs_on, current_due_at, changes from private.booking_series($1, $2::date, $3::date)",
    [userId, from, to],
  );
  return result.rows.map((row) => ({
    startsOn: row.starts_on,
    at: row.at,
    rule: row.rule,
    ends: row.ends,
    durationMinutes: row.duration_minutes,
    after: upcomingAfter(row.current_occurs_on, isoOrNull(row.current_due_at)),
    afterOccurs: row.current_occurs_on,
    changes: changesOf(row.changes),
  }));
}

export const RESCOPE_FAILED = "Couldn't change the other dates. Try again.";
export const PAST_DAY = "Choose today or a later day.";

async function freshEvents(db: Db, taskId: string) {
  const result = await db.query<{ id: string }>(
    "select id from crm.audit_events where entity_id = $1 and created_at = now() and event_type not like '%.undone' order by created_at desc, id desc",
    [taskId],
  );
  return result.rows.map((row) => row.id);
}

export async function moveUpcoming(
  actor: UserActor,
  target: { seriesId: string; occursOn: string },
  input: TaskWrite,
  scope: RepeatScope,
  replaces: string[],
  provenance: Provenance,
): Promise<{ task: Task; undo: string[] }> {
  assertScope(actor.scopes, "tasks:write");
  if (input.dueAt && dayKeyAt(new Date(input.dueAt)) < dayKeyAt(new Date())) throw new CrmError("invalid_input", PAST_DAY, 400, { field: "dueAt" });
  return withActor(actor, async (db) => {
    if (replaces.length > 0) {
      const event = await db.query<{ entity_id: string }>(
        "select entity_id from crm.audit_events where id = $1 and workspace_id = $2 and entity_type = 'task'",
        [replaces[0], actor.workspaceId],
      );
      const taskId = event.rows[0]?.entity_id;
      if (!taskId) throw new CrmError("cannot_undo", RESCOPE_FAILED, 409);
      await undoTaskEventsInDb(db, actor, taskId, replaces, { operation: "undo_change", source: provenance.source });
    }
    const task = await updateOccurrenceInDb(db, actor, target, input, scope, provenance);
    return { task, undo: await freshEvents(db, task.id) };
  });
}
