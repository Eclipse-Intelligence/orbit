import { campaignProvider } from "@/lib/campaigns/providers";
import type {
  CampaignDetail,
  CampaignEventKind,
  CampaignProviderId,
  CampaignStats,
  CampaignStatus,
  CampaignSummary,
  DayStats,
  Mailbox,
  ProspectFilter,
  ProspectPage,
  ProspectState,
  SequenceStep,
  StepStats,
} from "@/lib/campaigns/types";
import { upsertContactInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { timeLeft } from "@/lib/crm/conversations";
import { CrmError, isPgError, notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalDomain } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { query, type Db } from "@/lib/db/pool";
import { ServiceBusy } from "@/lib/workflows/limits";

export const PROSPECT_PAGE_SIZE = 100;
const CHART_DAYS = 30;
const IMPORT_BATCH = 25;

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

const SUMMARY_SQL = `select k.id, k.provider, k.channel, k.external_id, k.name, k.status, k.stats, k.synced_at,
       k.backfilled_at is not null as backfilled,
       (select count(*)::int from crm.campaign_prospects p where p.campaign_id = k.id) as prospects
     from crm.campaigns k`;

export async function listCampaigns(actor: Actor): Promise<CampaignSummary[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<CampaignRow>(`${SUMMARY_SQL} where k.workspace_id = $1 order by lower(k.name), k.id`, [actor.workspaceId]);
    return result.rows.map(summary);
  });
}

async function readCampaign(db: Db, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound("campaign");
  const result = await db.query<CampaignRow & { sequence: SequenceStep[]; variables: string[] }>(
    SUMMARY_SQL.replace("select k.id,", "select k.sequence, k.variables, k.id,") + " where k.id = $1 and k.workspace_id = $2",
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("campaign");
  return row;
}

function dayKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function fillDays(rows: DayStats[], now = new Date(), count = CHART_DAYS): DayStats[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days: DayStats[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = dayKey(new Date(now.getTime() - offset * 86_400_000));
    days.push(byDay.get(day) ?? { day, sent: 0, replied: 0 });
  }
  return days;
}

export async function getCampaign(actor: Actor, id: string): Promise<CampaignDetail> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const row = await readCampaign(db, actor, id);
    const [steps, days, unlinked] = await Promise.all([
      db.query<{ step: number; variant: string | null; sent: number; opened: number; replied: number }>(
        `select e.step, e.variant,
                count(*) filter (where e.kind = 'sent')::int as sent,
                count(distinct e.prospect_id) filter (where e.kind = 'opened')::int as opened,
                count(distinct e.prospect_id) filter (where e.kind = 'replied')::int as replied
         from crm.campaign_events e
         where e.campaign_id = $1 and e.workspace_id = $2 and e.step is not null
         group by e.step, e.variant
         order by e.step, e.variant nulls first`,
        [row.id, actor.workspaceId],
      ),
      db.query<{ day: string; sent: number; replied: number }>(
        `select to_char(e.occurred_at at time zone 'Europe/London', 'YYYY-MM-DD') as day,
                count(*) filter (where e.kind in ('sent', 'message_sent', 'invite_sent', 'inmail_sent'))::int as sent,
                count(*) filter (where e.kind = 'replied')::int as replied
         from crm.campaign_events e
         where e.campaign_id = $1 and e.workspace_id = $2 and e.occurred_at >= now() - make_interval(days => $3)
         group by 1
         order by 1`,
        [row.id, actor.workspaceId, CHART_DAYS + 1],
      ),
      db.query<{ count: number }>(
        "select count(*)::int as count from crm.campaign_prospects p where p.campaign_id = $1 and p.workspace_id = $2 and p.contact_id is null and (p.email is not null or p.linkedin is not null)",
        [row.id, actor.workspaceId],
      ),
    ]);
    const provider = campaignProvider(row.provider);
    return {
      ...summary(row),
      sequence: row.sequence ?? [],
      variables: row.variables ?? [],
      standardVariables: [...(provider?.standardVariables ?? [])],
      stepStats: steps.rows as StepStats[],
      days: fillDays(days.rows),
      unlinked: unlinked.rows[0]?.count ?? 0,
      url: provider?.campaignUrl(row.external_id) ?? null,
    };
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
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const search = options.search?.trim().slice(0, 200) ?? "";
  return withActor(actor, async (db) => {
    const campaign = await readCampaign(db, actor, campaignId);
    const where = `p.campaign_id = $1 and p.workspace_id = $2 and ${FILTER_SQL[filter]}
      and ($3 = '' or concat_ws(' ', c.first_name, c.last_name, c.email, p.email, p.lead->>'firstName', p.lead->>'lastName', p.lead->>'companyName', co.name) ilike '%' || $3 || '%')`;
    const from = `from crm.campaign_prospects p
      left join crm.contacts c on c.id = p.contact_id
      left join crm.companies co on co.id = coalesce(p.company_id, c.company_id)`;
    const escaped = search.replace(/[\\%_]/g, (match) => `\\${match}`);
    const [rows, total] = await Promise.all([
      db.query<ProspectSqlRow>(
        `select p.id, p.contact_id, coalesce(p.company_id, c.company_id) as company_id,
                coalesce(
                  nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                  nullif(btrim(concat_ws(' ', p.lead->>'firstName', p.lead->>'lastName')), ''),
                  c.email, p.email, p.linkedin, 'Unnamed'
                ) as name,
                coalesce(co.name, nullif(p.lead->>'companyName', '')) as company_name,
                coalesce(c.email, p.email) as email,
                p.state, p.skip_reason, p.lead_status, p.category, p.replied_at, p.stop_requested_at, p.stopped_at,
                last.kind as last_kind, last.step as last_step, last.occurred_at as last_at
         ${from}
         left join lateral (
           select e.kind, e.step, e.occurred_at from crm.campaign_events e
           where e.prospect_id = p.id
           order by e.occurred_at desc, e.created_at desc
           limit 1
         ) last on true
         where ${where}
         order by coalesce(p.last_event_at, p.created_at) desc, p.id
         limit $4 offset $5`,
        [campaign.id, actor.workspaceId, escaped, PROSPECT_PAGE_SIZE, (page - 1) * PROSPECT_PAGE_SIZE],
      ),
      db.query<{ count: number }>(`select count(*)::int as count ${from} where ${where}`, [campaign.id, actor.workspaceId, escaped]),
    ]);
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
      })),
      total: total.rows[0]?.count ?? 0,
      page,
      pageSize: PROSPECT_PAGE_SIZE,
    };
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

export type ImportResult = { imported: number; linked: number; failed: number; left: number };

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

export async function importCampaignProspects(
  actor: Actor,
  campaignId: string,
  options: { deadline?: number; provenance?: Provenance } = {},
): Promise<ImportResult> {
  assertScope(actor.scopes, "campaigns:write");
  assertScope(actor.scopes, "contacts:write");
  const provenance: Provenance = options.provenance ?? { operation: "import_campaign_prospects", source: "web" };
  const campaign = await withActor(actor, (db) => readCampaign(db, actor, campaignId));
  const result: ImportResult = { imported: 0, linked: 0, failed: 0, left: 0 };
  const tried = new Set<string>();
  while (timeLeft(options.deadline, 3_000)) {
    const batch = await withActor(actor, async (db) => {
      const rows = await db.query<ImportRow>(
        `select p.id, p.email, p.linkedin, p.lead from crm.campaign_prospects p
         where p.campaign_id = $1 and p.workspace_id = $2 and p.contact_id is null
           and (p.email is not null or p.linkedin is not null)
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
        const outcome = await withActor(actor, async (db) => {
          const companyId = await companyFor(db, actor.workspaceId, row.lead ?? {});
          const saved = await upsertContactInDb(
            db,
            actor,
            {
              firstName: clean(row.lead?.firstName, 100),
              lastName: clean(row.lead?.lastName, 100),
              email: row.email ?? undefined,
              linkedinUrl: clean(row.lead?.linkedinUrl, 500) ?? (row.linkedin ? `https://www.${row.linkedin}` : undefined),
              jobTitle: clean(row.lead?.title, 200),
              ...(companyId ? { companyId } : {}),
            },
            provenance,
            { nameMatch: false },
          );
          const linked = await db.query(
            `update crm.campaign_prospects p
             set contact_id = $3, company_id = coalesce(p.company_id, $4)
             where p.id = $1 and p.workspace_id = $2 and p.contact_id is null
               and not exists (select 1 from crm.campaign_prospects o where o.campaign_id = p.campaign_id and o.contact_id = $3)`,
            [row.id, actor.workspaceId, saved.contact.id, saved.contact.companyId ?? null],
          );
          return { created: saved.created, linked: (linked.rowCount ?? 0) > 0 };
        });
        if (outcome.created) result.imported += 1;
        if (outcome.linked) result.linked += 1;
      } catch (error) {
        if (!(error instanceof CrmError) && !isPgError(error)) throw error;
        result.failed += 1;
      }
    }
  }
  result.left = await withActor(actor, async (db) => {
    const left = await db.query<{ count: number }>(
      "select count(*)::int as count from crm.campaign_prospects p where p.campaign_id = $1 and p.workspace_id = $2 and p.contact_id is null and (p.email is not null or p.linkedin is not null)",
      [campaign.id, actor.workspaceId],
    );
    return left.rows[0]?.count ?? 0;
  });
  return result;
}
