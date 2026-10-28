import { withActor } from "@/lib/crm/context";
import type { Db } from "@/lib/db/pool";
import { iso, isUuid } from "@/lib/crm/mutate";
import { readRelationshipOverrides } from "@/lib/crm/relationship-override";
import { EMPTY_SIGNALS, scoreRelationship, withOverride, type Relationship, type RelationshipSignals, type Tone } from "@/lib/crm/relationship-score";
import type { Actor } from "@/lib/crm/types";

export type RelationshipTarget = "company" | "contact";

const NOISE = "^(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|undeliverable|delivery (status notification|has failed)|mail delivery (failed|subsystem)|returned mail)";

const INBOUND = `(a.metadata->>'direction' = 'inbound' or (a.metadata->>'direction' is null and a.metadata ? 'from' and a.metadata->>'source' = 'microsoft'))`;

type SignalRow = {
  id: string;
  inbound_count: number;
  last_inbound: Date | null;
  outbound_count: number;
  last_outbound: Date | null;
  meeting_count: number;
  last_meeting: Date | null;
  unanswered: number;
  first_unanswered: Date | null;
  recent: number;
};

async function relationshipSignalsInDb(db: Db, workspaceId: string, target: RelationshipTarget, ids: string[], now = Date.now()) {
  const wanted = [...new Set(ids.filter(isUuid))];
  const signals = new Map<string, RelationshipSignals>();
  if (wanted.length === 0) return signals;
  const column = target === "company" ? "company_id" : "contact_id";
  const at = new Date(now).toISOString();
  const rows = await db.query<SignalRow>(
    `with acts as (
       select a.${column} as id, a.occurred_at,
         coalesce(a.metadata->>'internetMessageId', coalesce(a.title, '') || '|' || date_trunc('minute', a.occurred_at)::text) as message,
         case
           when a.type = 'email' and ${INBOUND} then 'in'
           when a.type = 'email' then 'out'
           else 'meet'
         end as kind
       from crm.activities a
       left join crm.activity_tones t on t.activity_id = a.id
       where a.workspace_id = $1 and a.${column} = any($2::uuid[]) and a.occurred_at <= $3::timestamptz
         and a.archived_at is null
         and a.type in ('email', 'meeting', 'call')
         and coalesce(a.title, '') !~* $4
         and not coalesce(t.automatic, false)
     ),
     theirs as (
       select id, max(occurred_at) filter (where kind in ('in', 'meet')) as last_theirs from acts group by id
     )
     select acts.id,
       count(*) filter (where kind = 'in')::int as inbound_count,
       max(occurred_at) filter (where kind = 'in') as last_inbound,
       count(distinct message) filter (where kind = 'out')::int as outbound_count,
       max(occurred_at) filter (where kind = 'out') as last_outbound,
       count(*) filter (where kind = 'meet')::int as meeting_count,
       max(occurred_at) filter (where kind = 'meet') as last_meeting,
       count(distinct message) filter (where kind = 'out' and occurred_at > coalesce(theirs.last_theirs, '-infinity'::timestamptz))::int as unanswered,
       min(occurred_at) filter (where kind = 'out' and occurred_at > coalesce(theirs.last_theirs, '-infinity'::timestamptz)) as first_unanswered,
       count(*) filter (where kind in ('in', 'meet') and occurred_at > $3::timestamptz - interval '90 days')::int as recent
     from acts join theirs on theirs.id = acts.id
     group by acts.id`,
    [workspaceId, wanted, at, NOISE],
  );
  const tones = await db.query<{ id: string; tone: Tone }>(
    `select distinct on (id) id, tone from (
       select a.${column} as id, t.tone, a.occurred_at
       from crm.activity_tones t join crm.activities a on a.id = t.activity_id
       where a.workspace_id = $1 and a.${column} = any($2::uuid[]) and not t.automatic and a.archived_at is null
         and a.occurred_at between $3::timestamptz - interval '120 days' and $3::timestamptz
       union all
       select a.${column}, case i.sentiment when 'healthy' then 'positive' when 'at_risk' then 'negative' else 'neutral' end, a.occurred_at
       from crm.call_insights i join crm.activities a on a.id = i.activity_id
       where a.workspace_id = $1 and a.${column} = any($2::uuid[]) and i.sentiment is not null and a.archived_at is null
         and a.occurred_at between $3::timestamptz - interval '120 days' and $3::timestamptz
     ) found
     order by id, occurred_at desc`,
    [workspaceId, wanted, at],
  );
  const toneOf = new Map(tones.rows.map((row) => [row.id, row.tone]));
  for (const row of rows.rows) {
    signals.set(row.id, {
      inboundCount: row.inbound_count,
      lastInboundAt: iso(row.last_inbound),
      outboundCount: row.outbound_count,
      lastOutboundAt: iso(row.last_outbound),
      meetingCount: row.meeting_count,
      lastMeetingAt: iso(row.last_meeting),
      unanswered: row.unanswered,
      firstUnansweredAt: iso(row.first_unanswered),
      recentEngagements: row.recent,
      tone: toneOf.get(row.id) ?? null,
    });
  }
  return signals;
}

export async function relationshipsInDb(db: Db, workspaceId: string, target: RelationshipTarget, ids: string[], now = Date.now()) {
  const signals = await relationshipSignalsInDb(db, workspaceId, target, ids, now);
  const overrides = await readRelationshipOverrides(db, workspaceId, target, ids);
  const result: Record<string, Relationship> = {};
  for (const id of ids) result[id] = withOverride(scoreRelationship(signals.get(id) ?? EMPTY_SIGNALS, now), overrides.get(id));
  return result;
}

export async function relationshipsFor(actor: Actor, target: RelationshipTarget, ids: string[], now = Date.now()) {
  if (ids.length === 0) return {};
  return withActor(actor, (db) => relationshipsInDb(db, actor.workspaceId, target, ids, now));
}
