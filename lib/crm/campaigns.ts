import { positiveCategory } from "@/lib/campaigns/format";
import { campaignProvider } from "@/lib/campaigns/providers";
import { addRefusal, readCampaignVariables } from "@/lib/campaigns/prospects";
import {
  CAMPAIGN_CHANNELS,
  EVENT_KINDS,
  type CampaignChannel,
  type CampaignDetail,
  type CampaignOption,
  type CampaignEventKind,
  type CampaignProviderId,
  type CampaignStats,
  type CampaignStatus,
  type CampaignSummary,
  type DayStats,
  type Mailbox,
  type ProspectFilter,
  type ProspectPage,
  type ProspectState,
  type LinkedinStage,
  type ProviderDay,
  type SenderCapacity,
  type SequenceStep,
  type StepStats,
  type AutoAdd,
} from "@/lib/campaigns/types";
import { editContactTagsInDb, upsertContactInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { timeLeft } from "@/lib/crm/conversations";
import { CrmError, isPgError, notFound } from "@/lib/crm/errors";
import { isUuid, lockNamespace } from "@/lib/crm/mutate";
import { canonicalDomain, normalizeTag } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { query, type Db } from "@/lib/db/pool";
import { ServiceBusy } from "@/lib/workflows/limits";

export const PROSPECT_PAGE_SIZE = 100;
const CHART_DAYS = 30;
const IMPORT_BATCH = 25;
const NAME_MAX = 80;
const TITLE_MAX = 120;

type CampaignRow = {
  id: string;
  provider: CampaignProviderId;
  channel: CampaignSummary["channel"];
  external_id: string;
  name: string;
  status: CampaignStatus;
  stats: CampaignStats;
  synced_at: Date | null;
  backfilled: boolean;
  prospects: number;
};

function summary(row: CampaignRow): CampaignSummary {
  return {
    id: row.id,
    provider: row.provider,
    channel: row.channel,
    externalId: row.external_id,
    name: row.name,
    status: row.status,
    stats: row.stats ?? {},
    prospects: row.prospects,
    syncedAt: row.synced_at?.toISOString() ?? null,
    backfilled: row.backfilled,
  };
}

const IMPORTABLE_SQL = `p.contact_id is null and p.import_error is null and (p.email is not null or p.linkedin is not null)
  and not exists (
    select 1 from crm.campaign_prospects o join crm.contacts c on c.id = o.contact_id
    where o.campaign_id = p.campaign_id
      and ((p.email is not null and c.normalized_email = p.email) or (p.linkedin is not null and c.normalized_linkedin = p.linkedin))
  )`;

const SUMMARY_SQL = `select k.id, k.provider, k.channel, k.external_id, k.name, k.status, k.stats, k.synced_at,
       k.backfilled_at is not null as backfilled,
       (select count(*)::int from crm.campaign_prospects p where p.campaign_id = k.id) as prospects
     from crm.campaigns k`;

export function campaignChannel(value: unknown, field = "channel"): CampaignChannel | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && (CAMPAIGN_CHANNELS as readonly string[]).includes(value)) return value as CampaignChannel;
  throw new CrmError("invalid_input", "channel is email or linkedin.", 400, { field });
}

export async function listCampaigns(actor: Actor, options: { channel?: CampaignChannel | null } = {}): Promise<CampaignSummary[]> {
  assertScope(actor.scopes, "crm:read");
  const channel = campaignChannel(options.channel);
  return withActor(actor, async (db) => {
    const result = await db.query<CampaignRow>(`${SUMMARY_SQL} where k.workspace_id = $1 and ($2::text is null or k.channel = $2) order by lower(k.name), k.id`, [
      actor.workspaceId,
      channel,
    ]);
    return result.rows.map(summary);
  });
}

async function readCampaign(db: Db, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound("campaign");
  const result = await db.query<
    CampaignRow & { sequence: SequenceStep[]; variables: string[]; day_stats: ProviderDay[]; sender_ids: string[]; sync_error: string | null; stray: number | null; auto_add: AutoAdd }
  >(
    SUMMARY_SQL.replace(
      "select k.id,",
      "select k.sequence, k.variables, k.day_stats, k.sender_ids, k.sync_error, k.auto_add, (k.sync_state->>'strayConversations')::int as stray, k.id,",
    ) + " where k.id = $1 and k.workspace_id = $2",
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("campaign");
  return row;
}

function dayKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function fillDays(rows: DayStats[], now = new Date(), count = CHART_DAYS, accepted = false): DayStats[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days: DayStats[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = dayKey(new Date(now.getTime() - offset * 86_400_000));
    days.push(byDay.get(day) ?? (accepted ? { day, sent: 0, replied: 0, accepted: 0 } : { day, sent: 0, replied: 0 }));
  }
  return days;
}

function linkedinSteps(sequence: SequenceStep[], counts: { kind: string; step: number | null; count: number }[]): StepStats[] {
  const total = (kind: string, step: number | null = null) =>
    counts.filter((row) => row.kind === kind && (step === null || row.step === step)).reduce((sum, row) => sum + row.count, 0);
  let message = 0;
  return sequence.map((step) => {
    if (step.subject === "Invite") return { step: step.step, variant: step.variant, sent: total("invite_sent"), opened: 0, replied: 0, accepted: total("invite_accepted") };
    message += 1;
    return { step: step.step, variant: step.variant, sent: total("message_sent", message), opened: 0, replied: 0 };
  });
}

function providerDays(rows: ProviderDay[]): DayStats[] {
  return rows.map((row) => ({ day: row.day, sent: row.invites, replied: row.replies, accepted: row.accepted }));
}

async function senderCapacity(db: Db, workspaceId: string, senderIds: string[]): Promise<SenderCapacity | null> {
  if (senderIds.length === 0) return null;
  const result = await db.query<{ senders: number; invites: number | null; messages: number | null }>(
    `select count(*)::int as senders,
            case when count(*) = count(s.invite_limit) then sum(s.invite_limit)::int end as invites,
            case when count(*) = count(s.message_limit) then sum(s.message_limit)::int end as messages
     from crm.campaign_senders s
     where s.workspace_id = $1 and s.provider = 'heyreach' and s.external_id = any($2::text[])`,
    [workspaceId, senderIds],
  );
  const row = result.rows[0];
  return row && row.senders > 0 ? { senders: row.senders, invites: row.invites, messages: row.messages } : null;
}

async function countedLinkedinStats(db: Db, workspaceId: string, campaignId: string): Promise<CampaignStats> {
  const result = await db.query<{
    leads: number;
    enrolled: number;
    not_enrolled: number;
    finished: number;
    paused: number;
    failed: number;
    contacted: number;
    categories: string[] | null;
  }>(
    `select count(*) filter (where p.state = 'pushed')::int as leads,
            count(*) filter (where p.state = 'pushed' and p.lead_status = 'in_progress')::int as enrolled,
            count(*) filter (where p.state = 'pushed' and (p.lead_status is null or p.lead_status = 'not_started'))::int as not_enrolled,
            count(*) filter (where p.state = 'pushed' and p.lead_status = 'completed')::int as finished,
            count(*) filter (where p.state = 'pushed' and p.lead_status = 'paused')::int as paused,
            count(*) filter (where p.state = 'pushed' and p.lead_status = 'stopped')::int as failed,
            count(*) filter (where exists (
              select 1 from crm.campaign_events e where e.prospect_id = p.id and e.kind in ('invite_sent', 'message_sent', 'inmail_sent')
            ))::int as contacted,
            array_agg(p.category) filter (where p.category is not null) as categories
     from crm.campaign_prospects p
     where p.campaign_id = $1 and p.workspace_id = $2`,
    [campaignId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) return {};
  return {
    leads: row.leads,
    enrolled: row.enrolled,
    notEnrolled: row.not_enrolled,
    finished: row.finished,
    pausedLeads: row.paused,
    failed: row.failed,
    contacted: row.contacted,
    interested: (row.categories ?? []).filter((category) => positiveCategory(category)).length,
  };
}

export async function getCampaign(actor: Actor, id: string): Promise<CampaignDetail> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const row = await readCampaign(db, actor, id);
    const linkedin = row.channel === "linkedin";
    const steps = await db.query<{ step: number; variant: string | null; sent: number; opened: number; replied: number }>(
      `select e.step, e.variant,
              count(*) filter (where e.kind = 'sent')::int as sent,
              count(distinct e.prospect_id) filter (where e.kind = 'opened')::int as opened,
              count(distinct e.prospect_id) filter (where e.kind = 'replied')::int as replied
       from crm.campaign_events e
       where e.campaign_id = $1 and e.workspace_id = $2 and e.step is not null
       group by e.step, e.variant
       order by e.step, e.variant nulls first`,
      [row.id, actor.workspaceId],
    );
    const days = await db.query<{ day: string; sent: number; replied: number; invites: number; accepted: number }>(
      `select to_char(e.occurred_at at time zone 'Europe/London', 'YYYY-MM-DD') as day,
              count(*) filter (where e.kind in ('sent', 'message_sent', 'invite_sent', 'inmail_sent'))::int as sent,
              count(*) filter (where e.kind = 'replied')::int as replied,
              count(*) filter (where e.kind = 'invite_sent')::int as invites,
              count(*) filter (where e.kind = 'invite_accepted')::int as accepted
       from crm.campaign_events e
       where e.campaign_id = $1 and e.workspace_id = $2 and e.occurred_at >= now() - make_interval(days => $3)
       group by 1
       order by 1`,
      [row.id, actor.workspaceId, CHART_DAYS + 1],
    );
    const unlinked = await db.query<{ count: number }>(
      `select count(*)::int as count from crm.campaign_prospects p where p.campaign_id = $1 and p.workspace_id = $2 and ${IMPORTABLE_SQL}`,
      [row.id, actor.workspaceId],
    );
    const kinds = linkedin
      ? await db.query<{ kind: string; step: number | null; count: number }>(
          `select e.kind, e.step, count(*)::int as count from crm.campaign_events e
           where e.campaign_id = $1 and e.workspace_id = $2 and e.kind in ('invite_sent', 'invite_accepted', 'message_sent')
           group by e.kind, e.step`,
          [row.id, actor.workspaceId],
        )
      : null;
    const capacity = linkedin ? await senderCapacity(db, actor.workspaceId, row.sender_ids ?? []) : null;
    const briefs = await readCampaignVariables(db, { id: row.id, provider: row.provider, variables: row.variables ?? [] });
    const today = await db.query<{ count: number }>(
      `select count(*)::int as count from crm.campaign_prospects p
       where p.campaign_id = $1 and p.workspace_id = $2 and p.added_by_run_id is not null and p.state not in ('skipped', 'failed')
         and (p.created_at at time zone 'Europe/London')::date = (now() at time zone 'Europe/London')::date`,
      [row.id, actor.workspaceId],
    );
    const counted = linkedin ? await countedLinkedinStats(db, actor.workspaceId, row.id) : null;
    const provider = campaignProvider(row.provider);
    const sequence = row.sequence ?? [];
    const eventDays: DayStats[] = days.rows.map((day) =>
      linkedin ? { day: day.day, sent: day.invites, replied: day.replied, accepted: day.accepted } : { day: day.day, sent: day.sent, replied: day.replied },
    );
    const storedDays = linkedin && Array.isArray(row.day_stats) && row.day_stats.length > 0 ? providerDays(row.day_stats) : null;
    return {
      ...summary(row),
      stats: counted ? { ...counted, ...(row.stats ?? {}) } : (row.stats ?? {}),
      autoAdd: row.auto_add ?? "off",
      sequence,
      variables: row.variables ?? [],
      standardVariables: [...(provider?.standardVariables ?? [])],
      stepStats: kinds ? linkedinSteps(sequence, kinds.rows) : (steps.rows as StepStats[]),
      days: fillDays(storedDays ?? eventDays, new Date(), CHART_DAYS, linkedin),
      unlinked: unlinked.rows[0]?.count ?? 0,
      url: provider?.campaignUrl(row.external_id) ?? null,
      capacity,
      syncError: row.sync_error,
      strayConversations: row.stray ?? 0,
      briefs,
      addedToday: today.rows[0]?.count ?? 0,
    };
  });
}

export async function campaignOptions(actor: Actor, options: { all?: boolean } = {}): Promise<CampaignOption[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string; channel: CampaignOption["channel"]; status: CampaignStatus; provider: CampaignProviderId }>(
      `select k.id, k.name, k.channel, k.status, k.provider from crm.campaigns k
       where k.workspace_id = $1
         and exists (select 1 from crm.campaign_connections c where c.workspace_id = k.workspace_id and c.provider = k.provider)
       order by k.channel, lower(k.name), k.id`,
      [actor.workspaceId],
    );
    return result.rows.filter((row) => options.all || !addRefusal(row)).map((row) => ({ id: row.id, name: row.name, channel: row.channel }));
  });
}

type ProspectSqlRow = {
  id: string;
  contact_id: string | null;
  company_id: string | null;
  name: string;
  company_name: string | null;
  email: string | null;
  state: ProspectState;
  skip_reason: string | null;
  lead_status: string | null;
  category: string | null;
  replied_at: Date | null;
  stop_requested_at: Date | null;
  stopped_at: Date | null;
  last_kind: CampaignEventKind | null;
  last_step: number | null;
  last_at: Date | null;
  stage: LinkedinStage | null;
  sender: string | null;
  import_error: string | null;
  stop_error: string | null;
  not_enrolled: boolean;
  importable: boolean;
};

const FILTER_SQL: Record<ProspectFilter, string> = {
  all: "true",
  replied: "p.replied_at is not null",
  skipped: "p.state in ('skipped', 'failed')",
};

export async function listCampaignProspects(
  actor: Actor,
  campaignId: string,
  options: { filter?: ProspectFilter; search?: string; page?: number } = {},
): Promise<ProspectPage> {
  assertScope(actor.scopes, "crm:read");
  const filter = options.filter && options.filter in FILTER_SQL ? options.filter : "all";
  const asked = Math.max(1, Math.floor(options.page ?? 1));
  const search = options.search?.trim().slice(0, 200) ?? "";
  return withActor(actor, async (db) => {
    const campaign = await readCampaign(db, actor, campaignId);
    const where = `p.campaign_id = $1 and p.workspace_id = $2 and ${FILTER_SQL[campaign.channel === "linkedin" ? "all" : filter]}
      and ($3 = '' or concat_ws(' ', c.first_name, c.last_name, c.email, p.email, p.linkedin, p.lead->>'firstName', p.lead->>'lastName', p.lead->>'companyName', co.name) ilike '%' || $3 || '%')`;
    const from = `from crm.campaign_prospects p
      left join crm.contacts c on c.id = p.contact_id
      left join crm.companies co on co.id = coalesce(p.company_id, c.company_id)`;
    const escaped = search.replace(/[\\%_]/g, (match) => `\\${match}`);
    const total = await db.query<{ count: number }>(`select count(*)::int as count ${from} where ${where}`, [campaign.id, actor.workspaceId, escaped]);
    const page = Math.min(asked, Math.max(1, Math.ceil((total.rows[0]?.count ?? 0) / PROSPECT_PAGE_SIZE)));
    const rows = await db.query<ProspectSqlRow>(
        `select p.id, p.contact_id, coalesce(p.company_id, c.company_id) as company_id,
                coalesce(
                  nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                  nullif(btrim(concat_ws(' ', p.lead->>'firstName', p.lead->>'lastName')), ''),
                  c.email, p.email, p.linkedin, 'Unnamed'
                ) as name,
                coalesce(co.name, nullif(p.lead->>'companyName', '')) as company_name,
                coalesce(c.email, p.email) as email,
                p.state, p.skip_reason, p.lead_status, p.category, p.replied_at, p.stop_requested_at, p.stopped_at, p.import_error, p.stop_error,
                last.kind as last_kind, last.step as last_step, last.occurred_at as last_at,
                case
                  when $6 and exists (select 1 from crm.campaign_events a where a.prospect_id = p.id and a.kind = 'invite_accepted') then 'accepted'
                  when $6 and exists (select 1 from crm.campaign_events a where a.prospect_id = p.id and a.kind = 'invite_sent') then 'invited'
                end as stage,
                sender.name as sender,
                ($6 and p.state = 'pushed' and p.lead_status is null and p.external_lead_id is null) as not_enrolled,
                (p.contact_id is null and p.state = 'pushed' and (p.email is not null or p.linkedin is not null)) as importable
         ${from}
         left join lateral (
           select coalesce(nullif(btrim(pr.full_name), ''), pr.email, nullif(s.name, '')) as name
           from crm.campaign_senders s
           left join crm.profiles pr on pr.id = s.user_id
           where $6 and s.workspace_id = p.workspace_id and s.provider = 'heyreach' and s.external_id = p.sender_id
         ) sender on true
         left join lateral (
           select e.kind, e.step, e.occurred_at from crm.campaign_events e
           where e.prospect_id = p.id
           order by e.occurred_at desc, e.created_at desc,
                    case e.kind when 'message_sent' then 3 when 'invite_accepted' then 2 when 'invite_sent' then 1 else 0 end desc,
                    e.step desc nulls last
           limit 1
         ) last on true
         where ${where}
         order by coalesce(p.last_event_at, p.created_at) desc, p.id
         limit $4 offset $5`,
        [campaign.id, actor.workspaceId, escaped, PROSPECT_PAGE_SIZE, (page - 1) * PROSPECT_PAGE_SIZE, campaign.channel === "linkedin"],
    );
    return {
      rows: rows.rows.map((row) => ({
        id: row.id,
        contactId: row.contact_id,
        companyId: row.company_id,
        name: row.name,
        companyName: row.company_name,
        email: row.email,
        state: row.state,
        skipReason: row.skip_reason,
        leadStatus: row.lead_status,
        category: row.category,
        repliedAt: row.replied_at?.toISOString() ?? null,
        stopRequestedAt: row.stop_requested_at?.toISOString() ?? null,
        stoppedAt: row.stopped_at?.toISOString() ?? null,
        lastEvent: row.last_kind && row.last_at ? { kind: row.last_kind, step: row.last_step, at: row.last_at.toISOString() } : null,
        stage: row.stage,
        sender: row.sender,
        importError: row.contact_id ? null : row.import_error,
        stopError: row.stop_requested_at && !row.stopped_at ? row.stop_error : null,
        notEnrolled: row.not_enrolled,
        importable: row.importable,
      })),
      total: total.rows[0]?.count ?? 0,
      page,
      pageSize: PROSPECT_PAGE_SIZE,
    };
  });
}

export const ACTIVITY_MAX = 500;

export type CampaignActivity = {
  kind: CampaignEventKind;
  at: string;
  step: number | null;
  prospectId: string;
  campaignId: string;
  campaignName: string;
  channel: CampaignChannel;
  contactId: string | null;
  name: string;
  companyName: string | null;
  category: string | null;
};

export type ActivityQuery = {
  channel?: CampaignChannel | null;
  campaignId?: string | null;
  kinds?: string[] | null;
  since?: Date | null;
  until?: Date | null;
  limit?: number;
};

function activityKinds(kinds: string[] | null | undefined) {
  if (!kinds || kinds.length === 0) return null;
  const unknown = kinds.filter((kind) => !(EVENT_KINDS as readonly string[]).includes(kind));
  if (unknown.length > 0) throw new CrmError("invalid_input", `Unknown event: ${unknown.join(", ")}. Use ${EVENT_KINDS.join(", ")}.`, 400, { field: "kinds" });
  return [...new Set(kinds)];
}

export async function listCampaignActivity(actor: Actor, input: ActivityQuery = {}): Promise<{ events: CampaignActivity[]; more: boolean }> {
  assertScope(actor.scopes, "crm:read");
  const channel = campaignChannel(input.channel);
  const kinds = activityKinds(input.kinds);
  const limit = Math.min(ACTIVITY_MAX, Math.max(1, Math.floor(input.limit ?? 100)));
  if (input.campaignId && !isUuid(input.campaignId)) throw notFound("campaign");
  const since = input.since ?? new Date(Date.now() - CHART_DAYS * 86_400_000);
  const until = input.until ?? null;
  if (until && until.getTime() < since.getTime()) throw new CrmError("invalid_input", "until is before since.", 400, { field: "until" });
  return withActor(actor, async (db) => {
    if (input.campaignId) await readCampaign(db, actor, input.campaignId);
    const result = await db.query<{
      kind: CampaignEventKind;
      occurred_at: Date;
      step: number | null;
      prospect_id: string;
      campaign_id: string;
      campaign_name: string;
      channel: CampaignChannel;
      contact_id: string | null;
      name: string;
      company_name: string | null;
      category: string | null;
    }>(
      `select e.kind, e.occurred_at, e.step, e.prospect_id, k.id as campaign_id, k.name as campaign_name, k.channel, p.contact_id,
              coalesce(
                nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                nullif(btrim(concat_ws(' ', p.lead->>'firstName', p.lead->>'lastName')), ''),
                c.email, p.email, p.linkedin, 'Unnamed'
              ) as name,
              coalesce(co.name, nullif(p.lead->>'companyName', '')) as company_name,
              p.category
       from crm.campaigns k
       join crm.campaign_events e on e.campaign_id = k.id and e.workspace_id = k.workspace_id
       join crm.campaign_prospects p on p.id = e.prospect_id
       left join crm.contacts c on c.id = p.contact_id
       left join crm.companies co on co.id = coalesce(p.company_id, c.company_id)
       where k.workspace_id = $1
         and ($2::text is null or k.channel = $2)
         and ($3::uuid is null or k.id = $3)
         and ($4::text[] is null or e.kind = any($4))
         and e.occurred_at >= $5
         and ($6::timestamptz is null or e.occurred_at < $6)
       order by e.occurred_at desc, e.id
       limit $7`,
      [actor.workspaceId, channel, input.campaignId ?? null, kinds, since, until, limit + 1],
    );
    return {
      events: result.rows.slice(0, limit).map((row) => ({
        kind: row.kind,
        at: row.occurred_at.toISOString(),
        step: row.step,
        prospectId: row.prospect_id,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        channel: row.channel,
        contactId: row.contact_id,
        name: row.name,
        companyName: row.company_name,
        category: row.category,
      })),
      more: result.rows.length > limit,
    };
  });
}

export const SEVERAL_CAMPAIGNS = "This person is in several campaigns. Pass campaignId.";

export async function campaignOfProspect(actor: Actor, prospectId: string): Promise<{ id: string; name: string; channel: CampaignChannel }> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(prospectId)) throw notFound("prospect");
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string; channel: CampaignChannel }>(
      "select k.id, k.name, k.channel from crm.campaign_prospects p join crm.campaigns k on k.id = p.campaign_id where p.id = $1 and p.workspace_id = $2",
      [prospectId, actor.workspaceId],
    );
    if (!result.rows[0]) throw notFound("prospect");
    return result.rows[0];
  });
}

export async function campaignSummaryOf(actor: Actor, campaignId: string): Promise<{ id: string; name: string; channel: CampaignChannel }> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const row = await readCampaign(db, actor, campaignId);
    return { id: row.id, name: row.name, channel: row.channel };
  });
}

export async function contactProspectId(
  actor: Actor,
  contactId: string,
  options: { channel?: CampaignChannel | null; campaignId?: string | null; single?: boolean } = {},
): Promise<string> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(contactId)) throw notFound("contact");
  if (options.campaignId && !isUuid(options.campaignId)) throw notFound("campaign");
  const channel = campaignChannel(options.channel);
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; live: boolean }>(
      `select p.id, (p.state in ('queued', 'filling', 'pushing', 'pushed') and p.stopped_at is null) as live
       from crm.campaign_prospects p
       join crm.campaigns k on k.id = p.campaign_id
       where p.workspace_id = $1 and p.contact_id = $2 and ($3::text is null or k.channel = $3) and ($4::uuid is null or k.id = $4)
       order by (p.state = 'pushed') desc, coalesce(p.last_event_at, p.created_at) desc, p.id`,
      [actor.workspaceId, contactId, channel, options.campaignId ?? null],
    );
    if (options.single && !options.campaignId) {
      const live = result.rows.filter((row) => row.live);
      if (live.length > 1 || (live.length === 0 && result.rows.length > 1)) throw new CrmError("conflict", SEVERAL_CAMPAIGNS, 409, { field: "campaignId" });
      if (live[0]) return live[0].id;
    }
    const id = result.rows[0]?.id;
    if (id) return id;
    if (options.campaignId) throw new CrmError("not_found", "This person isn't in that campaign.", 404);
    throw new CrmError("not_found", channel ? `This person isn't in a ${channel === "linkedin" ? "LinkedIn" : "email"} campaign.` : "This person isn't in a campaign.", 404);
  });
}

export type MailboxHealth = { mailboxes: Mailbox[]; error: string | null } | null;

export async function campaignMailboxes(actor: Actor, campaignId: string, options: { fetchImpl?: typeof fetch } = {}): Promise<MailboxHealth> {
  assertScope(actor.scopes, "crm:read");
  const campaign = await withActor(actor, (db) => readCampaign(db, actor, campaignId));
  const provider = campaignProvider(campaign.provider);
  if (!provider?.readMailboxes) return null;
  const stored = await query<{ key: string | null }>("select private.campaign_connection_key($1, $2) as key", [actor.workspaceId, provider.id]);
  const encrypted = stored.rows[0]?.key;
  if (!encrypted) return null;
  try {
    const mailboxes = await provider.readMailboxes({ key: decryptSecret(encrypted), workspaceId: actor.workspaceId, fetchImpl: options.fetchImpl }, campaign.external_id);
    return { mailboxes, error: null };
  } catch (error) {
    if (error instanceof ServiceBusy) return { mailboxes: [], error: `${provider.name} is busy. Try again in a minute.` };
    const failure = provider.failure(error);
    if (failure) return { mailboxes: [], error: "Couldn't read the mailboxes. Try again." };
    throw error;
  }
}

type ImportRow = {
  id: string;
  email: string | null;
  linkedin: string | null;
  lead: { firstName?: string | null; lastName?: string | null; companyName?: string | null; website?: string | null; title?: string | null; linkedinUrl?: string | null };
};

export type ImportResult = { imported: number; linked: number; failed: number; left: number; reasons: string[] };

async function companyFor(db: Db, workspaceId: string, lead: ImportRow["lead"]) {
  const domain = lead.website ? canonicalDomain(lead.website) : null;
  if (domain) {
    const byDomain = await db.query<{ id: string }>(
      "select id from crm.companies where workspace_id = $1 and archived_at is null and domain = $2 order by created_at limit 1",
      [workspaceId, domain],
    );
    if (byDomain.rows[0]) return byDomain.rows[0].id;
  }
  const name = lead.companyName?.trim();
  if (!name) return null;
  const byName = await db.query<{ id: string }>(
    "select id from crm.companies where workspace_id = $1 and archived_at is null and lower(name) = lower($2) order by domain nulls first, created_at limit 1",
    [workspaceId, name],
  );
  return byName.rows[0]?.id ?? null;
}

function clean(value: string | null | undefined, max: number) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function lastingImportFailure(error: unknown) {
  if (error instanceof CrmError) return error.status < 500 && error.status !== 429;
  return isPgError(error) && /^2[23]/.test(error.code);
}

async function linkProspect(db: Db, workspaceId: string, prospectId: string, contactId: string, companyId: string | null) {
  const linked = await db.query(
    `update crm.campaign_prospects p
     set contact_id = $3, company_id = coalesce(p.company_id, $4)
     where p.id = $1 and p.workspace_id = $2 and p.contact_id is null
       and not exists (select 1 from crm.campaign_prospects o where o.campaign_id = p.campaign_id and o.contact_id = $3)`,
    [prospectId, workspaceId, contactId, companyId],
  );
  return (linked.rowCount ?? 0) > 0;
}

export const IMPORT_TAG_LIMIT = 20;
const IMPORT_TAG_MAX = 40;

export function importTags(current: string[], wanted: string[]) {
  const next = [...current];
  for (const raw of wanted) {
    const tag = normalizeTag(raw.replace(/;/g, " ")).slice(0, IMPORT_TAG_MAX).trim();
    if (!tag || next.some((item) => item.toLowerCase() === tag.toLowerCase())) continue;
    if (next.length >= IMPORT_TAG_LIMIT) break;
    next.push(tag);
  }
  return next;
}

type ImportOutcome = { contactId: string; created: boolean; linked: boolean };

async function importRow(db: Db, actor: Actor, row: ImportRow, provenance: Provenance, tags: string[]): Promise<ImportOutcome> {
  await lockNamespace(db, actor.workspaceId, "contacts");
  const existing = await db.query<{ id: string; company_id: string | null }>(
    `select c.id, c.company_id from crm.contacts c
     where c.workspace_id = $1 and c.archived_at is null
       and (($2::text is not null and c.normalized_email = $2) or ($3::text is not null and c.normalized_linkedin = $3))
     order by (c.normalized_email is not distinct from $2) desc, c.created_at, c.id
     limit 1`,
    [actor.workspaceId, row.email, row.linkedin],
  );
  const match = existing.rows[0];
  let outcome: ImportOutcome;
  if (match) {
    outcome = { contactId: match.id, created: false, linked: await linkProspect(db, actor.workspaceId, row.id, match.id, match.company_id) };
  } else {
    const companyId = await companyFor(db, actor.workspaceId, row.lead ?? {});
    const saved = await upsertContactInDb(
      db,
      actor,
      {
        firstName: clean(row.lead?.firstName, NAME_MAX),
        lastName: clean(row.lead?.lastName, NAME_MAX),
        email: row.email ?? undefined,
        linkedinUrl: row.linkedin ? `https://www.${row.linkedin}` : undefined,
        jobTitle: clean(row.lead?.title, TITLE_MAX),
        ...(companyId ? { companyId } : {}),
      },
      provenance,
      { nameMatch: false },
    );
    outcome = { contactId: saved.contact.id, created: saved.created, linked: await linkProspect(db, actor.workspaceId, row.id, saved.contact.id, saved.contact.companyId ?? null) };
  }
  if (tags.length > 0) await tagImported(db, actor, outcome.contactId, tags, provenance);
  return outcome;
}

async function tagImported(db: Db, actor: Actor, contactId: string, tags: string[], provenance: Provenance) {
  await lockNamespace(db, actor.workspaceId, "contacts");
  const current = await db.query<{ tags: string[] | null }>("select tags from crm.contacts where id = $1 and workspace_id = $2 and archived_at is null", [contactId, actor.workspaceId]);
  if (!current.rows[0]) return;
  const before = current.rows[0].tags ?? [];
  if (importTags(before, tags).length !== before.length) await editContactTagsInDb(db, actor, contactId, (now) => importTags(now, tags), provenance);
}

async function importFailure(actor: Actor, prospectId: string, error: unknown) {
  if (!(error instanceof CrmError) && !isPgError(error)) throw error;
  const lasting = lastingImportFailure(error);
  const reason = error instanceof CrmError ? error.message : lasting ? "Couldn't add this person." : "Couldn't add this person. Try again.";
  if (lasting) await query("select private.campaign_prospect_import_failed($1, $2, $3)", [actor.workspaceId, prospectId, reason]);
  return reason;
}

export type ImportOneResult = { contactId: string; created: boolean; linked: boolean };

export async function importCampaignProspect(
  actor: Actor,
  prospectId: string,
  options: { provenance?: Provenance; tags?: string[] } = {},
): Promise<ImportOneResult> {
  assertScope(actor.scopes, "campaigns:write");
  assertScope(actor.scopes, "contacts:write");
  if (!isUuid(prospectId)) throw notFound("prospect");
  const provenance: Provenance = { ...(options.provenance ?? { operation: "import_campaign_prospect", source: "web" }), catchUp: true };
  const row = await withActor(actor, async (db) => {
    const found = await db.query<ImportRow & { contact_id: string | null }>(
      "select p.id, p.email, p.linkedin, p.lead, p.contact_id from crm.campaign_prospects p where p.id = $1 and p.workspace_id = $2",
      [prospectId, actor.workspaceId],
    );
    return found.rows[0] ?? null;
  });
  if (!row) throw notFound("prospect");
  if (row.contact_id) {
    const contactId = row.contact_id;
    if (options.tags?.length) await withActor(actor, (db) => tagImported(db, actor, contactId, options.tags!, provenance));
    return { contactId, created: false, linked: false };
  }
  if (!row.email && !row.linkedin) throw new CrmError("invalid_input", "This prospect has no email or LinkedIn profile to match.", 400);
  try {
    const outcome = await withActor(actor, (db) => importRow(db, actor, row, provenance, options.tags ?? []));
    if (!outcome.linked) {
      const linked = await withActor(actor, async (db) => {
        const current = await db.query<{ contact_id: string | null }>("select contact_id from crm.campaign_prospects where id = $1 and workspace_id = $2", [row.id, actor.workspaceId]);
        return current.rows[0]?.contact_id ?? null;
      });
      if (!linked) throw new CrmError("conflict", "Someone else in this campaign is already this contact.", 409);
    }
    return outcome;
  } catch (error) {
    const reason = await importFailure(actor, row.id, error);
    if (error instanceof CrmError) throw error;
    throw new CrmError("invalid_input", reason, lastingImportFailure(error) ? 400 : 503);
  }
}

export async function importCampaignProspects(
  actor: Actor,
  campaignId: string,
  options: { deadline?: number; provenance?: Provenance } = {},
): Promise<ImportResult> {
  assertScope(actor.scopes, "campaigns:write");
  assertScope(actor.scopes, "contacts:write");
  const provenance: Provenance = { ...(options.provenance ?? { operation: "import_campaign_prospects", source: "web" }), catchUp: true };
  const campaign = await withActor(actor, (db) => readCampaign(db, actor, campaignId));
  const result: ImportResult = { imported: 0, linked: 0, failed: 0, left: 0, reasons: [] };
  const tried = new Set<string>();
  while (timeLeft(options.deadline, 3_000)) {
    const batch = await withActor(actor, async (db) => {
      const rows = await db.query<ImportRow>(
        `select p.id, p.email, p.linkedin, p.lead from crm.campaign_prospects p
         where p.campaign_id = $1 and p.workspace_id = $2 and ${IMPORTABLE_SQL}
           and not (p.id = any($3::uuid[]))
         order by p.created_at, p.id
         limit $4`,
        [campaign.id, actor.workspaceId, [...tried], IMPORT_BATCH],
      );
      return rows.rows;
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      tried.add(row.id);
      if (!timeLeft(options.deadline, 1_000)) break;
      try {
        const outcome = await withActor(actor, (db) => importRow(db, actor, row, provenance, []));
        if (outcome.created) result.imported += 1;
        if (outcome.linked) result.linked += 1;
      } catch (error) {
        const reason = await importFailure(actor, row.id, error);
        result.failed += 1;
        if (!result.reasons.includes(reason)) result.reasons.push(reason);
      }
    }
  }
  result.left = await withActor(actor, async (db) => {
    const left = await db.query<{ count: number }>(
      `select count(*)::int as count from crm.campaign_prospects p where p.campaign_id = $1 and p.workspace_id = $2 and ${IMPORTABLE_SQL}`,
      [campaign.id, actor.workspaceId],
    );
    return left.rows[0]?.count ?? 0;
  });
  return result;
}
