import { campaignProvider, type CampaignProvider, type ProviderContext } from "@/lib/campaigns/providers";
import { CrmError } from "@/lib/crm/errors";
import { decryptSecret } from "@/lib/crypto/secret";
import { query } from "@/lib/db/pool";
import { ServiceBusy } from "@/lib/workflows/limits";

export type ProviderOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal };

export async function connectedContext(workspaceId: string, providerId: string, options: ProviderOptions = {}): Promise<{ provider: CampaignProvider; context: ProviderContext }> {
  const provider = campaignProvider(providerId);
  if (!provider) throw new CrmError("invalid_input", "Pick a campaign tool.", 400);
  const stored = await query<{ key: string | null }>("select private.campaign_connection_key($1, $2) as key", [workspaceId, provider.id]);
  const encrypted = stored.rows[0]?.key;
  if (!encrypted) throw new CrmError("not_connected", `Connect ${provider.name} in Settings › Tools first.`, 409);
  return { provider, context: { key: decryptSecret(encrypted), workspaceId, fetchImpl: options.fetchImpl, signal: options.signal } };
}

export function providerError(provider: CampaignProvider, error: unknown, fallback: string): CrmError {
  if (error instanceof CrmError) return error;
  if (error instanceof ServiceBusy) return new CrmError("rate_limited", `${provider.name} is busy. Try again in a minute.`, 429);
  const failure = provider.failure(error);
  if (failure?.rejectedKey) return new CrmError("upstream_failed", `${provider.name} rejected the key. Save a new one in Settings › Tools.`, 502);
  if (failure) return new CrmError("upstream_failed", failure.message, 502);
  if (error instanceof Error && error.name === "LeadNotReady") return new CrmError("conflict", `${provider.name} hasn't finished adding this person. Try again after the next sync.`, 409);
  return new CrmError("upstream_failed", fallback, 502);
}

export function mightHaveSent(provider: CampaignProvider, error: unknown) {
  if (error instanceof ServiceBusy || error instanceof CrmError || (error instanceof Error && error.name === "LeadNotReady")) return false;
  const failure = provider.failure(error);
  if (!failure) return true;
  return failure.status === null || failure.status >= 500;
}
