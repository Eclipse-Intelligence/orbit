import { LeadNotReady, type CampaignProvider, type ProviderContext } from "@/lib/campaigns/providers";
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
};

export async function stopAtProvider(workspaceId: string, provider: CampaignProvider, context: ProviderContext, row: StopRow) {
  try {
    const status = await provider.stopLead(
      context,
      row.campaign_external_id,
      { externalLeadId: row.external_lead_id, email: row.email, linkedin: row.linkedin, senderId: row.sender_id },
      row.stop_reason ?? "replied",
    );
    await query("select private.campaign_stop_confirmed($1, $2, $3)", [workspaceId, row.prospect_id, status]);
    return true;
  } catch (error) {
    if (error instanceof ServiceBusy) throw error;
    if (error instanceof LeadNotReady) return false;
    const failure = provider.failure(error);
    if (failure?.rejectedKey) throw error;
    if (failure?.missing) {
      await query("select private.campaign_stop_confirmed($1, $2, $3)", [workspaceId, row.prospect_id, "stopped"]);
      return true;
    }
    if (!failure) console.error(`Couldn't stop a ${provider.name} lead`, redactedError(error));
    return false;
  }
}

export async function processStops(workspaceId: string, provider: CampaignProvider, context: ProviderContext, deadline?: number) {
  const pending = await query<StopRow>("select * from private.campaign_pending_stops($1, $2, $3)", [workspaceId, provider.id, STOP_BATCH]);
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
