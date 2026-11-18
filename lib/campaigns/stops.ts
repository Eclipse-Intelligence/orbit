import { LeadNotReady, type CampaignProvider, type LeadRef, type ProviderContext } from "@/lib/campaigns/providers";
import type { StopReason } from "@/lib/campaigns/types";
import { timeLeft } from "@/lib/crm/conversations";
import { query } from "@/lib/db/pool";
import { redactedError } from "@/lib/upstream";
import { ServiceBusy } from "@/lib/workflows/limits";

const STOP_BATCH = 200;
const STOP_RESERVE_MS = 8_000;

export type StopRow = {
  prospect_id: string;
  campaign_id: string;
  campaign_external_id: string;
  external_lead_id: string | null;
  email: string | null;
  linkedin: string | null;
  sender_id: string | null;
  stop_reason: StopReason | null;
  pushed_at?: Date | null;
  leads_at?: Date | null;
};

export function absenceProven(row: Pick<StopRow, "pushed_at" | "leads_at">) {
  return Boolean(row.pushed_at && row.leads_at && row.leads_at.getTime() > row.pushed_at.getTime());
}

export async function leadAtProvider(
  workspaceId: string,
  provider: CampaignProvider,
  context: ProviderContext,
  campaignExternalId: string,
  prospectId: string,
  lead: LeadRef,
): Promise<LeadRef | null> {
  if (lead.externalLeadId || !provider.needsLeadId) return lead;
  const found = await provider.findLead(context, campaignExternalId, { email: lead.email, linkedin: lead.linkedin });
  if (!found) return null;
  if (found.externalLeadId) await query("select private.campaign_prospect_lead_id($1, $2, $3)", [workspaceId, prospectId, found.externalLeadId]);
  return { ...lead, externalLeadId: found.externalLeadId ?? lead.externalLeadId };
}

export function refusedByProvider(provider: CampaignProvider, error: unknown) {
  const failure = provider.failure(error);
  if (!failure || failure.status === null) return null;
  return failure.status >= 400 && failure.status < 500 && failure.status !== 429 && !failure.missing ? failure.message : null;
}

async function confirm(workspaceId: string, prospectId: string, status: string) {
  await query("select private.campaign_stop_confirmed($1, $2, $3)", [workspaceId, prospectId, status]);
}

export async function stopAtProvider(workspaceId: string, provider: CampaignProvider, context: ProviderContext, row: StopRow) {
  try {
    const lead = await leadAtProvider(workspaceId, provider, context, row.campaign_external_id, row.prospect_id, {
      externalLeadId: row.external_lead_id,
      email: row.email,
      linkedin: row.linkedin,
      senderId: row.sender_id,
    });
    if (!lead) {
      if (!absenceProven(row)) return false;
      await confirm(workspaceId, row.prospect_id, "stopped");
      return true;
    }
    const status = await provider.stopLead(context, row.campaign_external_id, lead, row.stop_reason ?? "replied");
    await confirm(workspaceId, row.prospect_id, status);
    return true;
  } catch (error) {
    if (error instanceof ServiceBusy) throw error;
    if (error instanceof LeadNotReady) return false;
    const failure = provider.failure(error);
    if (failure?.missing) {
      await confirm(workspaceId, row.prospect_id, "stopped");
      return true;
    }
    const refused = refusedByProvider(provider, error);
    if (refused) {
      await query("select private.campaign_stop_refused($1, $2, $3)", [workspaceId, row.prospect_id, `Couldn't stop at ${provider.name}. ${refused}`]);
      return false;
    }
    if (!failure) console.error(`Couldn't stop a ${provider.name} lead`, redactedError(error));
    return false;
  }
}

export async function processStops(workspaceId: string, provider: CampaignProvider, context: ProviderContext, deadline?: number) {
  const pending = await query<StopRow>("select * from private.campaign_stops_due($1, $2, $3)", [workspaceId, provider.id, STOP_BATCH]);
  let stopped = 0;
  for (const row of pending.rows) {
    if (!timeLeft(deadline, STOP_RESERVE_MS)) break;
    try {
      if (await stopAtProvider(workspaceId, provider, context, row)) stopped += 1;
    } catch (error) {
      if (error instanceof ServiceBusy) break;
      throw error;
    }
  }
  return stopped;
}
