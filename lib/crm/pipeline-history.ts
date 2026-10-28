import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { opportunityHref } from "@/lib/crm/hrefs";
import { iso, isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, BoardKind, OpportunityStatus } from "@/lib/crm/types";
import { appTimeZone, parseDateTime } from "@/lib/time";

export const STALLED_DAYS = 7;
const REPORT_DAYS = 90;
const DAY_MS = 86_400_000;

type Snapshot = { stageId?: string | null; stageName?: string | null; status?: OpportunityStatus | null };
type ChangePayload = { before?: Snapshot; after?: Snapshot };

export type StageActor = { type: "user" | "agent" | "system"; userId: string | null; agentId: string | null; name: string | null };

export type StageStay = {
  stageId: string | null;
  stageName: string | null;
  fromStageId: string | null;
  fromStageName: string | null;
  status: OpportunityStatus | null;
  enteredAt: string;
  leftAt: string | null;
  daysInStage: number;
  by: StageActor;
};

export type StageHistory = {
  opportunityId: string;
  name: string;
  pipelineId: string | null;
  pipelineName: string | null;
  pipelineKind: BoardKind | null;
  stageId: string | null;
  stageName: string | null;
  status: OpportunityStatus;
  stays: StageStay[];
};

export type DaysStat = { count: number; median: number | null; average: number | null };

export type StageReport = {
  stageId: string;
  name: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  inStageNow: number;
  entered: number;
  daysInStage: { current: DaysStat; past: DaysStat; all: DaysStat } | null;
  outcomes: { forward: number; won: number; lost: number; back: number; stalled: number };
  dealsEntered: number;
  reachedWon: number;
  conversionToWon: number | null;
};

export type PipelineReport = {
  pipeline: { id: string; name: string; kind: BoardKind };
  since: string;
  until: string;
  stalledDays: number;
  won: number;
  lost: number;
  winRate: number | null;
  stages: StageReport[];
};

export type StalledDeal = {
  opportunityId: string;
  name: string;
  href: string;
  companyId: string;
  companyName: string | null;
  pipelineId: string;
  pipelineName: string;
  pipelineKind: BoardKind;
  stageId: string;
  stageName: string;
  value: string | null;
  currency: string;
  ownerId: string | null;
  ownerName: string | null;
  enteredStageAt: string;
  daysInStage: number;
  lastActivityAt: string | null;
  lastActivityType: string | null;
  daysQuiet: number;
  reason: string;
};

export type StalledOptions = {
  days?: number;
  stageIds?: string[] | null;
  pipelineId?: string | null;
  forMember?: string | null;
  limit?: number;
  now?: Date;
};

type ChangeRow = {
  entity_id: string;
  changes: ChangePayload;
  created_at: Date;
  actor_type: StageActor["type"];
  actor_user_id: string | null;
  actor_agent_id: string | null;
  user_name: string | null;
  agent_name: string | null;
};

type StageRow = { id: string; name: string; position: number; is_won: boolean; is_lost: boolean };

type Stay = Omit<StageStay, "enteredAt" | "leftAt" | "daysInStage"> & { enteredAt: Date; leftAt: Date | null };

function days(from: Date, to: Date) {
  return Math.round(((to.getTime() - from.getTime()) / DAY_MS) * 10) / 10;
}

function wholeDays(from: Date, to: Date) {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

function stat(values: number[]): DaysStat {
  if (!values.length) return { count: 0, median: null, average: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const average = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { count: sorted.length, median: Math.round(median * 10) / 10, average: Math.round(average * 10) / 10 };
}

function rate(part: number, whole: number) {
  return whole ? Math.round((part / whole) * 100) / 100 : null;
}

function parseSince(value: Date | string | null | undefined, now: Date) {
  if (value === undefined || value === null || value === "") return new Date(now.getTime() - REPORT_DAYS * DAY_MS);
  const date = value instanceof Date ? value : parseDateTime(value, appTimeZone());
  if (!date || Number.isNaN(date.getTime())) throw new CrmError("invalid_input", "Use a date like 2026-09-01.", 400, { field: "since" });
  return date;
}

function changeActor(row: Pick<ChangeRow, "actor_type" | "actor_user_id" | "actor_agent_id" | "user_name" | "agent_name">): StageActor {
  return {
    type: row.actor_type,
    userId: row.actor_user_id,
    agentId: row.actor_agent_id,
    name: row.actor_type === "agent" ? row.agent_name : row.actor_type === "user" ? row.user_name : "Orbit",
  };
}

async function loadChanges(db: Db, workspaceId: string, ids: string[]) {
  if (!ids.length) return new Map<string, ChangeRow[]>();
  const result = await db.query<ChangeRow>(
    `select e.entity_id, e.changes, e.created_at, e.actor_type, e.actor_user_id, e.actor_agent_id,
       coalesce(nullif(p.full_name, ''), p.email) as user_name, a.name as agent_name
     from crm.audit_events e
     left join crm.profiles p on p.id = e.actor_user_id
     left join crm.agents a on a.id = e.actor_agent_id
     where e.workspace_id = $1 and e.entity_type = 'opportunity' and e.event_type = 'opportunity.stage_changed'
       and e.entity_id = any($2::uuid[])
     order by e.entity_id, e.created_at, e.id`,
    [workspaceId, ids],
  );
  const byDeal = new Map<string, ChangeRow[]>();
  for (const row of result.rows) {
    const list = byDeal.get(row.entity_id) ?? [];
    list.push(row);
    byDeal.set(row.entity_id, list);
  }
  return byDeal;
}

function buildStays(
  deal: { created_at: Date; stage_id: string | null; stage_name: string | null; status: OpportunityStatus },
  creator: StageActor,
  changes: ChangeRow[],
): Stay[] {
  const first = changes[0]?.changes.before;
  const stays: Stay[] = [
    {
      stageId: first ? (first.stageId ?? null) : deal.stage_id,
      stageName: first ? (first.stageName ?? null) : deal.stage_name,
      fromStageId: null,
      fromStageName: null,
      status: first ? (first.status ?? null) : deal.status,
      enteredAt: deal.created_at,
      leftAt: null,
      by: creator,
    },
  ];
  for (const change of changes) {
    const current = stays[stays.length - 1];
    const after = change.changes.after ?? {};
    const to = after.stageId ?? null;
    if (to === current.stageId) {
      current.status = after.status ?? current.status;
      continue;
    }
    current.leftAt = change.created_at;
    stays.push({
      stageId: to,
      stageName: after.stageName ?? null,
      fromStageId: current.stageId,
      fromStageName: current.stageName,
      status: after.status ?? null,
      enteredAt: change.created_at,
      leftAt: null,
      by: changeActor(change),
    });
  }
  return stays;
}

export async function stageHistory(actor: Actor, opportunityId: string, now = new Date()): Promise<StageHistory> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(opportunityId)) throw new CrmError("not_found", "Opportunity not found.", 404);
  return withActor(actor, async (db) => {
    const deal = (
      await db.query<{
        id: string;
        name: string;
        pipeline_id: string | null;
        pipeline_name: string | null;
        pipeline_kind: BoardKind | null;
        stage_id: string | null;
        stage_name: string | null;
        status: OpportunityStatus;
        created_at: Date;
        created_by_user_id: string | null;
        created_by_agent_id: string | null;
        creator_user: string | null;
        creator_agent: string | null;
      }>(
        `select o.id, o.name, o.pipeline_id, pl.name as pipeline_name, pl.kind as pipeline_kind, o.stage_id, s.name as stage_name,
           o.status, o.created_at, o.created_by_user_id, o.created_by_agent_id,
           coalesce(nullif(p.full_name, ''), p.email) as creator_user, a.name as creator_agent
         from crm.opportunities o
         left join crm.pipelines pl on pl.id = o.pipeline_id
         left join crm.pipeline_stages s on s.id = o.stage_id
         left join crm.profiles p on p.id = o.created_by_user_id
         left join crm.agents a on a.id = o.created_by_agent_id
         where o.id = $1 and o.workspace_id = $2`,
        [opportunityId, actor.workspaceId],
      )
    ).rows[0];
    if (!deal) throw new CrmError("not_found", "Opportunity not found.", 404);
    const names = new Map<string, string>();
    if (deal.pipeline_id) {
      const stages = await db.query<{ id: string; name: string }>("select id, name from crm.pipeline_stages where pipeline_id = $1", [deal.pipeline_id]);
      for (const stage of stages.rows) names.set(stage.id, stage.name);
    }
    const changes = (await loadChanges(db, actor.workspaceId, [deal.id])).get(deal.id) ?? [];
    const creator: StageActor = deal.created_by_agent_id
      ? { type: "agent", userId: null, agentId: deal.created_by_agent_id, name: deal.creator_agent }
      : deal.created_by_user_id
        ? { type: "user", userId: deal.created_by_user_id, agentId: null, name: deal.creator_user }
        : { type: "system", userId: null, agentId: null, name: "Orbit" };
    const named = (id: string | null, fallback: string | null) => (id ? (names.get(id) ?? fallback) : fallback);
    return {
      opportunityId: deal.id,
      name: deal.name,
      pipelineId: deal.pipeline_id,
      pipelineName: deal.pipeline_name,
      pipelineKind: deal.pipeline_kind,
      stageId: deal.stage_id,
      stageName: deal.stage_name,
      status: deal.status,
      stays: buildStays(deal, creator, changes).map((stay) => ({
        ...stay,
        stageName: named(stay.stageId, stay.stageName),
        fromStageName: named(stay.fromStageId, stay.fromStageName),
        enteredAt: stay.enteredAt.toISOString(),
        leftAt: stay.leftAt?.toISOString() ?? null,
        daysInStage: days(stay.enteredAt, stay.leftAt ?? now),
      })),
    };
  });
}

type StalledRow = {
  id: string;
  name: string;
  company_id: string;
  company_name: string | null;
  pipeline_id: string;
  pipeline_name: string;
  pipeline_kind: BoardKind;
  stage_id: string;
  stage_name: string;
  value: string | null;
  currency: string;
  owner_id: string | null;
  owner_name: string | null;
  entered_at: Date;
  last_activity_at: Date | null;
  last_activity_type: string | null;
};

const ACTIVITY_WORDS: Record<string, string> = { email: "email", call: "call", meeting: "meeting", note: "note", linkedin: "LinkedIn message" };

function stalledReason(row: StalledRow, now: Date) {
  const inStage = wholeDays(row.entered_at, now);
  if (!row.last_activity_at || row.last_activity_at < row.entered_at) {
    return `No activity or email since moving to ${row.stage_name} ${inStage} days ago, and no task due.`;
  }
  const word = ACTIVITY_WORDS[row.last_activity_type ?? ""] ?? "activity";
  return `Last ${word} ${wholeDays(row.last_activity_at, now)} days ago, ${inStage} days in ${row.stage_name}, and no task due.`;
}

export async function stalledDealsInDb(db: Db, actor: Actor, options: StalledOptions = {}): Promise<StalledDeal[]> {
  const now = options.now ?? new Date();
  const quietDays = Math.min(3650, Math.max(1, Math.trunc(options.days ?? STALLED_DAYS)));
  const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 50)));
  if (options.pipelineId && !isUuid(options.pipelineId)) throw new CrmError("not_found", "Board not found.", 404);
  const stageIds = options.stageIds?.length ? options.stageIds.filter(isUuid) : null;
  if (options.stageIds?.length && !stageIds?.length) return [];
  const result = await db.query<StalledRow>(
    `with deals as (
       select o.id, o.name, o.company_id, co.name as company_name, o.primary_contact_id, o.pipeline_id, pl.name as pipeline_name,
         pl.kind as pipeline_kind, o.stage_id, s.name as stage_name, o.value::text as value, o.currency, o.owner_id,
         coalesce(nullif(pr.full_name, ''), pr.email) as owner_name,
         coalesce((
           select e.created_at from crm.audit_events e
           where e.workspace_id = o.workspace_id and e.entity_type = 'opportunity' and e.event_type = 'opportunity.stage_changed'
             and e.entity_id = o.id and e.changes->'after'->>'stageId' = o.stage_id::text
           order by e.created_at desc limit 1
         ), o.created_at) as entered_at
       from crm.opportunities o
       join crm.companies co on co.id = o.company_id
       join crm.pipelines pl on pl.id = o.pipeline_id
       join crm.pipeline_stages s on s.id = o.stage_id
       left join crm.profiles pr on pr.id = o.owner_id
       where o.workspace_id = $1 and o.status = 'open' and o.archived_at is null and pl.archived_at is null
         and not s.is_won and not s.is_lost
         and (case when $2::uuid is null then pl.kind = 'sales' else pl.id = $2::uuid end)
         and ($3::uuid[] is null or o.stage_id = any($3::uuid[]))
         and ($4::uuid is null or o.owner_id = $4::uuid or o.owner_id is null)
     )
     select d.id, d.name, d.company_id, d.company_name, d.pipeline_id, d.pipeline_name, d.pipeline_kind, d.stage_id, d.stage_name,
       d.value, d.currency, d.owner_id, d.owner_name, d.entered_at, last.occurred_at as last_activity_at, last.type as last_activity_type
     from deals d
     left join lateral (
       select touch.occurred_at, touch.type from (
         (select a.occurred_at, a.type from crm.activities a where a.opportunity_id = d.id order by a.occurred_at desc limit 1)
         union all
         (select a.occurred_at, a.type from crm.activities a where a.company_id = d.company_id order by a.occurred_at desc limit 1)
         union all
         (select a.occurred_at, a.type from crm.activities a
          where d.primary_contact_id is not null and a.contact_id = d.primary_contact_id order by a.occurred_at desc limit 1)
       ) touch
       order by touch.occurred_at desc limit 1
     ) last on true
     where greatest(d.entered_at, coalesce(last.occurred_at, d.entered_at)) <= $5::timestamptz - make_interval(days => $6::int)
       and not exists (
         select 1 from crm.tasks t
         where t.workspace_id = $1 and t.completed_at is null and t.archived_at is null and t.due_at is not null
           and t.due_at >= $5::timestamptz - make_interval(days => $6::int)
           and (t.opportunity_id = d.id or t.company_id = d.company_id or (d.primary_contact_id is not null and t.contact_id = d.primary_contact_id))
       )
     order by greatest(d.entered_at, coalesce(last.occurred_at, d.entered_at)) asc, d.id
     limit $7`,
    [actor.workspaceId, options.pipelineId ?? null, stageIds, options.forMember ?? null, now, quietDays, limit],
  );
  return result.rows.map((row) => {
    const quietSince = row.last_activity_at && row.last_activity_at > row.entered_at ? row.last_activity_at : row.entered_at;
    return {
      opportunityId: row.id,
      name: row.name,
      href: opportunityHref({ id: row.id, name: row.name, companyName: row.company_name, pipelineId: row.pipeline_id, pipelineKind: row.pipeline_kind }),
      companyId: row.company_id,
      companyName: row.company_name,
      pipelineId: row.pipeline_id,
      pipelineName: row.pipeline_name,
      pipelineKind: row.pipeline_kind,
      stageId: row.stage_id,
      stageName: row.stage_name,
      value: row.value,
      currency: row.currency,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      enteredStageAt: row.entered_at.toISOString(),
      daysInStage: wholeDays(row.entered_at, now),
      lastActivityAt: iso(row.last_activity_at),
      lastActivityType: row.last_activity_type,
      daysQuiet: wholeDays(quietSince, now),
      reason: stalledReason(row, now),
    };
  });
}

export async function stalledDeals(actor: Actor, options: StalledOptions = {}) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, (db) => stalledDealsInDb(db, actor, options));
}

export async function pipelineReport(
  actor: Actor,
  options: { pipelineId?: string | null; since?: Date | string | null; now?: Date; stalledDays?: number } = {},
): Promise<PipelineReport> {
  assertScope(actor.scopes, "crm:read");
  const now = options.now ?? new Date();
  const since = parseSince(options.since, now);
  const stalledDays = Math.min(3650, Math.max(1, Math.trunc(options.stalledDays ?? STALLED_DAYS)));
  if (options.pipelineId && !isUuid(options.pipelineId)) throw new CrmError("not_found", "Board not found.", 404);
  return withActor(actor, async (db) => {
    const pipeline = (
      await db.query<{ id: string; name: string; kind: BoardKind }>(
        `select id, name, kind from crm.pipelines
         where workspace_id = $1 and archived_at is null and (case when $2::uuid is null then is_default else id = $2::uuid end)
         limit 1`,
        [actor.workspaceId, options.pipelineId ?? null],
      )
    ).rows[0];
    if (!pipeline) {
      if (options.pipelineId) throw new CrmError("not_found", "Board not found.", 404);
      throw new CrmError("invalid_input", "This workspace has no pipeline.", 400);
    }
    const stageRows = (
      await db.query<StageRow>("select id, name, position, is_won, is_lost from crm.pipeline_stages where pipeline_id = $1 order by position", [pipeline.id])
    ).rows;
    const stages = new Map(stageRows.map((stage) => [stage.id, stage]));
    const counts = await db.query<{ stage_id: string; total: number }>(
      `select stage_id, count(*)::int as total from crm.opportunities
       where workspace_id = $1 and pipeline_id = $2 and archived_at is null group by stage_id`,
      [actor.workspaceId, pipeline.id],
    );
    const inStageNow = new Map(counts.rows.map((row) => [row.stage_id, row.total]));
    const deals = (
      await db.query<{ id: string; stage_id: string | null; stage_name: string | null; status: OpportunityStatus; created_at: Date }>(
        `select o.id, o.stage_id, s.name as stage_name, o.status, o.created_at
         from crm.opportunities o left join crm.pipeline_stages s on s.id = o.stage_id
         where o.workspace_id = $1 and o.pipeline_id = $2 and o.archived_at is null and (o.status = 'open' or o.updated_at >= $3)`,
        [actor.workspaceId, pipeline.id, since],
      )
    ).rows;
    const changes = await loadChanges(db, actor.workspaceId, deals.map((deal) => deal.id));
    const system: StageActor = { type: "system", userId: null, agentId: null, name: null };
    const staysByDeal = deals.map((deal) => buildStays(deal, system, changes.get(deal.id) ?? []).filter((stay) => stay.enteredAt <= now));
    const stalled = await stalledDealsInDb(db, actor, { days: stalledDays, pipelineId: pipeline.id, now, limit: 1000 });
    const stalledByStage = new Map<string, number>();
    for (const deal of stalled) stalledByStage.set(deal.stageId, (stalledByStage.get(deal.stageId) ?? 0) + 1);

    type Tally = { entered: number; current: number[]; past: number[]; forward: number; won: number; lost: number; back: number; deals: Map<string, Date>; reached: number };
    const tallies = new Map<string, Tally>(
      stageRows.map((stage) => [stage.id, { entered: 0, current: [], past: [], forward: 0, won: 0, lost: 0, back: 0, deals: new Map(), reached: 0 }]),
    );
    let won = 0;
    let lost = 0;
    deals.forEach((deal, index) => {
      const stays = staysByDeal[index];
      const final = stays[stays.length - 1];
      const finalStage = final?.stageId ? stages.get(final.stageId) : undefined;
      const closedInPeriod = Boolean(finalStage && final.enteredAt >= since && (finalStage.is_won || finalStage.is_lost));
      if (closedInPeriod && finalStage?.is_won) won += 1;
      if (closedInPeriod && finalStage?.is_lost) lost += 1;
      stays.forEach((stay, position) => {
        const stage = stay.stageId ? stages.get(stay.stageId) : undefined;
        const tally = stay.stageId ? tallies.get(stay.stageId) : undefined;
        if (!stage || !tally) return;
        if (stay.enteredAt >= since) {
          tally.entered += 1;
          if (!tally.deals.has(deal.id)) tally.deals.set(deal.id, stay.enteredAt);
        }
        const closed = stage.is_won || stage.is_lost;
        if (!closed && !stay.leftAt) tally.current.push(days(stay.enteredAt, now));
        if (!closed && stay.leftAt && stay.leftAt >= since) tally.past.push(days(stay.enteredAt, stay.leftAt));
        const next = stays[position + 1];
        const nextStage = next?.stageId ? stages.get(next.stageId) : undefined;
        if (!next || !stay.leftAt || stay.leftAt < since) return;
        if (!nextStage) tally.forward += 1;
        else if (nextStage.is_won) tally.won += 1;
        else if (nextStage.is_lost) tally.lost += 1;
        else if (nextStage.position > stage.position) tally.forward += 1;
        else tally.back += 1;
      });
      if (finalStage?.is_won && final) {
        for (const tally of tallies.values()) {
          const entered = tally.deals.get(deal.id);
          if (entered && entered < final.enteredAt) tally.reached += 1;
        }
      }
    });

    return {
      pipeline,
      since: since.toISOString(),
      until: now.toISOString(),
      stalledDays,
      won,
      lost,
      winRate: rate(won, won + lost),
      stages: stageRows.map((stage) => {
        const tally = tallies.get(stage.id)!;
        const closed = stage.is_won || stage.is_lost;
        return {
          stageId: stage.id,
          name: stage.name,
          position: stage.position,
          isWon: stage.is_won,
          isLost: stage.is_lost,
          inStageNow: inStageNow.get(stage.id) ?? 0,
          entered: tally.entered,
          daysInStage: closed ? null : { current: stat(tally.current), past: stat(tally.past), all: stat([...tally.current, ...tally.past]) },
          outcomes: { forward: tally.forward, won: tally.won, lost: tally.lost, back: tally.back, stalled: stalledByStage.get(stage.id) ?? 0 },
          dealsEntered: tally.deals.size,
          reachedWon: closed ? 0 : tally.reached,
          conversionToWon: closed ? null : rate(tally.reached, tally.deals.size),
        };
      }),
    };
  });
}
