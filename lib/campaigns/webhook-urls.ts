import { randomBytes } from "node:crypto";
import type { CampaignProviderId } from "@/lib/campaigns/types";
import type { Actor } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { query } from "@/lib/db/pool";
import { siteOrigin } from "@/lib/site-url";

export const WEBHOOK_PATHS: Record<CampaignProviderId, string> = {
  smartlead: "/api/webhooks/smartlead",
  heyreach: "/api/webhooks/heyreach",
};

export async function ensureWebhookSecret(workspaceId: string, provider: CampaignProviderId) {
  const result = await query<{ secret: string | null }>("select private.campaign_webhook_secret($1, $2, $3) as secret", [
    workspaceId,
    provider,
    encryptSecret(randomBytes(24).toString("base64url")),
  ]);
  const encrypted = result.rows[0]?.secret;
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch {
    return null;
  }
}

export async function storedWebhookSecret(workspaceId: string, provider: CampaignProviderId) {
  const result = await query<{ secret: string | null }>("select private.campaign_webhook_check($1, $2) as secret", [workspaceId, provider]);
  const encrypted = result.rows[0]?.secret;
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch {
    return null;
  }
}

export async function campaignWebhookUrlFor(actor: Actor, provider: CampaignProviderId) {
  if (actor.type !== "user" || (actor.role !== "owner" && actor.role !== "admin")) return null;
  const secret = await ensureWebhookSecret(actor.workspaceId, provider);
  return secret ? campaignWebhookUrl(actor.workspaceId, provider, secret) : null;
}

export function campaignWebhookUrl(workspaceId: string, provider: CampaignProviderId, secret: string) {
  const origin = siteOrigin();
  if (!origin) return null;
  const url = new URL(WEBHOOK_PATHS[provider], origin);
  url.searchParams.set("w", workspaceId);
  url.searchParams.set("secret", secret);
  return url.toString();
}
