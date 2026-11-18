import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { handleCampaignEvents } from "@/lib/campaigns/events";
import { prospectEmail } from "@/lib/campaigns/normalize";
import { campaignProvider, type WebhookActions } from "@/lib/campaigns/providers";
import { saveProviderEvents, syncCampaigns } from "@/lib/campaigns/sync";
import type { CampaignProviderId } from "@/lib/campaigns/types";
import { storedWebhookSecret } from "@/lib/campaigns/webhook-urls";
import { isUuid } from "@/lib/crm/mutate";
import { query } from "@/lib/db/pool";
import { webhookShape } from "@/lib/heyreach";
import { signalCampaigns } from "@/lib/sync-signals";
import { redactedError } from "@/lib/upstream";

const MAX_BODY_BYTES = 256 * 1024;
const QUICK_SYNC_MS = 50_000;

function sameSecret(a: string, b: string) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status });
}

export type WebhookOptions = { fetchImpl?: typeof fetch; syncAfter?: boolean };

function syncSoon(workspaceId: string, provider: CampaignProviderId, options: WebhookOptions) {
  if (options.syncAfter === false) return;
  try {
    after(async () => {
      try {
        await syncCampaigns({ workspaceId, provider, deadline: Date.now() + QUICK_SYNC_MS, fetchImpl: options.fetchImpl, onEvents: handleCampaignEvents });
      } catch (error) {
        console.error("Campaign sync after a webhook failed", redactedError(error));
      }
    });
  } catch {}
}

async function knownCampaign(workspaceId: string, providerId: CampaignProviderId, externalId: string) {
  const found = await query<{ campaign_id: string; backfilled: boolean }>("select * from private.campaign_webhook_campaign($1, $2, $3)", [workspaceId, providerId, externalId]);
  return found.rows[0] ?? null;
}

function unrouted(payload: unknown, why: string) {
  console.info(`Campaign webhook ignored: ${why}`, webhookShape(payload).map((field) => field.split(/[=:]/)[0]).join(" ").slice(0, 2000));
  return json({ ignored: true });
}

async function saveWebhookActions(workspaceId: string, providerId: CampaignProviderId, actions: WebhookActions, payload: unknown, receiptKey: string, options: WebhookOptions) {
  if (!actions.campaignExternalId) return unrouted(payload, "no campaign id");
  const campaign = await knownCampaign(workspaceId, providerId, actions.campaignExternalId);
  if (!campaign) return unrouted(payload, "a campaign Orbit doesn't have");
  const saved = await saveProviderEvents(campaign.campaign_id, actions.events, !campaign.backfilled);
  const tagged = Boolean(actions.tags && Object.keys(actions.tags.patch).length > 0);
  if (actions.tags && tagged) {
    await query("select private.campaign_prospect_tags($1, $2, $3, $4, $5::jsonb, $6)", [
      workspaceId,
      providerId,
      actions.campaignExternalId,
      actions.tags.linkedin,
      JSON.stringify(actions.tags.patch),
      actions.tags.positive,
    ]);
  }
  const key = createHash("sha256").update(receiptKey).digest("hex");
  const receipt = await query<{ fresh: boolean }>("select private.campaign_webhook_receipt($1, $2, $3) as fresh", [workspaceId, providerId, key]);
  if (saved.length > 0 || tagged) await signalCampaigns(workspaceId);
  if (saved.length > 0 && campaign.backfilled) syncSoon(workspaceId, providerId, options);
  if (saved.length === 0 && !receipt.rows[0]?.fresh) return json({ duplicate: true });
  return json({ saved: saved.length });
}

export async function handleCampaignWebhook(request: Request, providerId: CampaignProviderId, options: WebhookOptions = {}): Promise<Response> {
  const provider = campaignProvider(providerId);
  if (!provider) return json({ error: "Not found." }, 404);
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("w") ?? "";
  const secret = url.searchParams.get("secret") ?? "";
  if (!isUuid(workspaceId) || !secret) return json({ error: "Unauthorized." }, 401);
  const stored = await storedWebhookSecret(workspaceId, provider.id);
  if (!stored || !sameSecret(stored, secret)) return json({ error: "Unauthorized." }, 401);
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json({ error: "Too large." }, 413);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ignored: true });
  }
  if (provider.id === "heyreach") console.info("HeyReach webhook fields", webhookShape(payload).join(" ").slice(0, 2000));
  const hint = provider.webhookHint(payload, request.headers);
  const actions = provider.webhookActions?.(payload) ?? null;
  if (actions) return saveWebhookActions(workspaceId, provider.id, actions, payload, `${provider.id}-action|${raw}`, options);
  if (!hint) return json({ ignored: true });
  if (provider.id === "heyreach" && hint.campaignId && !(await knownCampaign(workspaceId, provider.id, hint.campaignId))) return unrouted(payload, "a campaign Orbit doesn't have");
  const flagged = await query<{ count: number }>("select private.campaign_request_sync($1, $2, $3, $4, $5, $6) as count", [
    workspaceId,
    provider.id,
    hint.campaignId,
    hint.leadId,
    prospectEmail(hint.email),
    hint.linkedin,
  ]);
  const queued = flagged.rows[0]?.count ?? 0;
  const key = createHash("sha256").update(hint.receiptKey).digest("hex");
  const receipt = await query<{ fresh: boolean }>("select private.campaign_webhook_receipt($1, $2, $3) as fresh", [workspaceId, provider.id, key]);
  if (!receipt.rows[0]?.fresh) return json({ duplicate: true });
  if (queued > 0) syncSoon(workspaceId, provider.id, options);
  return json({ queued });
}
