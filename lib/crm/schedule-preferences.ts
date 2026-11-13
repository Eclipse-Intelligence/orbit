import { withActor } from "@/lib/crm/context";
import { DEFAULT_PLAN_PREFERENCES, planGroup, type PlanPreferences } from "@/lib/crm/plan-tasks";
import type { UserActor } from "@/lib/crm/types";
import { workspaceActors } from "@/lib/crm/workspaces";
import type { Db } from "@/lib/db/pool";
import {
  addSignal,
  emptySpread,
  isLearned,
  LEARN_DAYS,
  LEARNED_KINDS,
  learnedView,
  learnedWindow,
  readSpread,
  slotWeights,
  type LearnedKindView,
  type LearnedSpread,
} from "@/lib/learned-times";
import { appTimeZone } from "@/lib/time";
import { clockText } from "@/lib/working-hours";

export const LEARNED_CACHE_MS = 10 * 60_000;
export const PLACED_OPERATIONS = ["update_task", "drag_task", "create_task"] as const;

const DAY_MS = 86_400_000;
const SIGNAL_LIMIT = 5000;

type PreferenceRow = { spread: unknown; learned_at: Date | null; reset_at: Date | null };
type AuditRow = { entity_id: string; operation: string; due_at: string | null; title: string | null; completed_at: Date | null };
type MeetingRow = { starts_at: Date };

export type LearnedTimes = { kinds: LearnedKindView[]; resetAt: string | null };

async function preferenceRow(db: Db, userId: string) {
  return (
    await db.query<PreferenceRow>("select spread, learned_at, reset_at from crm.schedule_preferences where user_id = $1", [userId])
  ).rows[0];
}

export function learningSince(now: number, resetAt: Date | string | null | undefined) {
  const window = now - LEARN_DAYS * DAY_MS;
  const reset = resetAt ? new Date(resetAt).getTime() : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(window, reset));
}

export async function collectSpreadInDb(db: Db, userId: string, workspaceIds: string[], now: number, since: Date, timeZone = appTimeZone()) {
  const spread = emptySpread();
  for (const workspaceId of [...new Set(workspaceIds)]) {
    const rows = await db.query<AuditRow>(
      `select e.entity_id, e.operation, e.changes -> 'after' ->> 'dueAt' as due_at,
              coalesce(e.changes -> 'after' ->> 'title', t.title) as title, t.completed_at
       from crm.audit_events e
       left join crm.tasks t on t.id = e.entity_id
       where e.workspace_id = $1
         and e.actor_user_id = $2
         and e.created_at >= $3
         and e.created_at <= $4
         and e.actor_type = 'user'
         and e.entity_type = 'task'
         and e.source = 'web'
         and (
           (e.operation = any($5::text[])
             and e.changes -> 'after' ->> 'dueHasTime' = 'true'
             and e.changes -> 'after' ->> 'dueAt' is not null
             and coalesce(e.changes -> 'after' ->> 'scheduledBy', 'person') = 'person')
           or (e.operation = 'complete_task' and e.event_type = 'task.completed')
         )
       order by e.created_at desc
       limit ${SIGNAL_LIMIT}`,
      [workspaceId, userId, since.toISOString(), new Date(now).toISOString(), [...PLACED_OPERATIONS]],
    );
    const placed = new Set<string>();
    const ticked = new Set<string>();
    for (const row of rows.rows) {
      if (!row.title) continue;
      const kind = planGroup(row.title);
      if (row.operation === "complete_task") {
        if (ticked.has(row.entity_id) || !row.completed_at) continue;
        const completedAt = new Date(row.completed_at);
        if (completedAt < since || completedAt.getTime() > now) continue;
        ticked.add(row.entity_id);
        addSignal(spread, kind, "ticked", completedAt, timeZone);
        continue;
      }
      if (placed.has(row.entity_id) || !row.due_at) continue;
      placed.add(row.entity_id);
      addSignal(spread, kind, "placed", row.due_at, timeZone);
    }
  }
  const meetings = await db.query<MeetingRow>(
    `select e.starts_at
     from crm.calendar_events e
     left join crm.calendar_accounts a on a.id = e.account_id
     left join crm.mailbox_connections c on c.id = e.connection_id
     where e.user_id = $1
       and e.starts_at >= $2
       and e.starts_at <= $3
       and not e.is_cancelled
       and not e.is_all_day
       and cardinality(e.contact_ids) > 0
       and coalesce(lower(e.response_status), '') <> 'declined'
       and (
         e.created_by_orbit
         or e.organizer is null
         or lower(e.organizer ->> 'email') in (lower(a.email), lower(c.email))
       )
     order by e.starts_at desc
     limit ${SIGNAL_LIMIT}`,
    [userId, since.toISOString(), new Date(now).toISOString()],
  );
  for (const row of meetings.rows) addSignal(spread, "call", "booked", row.starts_at, timeZone);
  return spread;
}

export function preferencesFromSpread(spread: LearnedSpread): PlanPreferences {
  const preferences: PlanPreferences = { ...DEFAULT_PLAN_PREFERENCES };
  for (const kind of LEARNED_KINDS) {
    const window = isLearned(spread[kind]) ? learnedWindow(spread[kind]) : null;
    if (window) preferences[kind] = { from: window.from, to: window.to, learned: true, slots: slotWeights(spread[kind]) };
  }
  return preferences;
}

export async function learnedSpreadInDb(
  db: Db,
  actor: UserActor,
  actors: UserActor[],
  now = Date.now(),
  options: { fresh?: boolean; timeZone?: string } = {},
): Promise<LearnedSpread> {
  const row = await preferenceRow(db, actor.userId);
  const learnedAt = row?.learned_at ? new Date(row.learned_at).getTime() : null;
  if (!options.fresh && row?.spread && learnedAt !== null && learnedAt <= now && now - learnedAt < LEARNED_CACHE_MS) {
    const cached = readSpread(row.spread);
    if (cached) return cached;
  }
  const workspaces = [actor.workspaceId, ...actors.map((item) => item.workspaceId)];
  const spread = await collectSpreadInDb(db, actor.userId, workspaces, now, learningSince(now, row?.reset_at), options.timeZone);
  await db.query(
    `insert into crm.schedule_preferences (user_id, spread, learned_at)
     values ($1, $2::jsonb, $3)
     on conflict (user_id) do update set spread = excluded.spread, learned_at = excluded.learned_at`,
    [actor.userId, JSON.stringify(spread), new Date(now).toISOString()],
  );
  return spread;
}

export async function planPreferencesInDb(db: Db, actor: UserActor, actors: UserActor[], now = Date.now()): Promise<PlanPreferences> {
  return preferencesFromSpread(await learnedSpreadInDb(db, actor, actors, now));
}

export type PreferredTime = { from: string; to: string; learned: boolean } | null;

export async function getPreferredTimes(actor: UserActor, now = Date.now()): Promise<Record<"call" | "email" | "other", PreferredTime>> {
  const actors = await workspaceActors(actor).catch(() => [actor]);
  const preferences = await withActor(actor, (db) => planPreferencesInDb(db, actor, actors, now));
  const shown = (kind: "call" | "email" | "other"): PreferredTime => {
    const preference = preferences[kind];
    return preference ? { from: clockText(preference.from), to: clockText(preference.to), learned: preference.learned } : null;
  };
  return { call: shown("call"), email: shown("email"), other: shown("other") };
}

export async function getLearnedTimes(actor: UserActor, now = Date.now()): Promise<LearnedTimes> {
  const actors = await workspaceActors(actor).catch(() => [actor]);
  return withActor(actor, async (db) => {
    const spread = await learnedSpreadInDb(db, actor, actors, now, { fresh: true });
    const row = await preferenceRow(db, actor.userId);
    return {
      kinds: LEARNED_KINDS.map((kind) => learnedView(kind, spread[kind])),
      resetAt: row?.reset_at ? new Date(row.reset_at).toISOString() : null,
    };
  });
}

export async function resetLearnedTimes(actor: UserActor, now = Date.now()) {
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.schedule_preferences (user_id, reset_at, spread, learned_at)
       values ($1, $2, null, null)
       on conflict (user_id) do update set reset_at = excluded.reset_at, spread = null, learned_at = null`,
      [actor.userId, new Date(now).toISOString()],
    ),
  );
}
