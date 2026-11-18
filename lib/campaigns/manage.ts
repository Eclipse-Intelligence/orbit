import { auditJson } from "@/lib/campaigns/audit";
import { connectedContext, providerError, type ProviderOptions } from "@/lib/campaigns/context";
import { fireCampaignEvents } from "@/lib/campaigns/events";
import type { CampaignProvider, LeadRef, ProviderContext } from "@/lib/campaigns/providers";
import { leadAtProvider, refusedByProvider, stopAtProvider } from "@/lib/campaigns/stops";
import type { CampaignChannel, CampaignProviderId, CampaignStatus, ProspectState } from "@/lib/campaigns/types";
import { scheduleWebhooks, withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";
import { ServiceBusy } from "@/lib/workflows/limits";

export const CAMPAIGN_AUDIT_EVENTS = {
  paused: "campaign.paused",
  resumed: "campaign.resumed",
  prospectPaused: "campaign.prospect_paused",
  prospectResumed: "campaign.prospect_resumed",
  prospectRemoved: "campaign.prospect_removed",
  categoryChanged: "campaign.category_changed",
  replySent: "campaign.reply_sent",
} as const;

const CATEGORY_MAX = 100;

type ManageOptions = ProviderOptions & { provenance?: Provenance };

function web(operation: string, options: ManageOptions): Provenance {
  return options.provenance ?? { operation, source: "web" };
}

type CampaignRef = { id: string; provider: CampaignProviderId; channel: CampaignChannel; external_id: string; name: string; status: CampaignStatus };

async function readCampaignRef(db: Db, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound("campaign");
  const result = await db.query<CampaignRef>(
    "select id, provider, channel, external_id, name, status from crm.campaigns where id = $1 and workspace_id = $2",
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("campaign");
  return row;
}

export type ProspectRef = {
  id: string;
  campaign_id: string;
  contact_id: string | null;
  state: ProspectState;
  external_lead_id: string | null;
  email: string | null;
  linkedin: string | null;
  sender_id: string | null;
  lead_status: string | null;
  category: string | null;
  stop_requested_at: Date | null;
  stopped_at: Date | null;
  provider: CampaignProviderId;
  channel: CampaignChannel;
  campaign_external_id: string;
  campaign_name: string;
  campaign_status: CampaignStatus;
};

export async function readProspectRef(db: Db, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound("prospect");
  const result = await db.query<ProspectRef>(
    `select p.id, p.campaign_id, p.contact_id, p.state, p.external_lead_id, p.email, p.linkedin, p.sender_id, p.lead_status, p.category,
            p.stop_requested_at, p.stopped_at, k.provider, k.channel, k.external_id as campaign_external_id, k.name as campaign_name, k.status as campaign_status
     from crm.campaign_prospects p
     join crm.campaigns k on k.id = p.campaign_id
     where p.id = $1 and p.workspace_id = $2`,
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("prospect");
  return row;
}

export function leadRef(row: Pick<ProspectRef, "external_lead_id" | "email" | "linkedin" | "sender_id">): LeadRef {
  return { externalLeadId: row.external_lead_id, email: row.email, linkedin: row.linkedin, senderId: row.sender_id };
}

export async function setCampaignPaused(actor: Actor, campaignId: string, paused: boolean, options: ManageOptions = {}) {
  assertScope(actor.scopes, "campaigns:write");
  const campaign = await withActor(actor, (db) => readCampaignRef(db, actor, campaignId));
  const want: CampaignStatus = paused ? "paused" : "active";
  if (campaign.status === want) return { status: want };
  if (campaign.status !== "active" && campaign.status !== "paused") {
    throw new CrmError("conflict", paused ? "Only a live campaign can be paused." : "Only a paused campaign can be resumed.", 409);
  }
  const { provider, context } = await connectedContext(actor.workspaceId, campaign.provider, options);
  try {
    await provider.setCampaignStatus(context, campaign.external_id, paused ? "paused" : "active");
  } catch (error) {
    throw providerError(provider, error, paused ? "Couldn't pause the campaign. Try again." : "Couldn't resume the campaign. Try again.");
  }
  const audit = auditJson(actor, paused ? CAMPAIGN_AUDIT_EVENTS.paused : CAMPAIGN_AUDIT_EVENTS.resumed, "campaign", campaign.id, web(paused ? "pause_campaign" : "resume_campaign", options), {
    provider: campaign.provider,
    channel: campaign.channel,
    name: campaign.name,
  });
  const changed = await query<{ changed: boolean }>("select private.campaign_status_set($1, $2, $3, $4::jsonb) as changed", [actor.workspaceId, campaign.id, want, audit]);
  if (changed.rows[0]?.changed) scheduleWebhooks();
  return { status: want };
}

export function notAtProvider(provider: Pick<CampaignProvider, "name">) {
  return new CrmError("conflict", `${provider.name} doesn't have this person in the campaign.`, 409);
}

async function leadFor(actor: Actor, provider: CampaignProvider, context: ProviderContext, prospect: ProspectRef) {
  const lead = await leadAtProvider(actor.workspaceId, provider, context, prospect.campaign_external_id, prospect.id, leadRef(prospect));
  if (!lead) throw notAtProvider(provider);
  return lead;
}

function assertPushed(prospect: ProspectRef) {
  if (prospect.state !== "pushed" || prospect.stopped_at || prospect.stop_requested_at) {
    throw new CrmError("conflict", "This person isn't running in the campaign.", 409);
  }
}

export async function setProspectPaused(actor: Actor, prospectId: string, paused: boolean, options: ManageOptions = {}) {
  assertScope(actor.scopes, "campaigns:write");
  const prospect = await withActor(actor, (db) => readProspectRef(db, actor, prospectId));
  const { provider, context } = await connectedContext(actor.workspaceId, prospect.provider, options);
  const call = paused ? provider.pauseLead : provider.resumeLead;
  if (!call) throw new CrmError("invalid_input", "LinkedIn prospects can't be paused one by one. Remove them, or pause the campaign.", 400);
  assertPushed(prospect);
  const want = paused ? "paused" : "in_progress";
  if (prospect.lead_status === want) return { leadStatus: want };
  try {
    await call(context, prospect.campaign_external_id, await leadFor(actor, provider, context, prospect));
  } catch (error) {
    throw providerError(provider, error, paused ? "Couldn't pause this person. Try again." : "Couldn't resume this person. Try again.");
  }
  const audit = auditJson(
    actor,
    paused ? CAMPAIGN_AUDIT_EVENTS.prospectPaused : CAMPAIGN_AUDIT_EVENTS.prospectResumed,
    "campaign_prospect",
    prospect.id,
    web(paused ? "pause_prospect" : "resume_prospect", options),
    { campaignId: prospect.campaign_id, campaign: prospect.campaign_name, contactId: prospect.contact_id, channel: prospect.channel },
  );
  const changed = await query<{ changed: boolean }>("select private.campaign_prospect_lead_status($1, $2, $3, $4::jsonb) as changed", [actor.workspaceId, prospect.id, want, audit]);
  if (changed.rows[0]?.changed) scheduleWebhooks();
  return { leadStatus: want };
}

export type RemoveResult = { state: "removed" | "stopping" | "stopped" };

export async function removeProspect(actor: Actor, prospectId: string, options: ManageOptions = {}): Promise<RemoveResult> {
  assertScope(actor.scopes, "campaigns:write");
  const prospect = await withActor(actor, (db) => readProspectRef(db, actor, prospectId));
  if (prospect.stopped_at || prospect.state === "skipped" || prospect.state === "failed") throw new CrmError("conflict", "This person is already out of the campaign.", 409);
  const audit = auditJson(actor, CAMPAIGN_AUDIT_EVENTS.prospectRemoved, "campaign_prospect", prospect.id, web("remove_prospect", options), {
    campaignId: prospect.campaign_id,
    campaign: prospect.campaign_name,
    contactId: prospect.contact_id,
    channel: prospect.channel,
  });
  const before = await query<{ state: string | null }>("select private.campaign_prospect_remove($1, $2, $3::jsonb) as state", [actor.workspaceId, prospect.id, audit]);
  if (!before.rows[0]?.state) throw notFound("prospect");
  if (before.rows[0].state === "unchanged") throw new CrmError("conflict", "This person is already out of the campaign.", 409);
  scheduleWebhooks();
  if (prospect.state !== "pushed") return { state: prospect.state === "pushing" ? "stopping" : "removed" };
  try {
    const { provider, context } = await connectedContext(actor.workspaceId, prospect.provider, options);
    const stopped = await stopAtProvider(actor.workspaceId, provider, context, {
      prospect_id: prospect.id,
      campaign_id: prospect.campaign_id,
      campaign_external_id: prospect.campaign_external_id,
      external_lead_id: prospect.external_lead_id,
      email: prospect.email,
      linkedin: prospect.linkedin,
      sender_id: prospect.sender_id,
      stop_reason: "removed",
    });
    return { state: stopped ? "stopped" : "stopping" };
  } catch (error) {
    if (error instanceof ServiceBusy || error instanceof CrmError) return { state: "stopping" };
    throw error;
  }
}

export function cantClear(provider: Pick<CampaignProvider, "name">) {
  return `${provider.name} wouldn't clear the category. Set another one instead.`;
}

function clearedKeys(provider: CampaignProvider, campaignExternalId: string, lead: LeadRef, category: string) {
  const refs: LeadRef[] = [lead, { ...lead, externalLeadId: null }, { ...lead, externalLeadId: null, email: null }];
  return [...new Set(refs.map((ref) => provider.categoryKey(campaignExternalId, ref, category)))];
}

function cleanCategory(value: string | null) {
  if (value === null) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > CATEGORY_MAX) throw new CrmError("invalid_input", `Keep the category under ${CATEGORY_MAX} characters.`, 400, { field: "category" });
  return text;
}

export async function setProspectCategory(actor: Actor, prospectId: string, rawCategory: string | null, options: ManageOptions = {}) {
  assertScope(actor.scopes, "campaigns:write");
  const category = cleanCategory(rawCategory);
  const prospect = await withActor(actor, (db) => readProspectRef(db, actor, prospectId));
  if ((prospect.category ?? null) === category) return { category, fired: false };
  const { provider, context } = await connectedContext(actor.workspaceId, prospect.provider, options);
  let lead = leadRef(prospect);
  const atProvider = prospect.state === "pushed" && (category ? Boolean(provider.setCategory) : Boolean(provider.clearCategory && prospect.category));
  if (atProvider) {
    try {
      lead = await leadFor(actor, provider, context, prospect);
      if (category) await provider.setCategory!(context, prospect.campaign_external_id, lead, category);
      else await provider.clearCategory!(context, prospect.campaign_external_id, lead);
    } catch (error) {
      if (!category && refusedByProvider(provider, error)) throw new CrmError("conflict", cantClear(provider), 409, { field: "category" });
      throw providerError(provider, error, category ? "Couldn't set the category. Try again." : "Couldn't clear the category. Try again.");
    }
  }
  const provenance = web("set_prospect_category", options);
  const payload = { ...(provenance.workflowId ? { sourceWorkflowId: provenance.workflowId } : {}), depth: provenance.depth ?? 0, setInOrbit: true };
  const audit = auditJson(actor, CAMPAIGN_AUDIT_EVENTS.categoryChanged, "campaign_prospect", prospect.id, provenance, {
    campaignId: prospect.campaign_id,
    campaign: prospect.campaign_name,
    contactId: prospect.contact_id,
    channel: prospect.channel,
  });
  const saved = await query<{ changed: boolean; event_id: string | null }>("select * from private.campaign_set_category($1, $2, $3, $4, $5::jsonb, $6::text[], $7::jsonb)", [
    actor.workspaceId,
    prospect.id,
    category,
    category ? provider.categoryKey(prospect.campaign_external_id, lead, category) : null,
    JSON.stringify(payload),
    !category && prospect.category ? clearedKeys(provider, prospect.campaign_external_id, lead, prospect.category) : [],
    audit,
  ]);
  if (saved.rows[0]?.changed) scheduleWebhooks();
  const eventId = saved.rows[0]?.event_id ?? null;
  if (!eventId) return { category, fired: false };
  const fired = await fireCampaignEvents([eventId]);
  await query("select private.campaign_events_handled($1, $2::uuid[])", [prospect.campaign_id, [eventId]]);
  return { category, fired: fired > 0 };
}
