import { HEYREACH_CORE_WEBHOOK_EVENTS } from "@/lib/heyreach";
import { createHash } from "node:crypto";
import { ACCOUNT_KEY, campaignProvider, CAMPAIGN_PROVIDER_CLIENTS, type CampaignProvider } from "@/lib/campaigns/providers";
import { listCampaignSenders, saveProviderSenders } from "@/lib/campaigns/senders";
import type { CampaignProviderId, ConnectionView } from "@/lib/campaigns/types";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { recordAudit } from "@/lib/crm/mutate";
import type { Actor, Provenance, UserActor } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { query } from "@/lib/db/pool";
import { campaignWebhookUrlFor } from "@/lib/campaigns/webhook-urls";
import { ServiceBusy } from "@/lib/workflows/limits";

export const KEY_TAKEN = "This key is already connected.";

export function keyFingerprint(provider: CampaignProviderId, key: string) {
  return createHash("sha256").update(`${provider}:${key}`).digest("hex");
}

function providerOrFail(id: string) {
  const provider = campaignProvider(id);
  if (!provider) throw new CrmError("invalid_input", "Pick a campaign tool.", 400, { field: "provider" });
  return provider;
}

function isAdmin(actor: Actor): actor is UserActor {
  return actor.type === "user" && (actor.role === "owner" || actor.role === "admin");
}

function assertAdmin(actor: Actor, provider: CampaignProvider): asserts actor is UserActor {
  if (!isAdmin(actor)) throw new CrmError("forbidden", `Only an owner or admin can connect ${provider.name}.`, 403);
}

function cleanKey(raw: string) {
  const key = raw.trim();
  if (!key) throw new CrmError("invalid_input", "Paste the API key.", 400, { field: "key" });
  if (key.length > 500 || /\s/.test(key)) throw new CrmError("invalid_input", "That doesn't look like an API key.", 400, { field: "key" });
  return key;
}

async function checkKey(provider: CampaignProvider, key: string, workspaceId: string, fetchImpl?: typeof fetch) {
  try {
    return await provider.checkKey({ key, workspaceId, fetchImpl });
  } catch (error) {
    if (error instanceof ServiceBusy) throw new CrmError("rate_limited", `${provider.name} is busy. Try again in a minute.`, 429);
    const failure = provider.failure(error);
    if (failure?.rejectedKey) throw new CrmError("invalid_input", `${provider.name} rejected the key.`, 400, { field: "key" });
    if (failure?.message === ACCOUNT_KEY) throw new CrmError("invalid_input", ACCOUNT_KEY, 400, { field: "key" });
    if (failure) throw new CrmError("upstream_failed", failure.message, 502);
    throw error;
  }
}

function fingerprintClash(error: unknown) {
  return isPgError(error) && error.code === "23505" && error.constraint === "campaign_connections_fingerprint_uidx";
}

export async function saveCampaignConnection(
  actor: Actor,
  providerId: string,
  rawKey: string,
  options: { fetchImpl?: typeof fetch; provenance?: Provenance } = {},
) {
  const provider = providerOrFail(providerId);
  assertAdmin(actor, provider);
  const key = cleanKey(rawKey);
  const fingerprint = keyFingerprint(provider.id, key);
  const taken = await query<{ taken: boolean }>("select private.campaign_key_taken($1, $2, $3) as taken", [provider.id, fingerprint, actor.workspaceId]);
  if (taken.rows[0]?.taken) throw new CrmError("conflict", KEY_TAKEN, 409, { field: "key" });
  const checked = await checkKey(provider, key, actor.workspaceId, options.fetchImpl);
  let connection: { id: string; line: string };
  try {
    connection = await withActor(actor, async (db) => {
      const saved = await db.query<{ id: string }>(
        `insert into crm.campaign_connections (workspace_id, provider, key_encrypted, key_fingerprint, details, connected_by)
         values ($1, $2, $3, $4, $5::jsonb, $6)
         on conflict on constraint campaign_connections_workspace_provider do update
         set key_encrypted = $3, key_fingerprint = $4, details = $5::jsonb, connected_by = $6, last_error = null
         returning id`,
        [actor.workspaceId, provider.id, encryptSecret(key), fingerprint, JSON.stringify(checked.details), actor.userId],
      );
      const id = saved.rows[0].id;
      await recordAudit(db, actor, "campaign.connection_changed", "campaign_connection", id, options.provenance ?? { operation: "connect_campaign_tool", source: "web" }, {
        provider: provider.id,
        connected: true,
        campaigns: checked.campaigns,
      });
      return { id, line: provider.connectedLine(checked.details, checked.campaigns) };
    });
  } catch (error) {
    if (fingerprintClash(error)) throw new CrmError("conflict", KEY_TAKEN, 409, { field: "key" });
    throw error;
  }
  if (checked.senders) await saveProviderSenders(actor, provider.id, checked.senders, options.provenance ?? { operation: "connect_campaign_tool", source: "web" });
  return connection;
}

export async function removeCampaignConnection(actor: Actor, providerId: string, options: { provenance?: Provenance } = {}) {
  const provider = providerOrFail(providerId);
  assertAdmin(actor, provider);
  const removed = await withActor(actor, async (db) => {
    const removed = await db.query<{ id: string }>(
      "delete from crm.campaign_connections where workspace_id = $1 and provider = $2 returning id",
      [actor.workspaceId, provider.id],
    );
    const id = removed.rows[0]?.id;
    if (!id) return false;
    await recordAudit(db, actor, "campaign.connection_changed", "campaign_connection", id, options.provenance ?? { operation: "disconnect_campaign_tool", source: "web" }, {
      provider: provider.id,
      connected: false,
    });
    return true;
  });
  if (removed) await query("select private.campaign_forget_webhooks($1, $2)", [actor.workspaceId, provider.id]);
  return removed;
}

async function keyHint(workspaceId: string, provider: CampaignProviderId) {
  const stored = await query<{ key: string | null }>("select private.campaign_connection_key($1, $2) as key", [workspaceId, provider]);
  const encrypted = stored.rows[0]?.key;
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted).slice(-4);
  } catch {
    return null;
  }
}

export async function campaignConnectionViews(actor: Actor): Promise<ConnectionView[]> {
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<{ provider: CampaignProviderId; details: Record<string, unknown>; last_synced_at: Date | null; last_error: string | null; campaigns: number; webhook_failed: boolean }>(
      `select c.provider, c.details, c.last_synced_at, c.last_error,
              (select count(*)::int from crm.campaigns k where k.workspace_id = c.workspace_id and k.provider = c.provider) as campaigns,
              ((c.details #>> '{webhooks,failedAt}' is not null and not (coalesce(c.details #> '{webhooks,events}', '{}'::jsonb) ?& $2::text[]))
                or exists (select 1 from crm.campaigns k where k.workspace_id = c.workspace_id and k.provider = c.provider and k.sync_state ? 'webhookFailedAt')) as webhook_failed
       from crm.campaign_connections c
       where c.workspace_id = $1`,
      [actor.workspaceId, HEYREACH_CORE_WEBHOOK_EVENTS],
    );
    return result.rows;
  });
  const canAdmin = isAdmin(actor);
  const views: ConnectionView[] = [];
  for (const provider of Object.values(CAMPAIGN_PROVIDER_CLIENTS)) {
    const row = rows.find((item) => item.provider === provider.id);
    views.push(await connectionView(actor, provider, row, canAdmin));
  }
  return views;
}

async function connectionView(
  actor: Actor,
  provider: CampaignProvider,
  row: { details: Record<string, unknown>; last_synced_at: Date | null; last_error: string | null; campaigns: number; webhook_failed: boolean } | undefined,
  canAdmin: boolean,
): Promise<ConnectionView> {
  if (!row) return { provider: provider.id, connected: false, line: null, lastSyncedAt: null, lastError: null, keyHint: null, canAdmin, webhookUrl: null };
  const campaigns = row.campaigns || (typeof row.details.campaigns === "number" ? row.details.campaigns : 0);
  return {
    provider: provider.id,
    connected: true,
    line: provider.connectedLine(row.details, campaigns),
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastError: row.last_error,
    keyHint: canAdmin ? await keyHint(actor.workspaceId, provider.id) : null,
    canAdmin,
    webhookUrl: canAdmin && row.webhook_failed ? await campaignWebhookUrlFor(actor, provider.id) : null,
    ...(provider.listSenders ? { senders: await listCampaignSenders(actor, provider.id) } : {}),
  };
}

export type ConnectionState = { provider: CampaignProviderId; lastSyncedAt: string | null; lastError: string | null };

export async function connectionStates(actor: Actor): Promise<ConnectionState[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ provider: CampaignProviderId; last_synced_at: Date | null; last_error: string | null }>(
      "select provider, last_synced_at, last_error from crm.campaign_connections where workspace_id = $1 order by provider",
      [actor.workspaceId],
    );
    return result.rows.map((row) => ({ provider: row.provider, lastSyncedAt: row.last_synced_at?.toISOString() ?? null, lastError: row.last_error }));
  });
}

export async function connectedProviders(actor: Actor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ provider: CampaignProviderId }>("select provider from crm.campaign_connections where workspace_id = $1", [actor.workspaceId]);
    return result.rows.map((row) => row.provider);
  });
}
