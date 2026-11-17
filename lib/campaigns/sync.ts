import { randomUUID } from "node:crypto";
import { campaignProvider, type CampaignProvider, type ProviderCampaign, type ProviderContext, type ProviderEvent, type ProviderLead } from "@/lib/campaigns/providers";
import { saveProviderSenders } from "@/lib/campaigns/senders";
import type { CampaignProviderId, CampaignStatus } from "@/lib/campaigns/types";
import { memberActor, timeLeft } from "@/lib/crm/conversations";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { query } from "@/lib/db/pool";
import { redactedError } from "@/lib/upstream";
import { ServiceBusy } from "@/lib/workflows/limits";

export const CAMPAIGN_SYNC_MS = 280_000;
const STEP_RESERVE_MS = 8_000;
const SEQUENCE_EVERY_MS = 60 * 60_000;
const LEADS_EVERY_MS = 60 * 60_000;
const IDLE_EVERY_MS = 24 * 60 * 60_000;
const EVENT_OVERLAP_MS = 10 * 60_000;
const LOCK_SECONDS = 330;

export type SyncState = {
  sequenceAt?: string;
  statsAt?: string;
  leadsAt?: string;
  leadsOffset?: number | null;
  eventsAt?: string;
  eventsOffset?: number | null;
  eventsSince?: string | null;
  eventsStartedAt?: string | null;
};

export type SyncedEvent = { eventId: string; prospectId: string; contactId: string | null; kind: string; occurredAt: string };

export type SyncedCampaign = { id: string; workspaceId: string; provider: CampaignProviderId; externalId: string; name: string };

export type CampaignSyncOptions = {
  deadline: number;
  fetchImpl?: typeof fetch;
  workspaceId?: string;
  onEvents?: (campaign: SyncedCampaign, events: SyncedEvent[], actor: UserActor) => Promise<void>;
};

export type CampaignSyncReport = {
  connections: number;
  campaigns: number;
  prospects: number;
  events: number;
  backfilled: number;
  busy: string[];
  errors: string[];
};

type Target = {
  connection_id: string;
  workspace_id: string;
  provider: string;
  key_encrypted: string;
  key_fingerprint: string;
  connected_by: string | null;
  details: Record<string, unknown>;
};

type CampaignRow = {
  id: string;
  external_id: string;
  name: string;
  status: CampaignStatus;
  backfilled_at: Date | null;
  synced_at: Date | null;
  sync_state: SyncState;
};

type MemberRow = {
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

export async function syncActor(workspaceId: string, connectedBy: string | null) {
  const result = await query<MemberRow>("select workspace_id, workspace_name, user_id, role, email, full_name from private.background_members()");
  const admins = result.rows.filter((row) => row.workspace_id === workspaceId && (row.role === "owner" || row.role === "admin"));
  const chosen = admins.find((row) => row.user_id === connectedBy) ?? admins.find((row) => row.role === "owner") ?? admins[0];
  return chosen ? memberActor(chosen) : null;
}

function due(at: string | undefined, every: number, now: number) {
  if (!at) return true;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) || now - parsed >= every;
}

async function saveCampaign(id: string, patch: Record<string, unknown>) {
  await query("select private.campaign_sync_update($1, $2::jsonb)", [id, JSON.stringify(patch)]);
}

function leadJson(lead: ProviderLead) {
  return {
    external_id: lead.externalId,
    email: lead.email,
    linkedin: lead.linkedin,
    lead: lead.lead,
    lead_status: lead.leadStatus,
    category: lead.category,
    added_at: lead.addedAt,
    sender_id: lead.senderId ?? null,
  };
}

function eventJson(event: ProviderEvent) {
  return {
    external_lead_id: event.externalLeadId,
    email: event.email,
    linkedin: event.linkedin,
    lead: event.lead,
    kind: event.kind,
    step: event.step,
    variant: event.variant,
    occurred_at: event.occurredAt,
    dedupe_key: event.dedupeKey,
    category: event.category,
    payload: event.payload ?? {},
  };
}

export async function saveProviderLeads(campaignId: string, leads: ProviderLead[]) {
  if (leads.length === 0) return 0;
  const result = await query<{ saved: number }>("select private.campaign_sync_prospects($1, $2::jsonb) as saved", [campaignId, JSON.stringify(leads.map(leadJson))]);
  return result.rows[0]?.saved ?? 0;
}

export async function saveProviderEvents(campaignId: string, events: ProviderEvent[]): Promise<SyncedEvent[]> {
  if (events.length === 0) return [];
  const result = await query<{ event_id: string; prospect_id: string; contact_id: string | null; kind: string; occurred_at: Date }>(
    "select * from private.campaign_sync_events($1, $2::jsonb)",
    [campaignId, JSON.stringify(events.map(eventJson))],
  );
  return result.rows.map((row) => ({
    eventId: row.event_id,
    prospectId: row.prospect_id,
    contactId: row.contact_id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
  }));
}

type Pass = {
  provider: CampaignProvider;
  context: ProviderContext;
  workspaceId: string;
  actor: UserActor;
  options: CampaignSyncOptions;
  report: CampaignSyncReport;
  listed: Map<string, ProviderCampaign>;
};

async function syncCampaign(pass: Pass, row: CampaignRow) {
  const { provider, context, options, report } = pass;
  const state = row.sync_state ?? {};
  const now = Date.now();
  const backfilling = !row.backfilled_at;
  const live = row.status === "active" || row.status === "paused";
  const room = () => timeLeft(options.deadline, STEP_RESERVE_MS);
  const campaign: SyncedCampaign = { id: row.id, workspaceId: pass.workspaceId, provider: provider.id, externalId: row.external_id, name: row.name };
  const senderIds = pass.listed.get(row.external_id)?.senderIds;
  if (senderIds) await saveCampaign(row.id, { senderIds });

  if ((backfilling && !state.sequenceAt) || due(state.sequenceAt, live ? SEQUENCE_EVERY_MS : IDLE_EVERY_MS, now)) {
    if (!room()) return;
    const steps = await provider.readSequence(context, row.external_id);
    await saveCampaign(row.id, { sequence: steps, variables: provider.variables(steps), syncState: { sequenceAt: new Date().toISOString() } });
  }

  if (backfilling || live || due(state.statsAt, IDLE_EVERY_MS, now)) {
    if (!room()) return;
    const read = await provider.readStats(context, row.external_id);
    await saveCampaign(row.id, { stats: read.stats, ...(read.days ? { dayStats: read.days } : {}), syncState: { statsAt: new Date().toISOString() } });
  }

  const leadsInProgress = typeof state.leadsOffset === "number";
  let leadsComplete = !leadsInProgress && Boolean(state.leadsAt);
  if (leadsInProgress || (backfilling && !leadsComplete) || due(state.leadsAt, live ? LEADS_EVERY_MS : IDLE_EVERY_MS, now)) {
    leadsComplete = false;
    let offset = state.leadsOffset ?? 0;
    while (room()) {
      const page = await provider.readLeads(context, row.external_id, offset);
      report.prospects += await saveProviderLeads(row.id, page.items);
      if (page.next === null) {
        await query("select private.campaign_link_contacts($1, null)", [row.id]);
        await saveCampaign(row.id, { syncState: { leadsOffset: null, leadsAt: new Date().toISOString() } });
        leadsComplete = true;
        break;
      }
      offset = page.next;
      await saveCampaign(row.id, { syncState: { leadsOffset: offset } });
    }
  }

  const eventsInProgress = typeof state.eventsOffset === "number";
  let eventsComplete = !eventsInProgress && Boolean(state.eventsAt);
  if (eventsInProgress || backfilling || live || due(state.eventsAt, IDLE_EVERY_MS, now)) {
    eventsComplete = false;
    const startedAt = state.eventsStartedAt ?? new Date().toISOString();
    let offset = state.eventsOffset ?? 0;
    while (room()) {
      const page = await provider.readEvents(context, row.external_id, state.eventsSince ?? null, offset);
      const inserted = await saveProviderEvents(row.id, page.items);
      report.events += inserted.length;
      if (!backfilling && inserted.length > 0 && options.onEvents) await options.onEvents(campaign, inserted, pass.actor);
      if (page.next === null) {
        await saveCampaign(row.id, {
          syncState: {
            eventsOffset: null,
            eventsStartedAt: null,
            eventsSince: new Date(Date.parse(startedAt) - EVENT_OVERLAP_MS).toISOString(),
            eventsAt: new Date().toISOString(),
          },
        });
        eventsComplete = true;
        break;
      }
      offset = page.next;
      await saveCampaign(row.id, { syncState: { eventsOffset: offset, eventsStartedAt: startedAt } });
    }
  }

  if (backfilling && leadsComplete && eventsComplete) {
    await saveCampaign(row.id, { backfilled: true });
    report.backfilled += 1;
  }
  report.campaigns += 1;
}

async function finish(target: Target, error: string | null, details?: Record<string, unknown>) {
  await query("select private.campaign_connection_finish($1, $2, $3, $4::jsonb)", [
    target.connection_id,
    target.key_fingerprint,
    error,
    JSON.stringify(details ?? {}),
  ]);
}

async function syncConnection(target: Target, options: CampaignSyncOptions, report: CampaignSyncReport) {
  const provider = campaignProvider(target.provider);
  if (!provider) return;
  const actor = await syncActor(target.workspace_id, target.connected_by);
  if (!actor) {
    await finish(target, "Nobody in the workspace can run the sync.");
    return;
  }
  const lockKey = `campaign-sync:${target.connection_id}`;
  const holder = randomUUID();
  const locked = await query<{ ok: boolean }>("select private.take_slot($1, 1, $2, $3) as ok", [lockKey, holder, LOCK_SECONDS]);
  if (!locked.rows[0]?.ok) return;
  report.connections += 1;
  try {
    const context: ProviderContext = { key: decryptSecret(target.key_encrypted), workspaceId: target.workspace_id, fetchImpl: options.fetchImpl };
    const listed = await provider.listCampaigns(context);
    const senders = provider.listSenders ? await provider.listSenders(context) : null;
    if (senders) await saveProviderSenders(actor, provider.id, senders);
    const rows = await query<CampaignRow>("select * from private.campaign_sync_campaigns($1, $2, $3, $4::jsonb)", [
      target.workspace_id,
      provider.id,
      provider.channel,
      JSON.stringify(listed.map((item) => ({ external_id: item.externalId, name: item.name, status: item.status }))),
    ]);
    const pass: Pass = { provider, context, workspaceId: target.workspace_id, actor, options, report, listed: new Map(listed.map((item) => [item.externalId, item])) };
    for (const row of rows.rows) {
      if (!timeLeft(options.deadline, STEP_RESERVE_MS)) break;
      await syncCampaign(pass, row);
    }
    await finish(target, null, { campaigns: listed.length, ...(senders ? { senders: senders.length } : {}) });
  } catch (error) {
    if (error instanceof ServiceBusy) {
      report.busy.push(`${provider.name}: ${error.message}`);
      return;
    }
    const failure = provider.failure(error);
    const message = failure?.rejectedKey ? `${provider.name} rejected the key. Save a new one.` : (failure?.message ?? `Couldn't sync ${provider.name}. Try again.`);
    if (!failure) console.error(`${provider.name} sync failed`, redactedError(error));
    report.errors.push(message);
    await finish(target, message);
  } finally {
    await query("select private.release_slot($1, $2)", [lockKey, holder]).catch((error) => console.error("Couldn't release the campaign sync lock", redactedError(error)));
  }
}

export async function syncCampaigns(options: CampaignSyncOptions): Promise<CampaignSyncReport> {
  const report: CampaignSyncReport = { connections: 0, campaigns: 0, prospects: 0, events: 0, backfilled: 0, busy: [], errors: [] };
  const targets = await query<Target>("select * from private.campaign_connection_targets($1)", [options.workspaceId ?? null]);
  for (const target of targets.rows) {
    if (!timeLeft(options.deadline, STEP_RESERVE_MS)) break;
    await syncConnection(target, options, report);
  }
  return report;
}
