import { campaignProvider } from "@/lib/campaigns/providers";
import type { CampaignChannel, CampaignProviderId, CampaignStatus, ProspectState } from "@/lib/campaigns/types";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError, notFound } from "@/lib/crm/errors";
import { isUuid, recordAudit } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";
import { kickWorkflows } from "@/lib/workflows/events";

export const ADD_MAX = 1000;
export const BRIEF_MAX = 2000;
export const MAX_LENGTH_MAX = 5000;

export const PROSPECT_AUDIT_EVENTS = {
  added: "campaign.prospect_added",
  variablesSaved: "campaign.variables_saved",
} as const;

export type AddOutcome = "added" | "requeued" | "already" | "skipped";

export type AddedProspect = {
  contactId: string;
  prospectId: string;
  state: ProspectState;
  skipReason: string | null;
  outcome: AddOutcome;
  mine: boolean;
};

export type AddResult = {
  campaign: { id: string; name: string; channel: CampaignChannel };
  added: number;
  already: number;
  skipped: number;
  missing: number;
  reasons: { reason: string; count: number }[];
  prospects: AddedProspect[];
};

export type CampaignTarget = {
  id: string;
  workspace_id: string;
  provider: CampaignProviderId;
  channel: CampaignChannel;
  external_id: string;
  name: string;
  status: CampaignStatus;
  sequence: unknown;
  variables: string[];
  sender_ids: string[];
};

export async function readCampaignTarget(db: Db, workspaceId: string, campaignId: string) {
  if (!isUuid(campaignId)) throw notFound("campaign");
  const result = await db.query<CampaignTarget>(
    `select id, workspace_id, provider, channel, external_id, name, status, sequence, variables, sender_ids
     from crm.campaigns where id = $1 and workspace_id = $2`,
    [campaignId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("campaign");
  return row;
}

export function addRefusal(campaign: Pick<CampaignTarget, "channel" | "status" | "provider">) {
  const name = campaignProvider(campaign.provider)?.name ?? "the campaign tool";
  if (campaign.channel === "linkedin" && campaign.status !== "active") return `Start this campaign in ${name} first.`;
  if (campaign.status === "completed" || campaign.status === "stopped" || campaign.status === "archived") return "This campaign has ended.";
  return null;
}

async function assertConnected(workspaceId: string, provider: CampaignProviderId) {
  const stored = await query<{ key: string | null }>("select private.campaign_connection_key($1, $2) as key", [workspaceId, provider]);
  if (!stored.rows[0]?.key) throw new CrmError("not_connected", `Connect ${campaignProvider(provider)?.name ?? "the campaign tool"} in Settings › Tools first.`, 409);
}

function cleanIds(ids: unknown, noun: string) {
  const list = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && isUuid(id)))] : [];
  if (list.length === 0) throw new CrmError("invalid_input", `Choose at least one ${noun}.`, 400);
  if (list.length > ADD_MAX) throw new CrmError("invalid_input", "Add up to 1,000 people at a time.", 400);
  return list;
}

export function tallyReasons(prospects: Pick<AddedProspect, "outcome" | "skipReason">[]) {
  const counts = new Map<string, number>();
  for (const item of prospects) {
    if (item.outcome !== "skipped") continue;
    const reason = item.skipReason ?? "Skipped";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

type AddRow = { contact_id: string; prospect_id: string; state: ProspectState; skip_reason: string | null; outcome: AddOutcome; mine: boolean };

export async function addProspects(
  actor: Actor,
  campaignId: string,
  contactIds: unknown,
  provenance: Provenance,
  options: { runId?: string | null; kick?: boolean } = {},
): Promise<AddResult> {
  assertScope(actor.scopes, "campaigns:write");
  const ids = cleanIds(contactIds, "contact");
  const campaign = await withActor(actor, (db) => readCampaignTarget(db, actor.workspaceId, campaignId));
  const refusal = addRefusal(campaign);
  if (refusal) throw new CrmError("conflict", refusal, 409);
  await assertConnected(actor.workspaceId, campaign.provider);
  let rows: AddRow[];
  try {
    const result = await query<AddRow>("select * from private.campaign_add_prospects($1, $2, $3::uuid[], $4, $5, $6)", [
      actor.workspaceId,
      campaign.id,
      ids,
      actor.type === "user" ? actor.userId : null,
      actor.type === "agent" ? actor.agentId : null,
      options.runId ?? null,
    ]);
    rows = result.rows;
  } catch (error) {
    if (isPgError(error) && error.code === "P0002") throw notFound("campaign");
    if (isPgError(error) && error.code === "22023") throw new CrmError("invalid_input", error.message, 400);
    throw error;
  }
  const prospects: AddedProspect[] = rows.map((row) => ({
    contactId: row.contact_id,
    prospectId: row.prospect_id,
    state: row.state,
    skipReason: row.skip_reason,
    outcome: row.outcome,
    mine: row.mine,
  }));
  const fresh = prospects.filter((item) => item.outcome === "added" || item.outcome === "requeued");
  if (fresh.length > 0) {
    await withActor(actor, async (db) => {
      for (const item of fresh) {
        await recordAudit(db, actor, PROSPECT_AUDIT_EVENTS.added, "campaign_prospect", item.prospectId, provenance, {
          campaignId: campaign.id,
          campaign: campaign.name,
          channel: campaign.channel,
          contactId: item.contactId,
          requeued: item.outcome === "requeued",
        });
      }
    });
    if (options.kick !== false && !options.runId) kickWorkflows();
  }
  return {
    campaign: { id: campaign.id, name: campaign.name, channel: campaign.channel },
    added: fresh.length,
    already: prospects.filter((item) => item.outcome === "already").length,
    skipped: prospects.filter((item) => item.outcome === "skipped").length,
    missing: ids.length - prospects.length,
    reasons: tallyReasons(prospects),
    prospects,
  };
}

export async function addCompanyContacts(actor: Actor, campaignId: string, companyIds: unknown, provenance: Provenance) {
  assertScope(actor.scopes, "campaigns:write");
  const companies = cleanIds(companyIds, "company");
  const contacts = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `select c.id from crm.contacts c
       where c.workspace_id = $1 and c.archived_at is null and c.company_id = any($2::uuid[])
       order by c.company_id, c.created_at, c.id
       limit $3`,
      [actor.workspaceId, companies, ADD_MAX + 1],
    );
    return result.rows.map((row) => row.id);
  });
  if (contacts.length === 0) throw new CrmError("invalid_input", "These companies have no contacts.", 400);
  if (contacts.length > ADD_MAX) throw new CrmError("invalid_input", "Add up to 1,000 people at a time.", 400);
  return addProspects(actor, campaignId, contacts, provenance);
}

export type CampaignVariable = { name: string; brief: string; required: boolean; maxLength: number | null };

export function customVariables(campaign: { provider: CampaignProviderId; variables: string[] }) {
  const standard = new Set(campaignProvider(campaign.provider)?.standardVariables ?? []);
  return (campaign.variables ?? []).filter((name) => !standard.has(name));
}

export async function readCampaignVariables(db: Db, campaign: { id: string; provider: CampaignProviderId; variables: string[] }): Promise<CampaignVariable[]> {
  const names = customVariables(campaign);
  if (names.length === 0) return [];
  const stored = await db.query<{ name: string; brief: string; required: boolean; max_length: number | null }>(
    "select name, brief, required, max_length from crm.campaign_variables where campaign_id = $1",
    [campaign.id],
  );
  const byName = new Map(stored.rows.map((row) => [row.name, row]));
  return names.map((name) => {
    const row = byName.get(name);
    return { name, brief: row?.brief ?? "", required: row?.required ?? true, maxLength: row?.max_length ?? null };
  });
}

function cleanVariable(raw: unknown, allowed: Set<string>): CampaignVariable {
  const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!allowed.has(name)) throw new CrmError("invalid_input", `${name || "That variable"} isn't in this campaign's steps.`, 400);
  const brief = typeof item.brief === "string" ? item.brief.trim() : "";
  if (brief.length > BRIEF_MAX) throw new CrmError("invalid_input", `Keep the brief for ${name} under ${BRIEF_MAX.toLocaleString("en-GB")} characters.`, 400);
  const rawMax = item.maxLength;
  const max = rawMax === null || rawMax === undefined || rawMax === "" ? null : Number(rawMax);
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > MAX_LENGTH_MAX)) {
    throw new CrmError("invalid_input", `Max characters for ${name} is a whole number from 1 to ${MAX_LENGTH_MAX.toLocaleString("en-GB")}.`, 400);
  }
  return { name, brief, required: item.required !== false, maxLength: max };
}

export async function saveCampaignVariables(actor: Actor, campaignId: string, input: unknown, provenance: Provenance): Promise<CampaignVariable[]> {
  assertScope(actor.scopes, "campaigns:write");
  if (actor.type !== "user") throw new CrmError("forbidden", "Only people can change variable briefs.", 403);
  const items = Array.isArray(input) ? input : [];
  return withActor(actor, async (db) => {
    const campaign = await readCampaignTarget(db, actor.workspaceId, campaignId);
    const allowed = new Set(customVariables(campaign));
    const variables = items.map((item) => cleanVariable(item, allowed));
    const before = await readCampaignVariables(db, campaign);
    for (const variable of variables) {
      await db.query(
        `insert into crm.campaign_variables (workspace_id, campaign_id, name, brief, required, max_length, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (campaign_id, name) do update
         set brief = excluded.brief, required = excluded.required, max_length = excluded.max_length, updated_by = excluded.updated_by`,
        [actor.workspaceId, campaign.id, variable.name, variable.brief, variable.required, variable.maxLength, actor.userId],
      );
    }
    const after = await readCampaignVariables(db, campaign);
    await recordAudit(db, actor, PROSPECT_AUDIT_EVENTS.variablesSaved, "campaign", campaign.id, provenance, {
      campaign: campaign.name,
      channel: campaign.channel,
      before,
      after,
    });
    return after;
  });
}

export const LINKEDIN_OUTREACH = ["none", "queued", "invited", "accepted", "replied", "finished"] as const;
export type LinkedinOutreach = (typeof LINKEDIN_OUTREACH)[number];
export const EMAIL_OUTREACH = ["none", "queued", "sent", "opened", "clicked", "replied", "bounced"] as const;
export type EmailOutreach = (typeof EMAIL_OUTREACH)[number];

export type Outreach = { email: EmailOutreach; linkedin: LinkedinOutreach; replied: boolean };

export type OutreachRow = {
  channel: CampaignChannel;
  state: ProspectState;
  replied_at: Date | string | null;
  stopped_at: Date | string | null;
  lead_status: string | null;
  campaign_status: CampaignStatus;
  kinds: string[] | null;
  created_at: Date | string;
};

const FINISHED_LEADS = new Set(["completed", "stopped", "blocked", "unsubscribed", "bounced"]);

function emailStage(row: OutreachRow): EmailOutreach {
  const kinds = new Set(row.kinds ?? []);
  if (row.replied_at || kinds.has("replied")) return "replied";
  if (row.state === "skipped" || row.state === "failed") return "none";
  if (row.lead_status === "bounced" || kinds.has("bounced")) return "bounced";
  if (kinds.has("clicked")) return "clicked";
  if (kinds.has("opened")) return "opened";
  if (kinds.has("sent")) return "sent";
  return "queued";
}

function linkedinStage(row: OutreachRow): LinkedinOutreach {
  const kinds = new Set(row.kinds ?? []);
  if (row.replied_at || kinds.has("replied")) return "replied";
  if (row.state === "skipped" || row.state === "failed") return "none";
  if (kinds.has("invite_accepted")) return "accepted";
  const ended = Boolean(row.stopped_at) || FINISHED_LEADS.has(row.lead_status ?? "") || ["completed", "stopped", "archived"].includes(row.campaign_status);
  if (row.state === "pushed" && ended) return "finished";
  if (kinds.has("invite_sent") || kinds.has("message_sent") || kinds.has("inmail_sent")) return "invited";
  return "queued";
}

function newest(rows: OutreachRow[], channel: CampaignChannel) {
  return rows
    .filter((row) => row.channel === channel)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
}

export function outreachOf(rows: OutreachRow[]): Outreach {
  const email = newest(rows, "email");
  const linkedin = newest(rows, "linkedin");
  return {
    email: email ? emailStage(email) : "none",
    linkedin: linkedin ? linkedinStage(linkedin) : "none",
    replied: rows.some((row) => Boolean(row.replied_at)),
  };
}

export async function contactOutreach(actor: Actor, contactId: string): Promise<Outreach> {
  if (!isUuid(contactId)) return { email: "none", linkedin: "none", replied: false };
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<OutreachRow>(
      `with person as (
         select c.id, c.normalized_email, c.normalized_linkedin from crm.contacts c where c.id = $2 and c.workspace_id = $1
       )
       select k.channel, p.state, p.replied_at, p.stopped_at, p.lead_status, k.status as campaign_status, p.created_at,
              (select array_agg(distinct e.kind) from crm.campaign_events e where e.prospect_id = p.id) as kinds
       from person c
       join crm.campaign_prospects p on p.workspace_id = $1
         and (p.contact_id = c.id or (c.normalized_email is not null and p.email = c.normalized_email) or (c.normalized_linkedin is not null and p.linkedin = c.normalized_linkedin))
       join crm.campaigns k on k.id = p.campaign_id`,
      [actor.workspaceId, contactId],
    );
    return result.rows;
  });
  return outreachOf(rows);
}
