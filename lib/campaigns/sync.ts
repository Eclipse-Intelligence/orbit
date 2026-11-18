import { rejectedKeyLine } from "@/lib/campaigns/context";
import { randomUUID } from "node:crypto";
import { saveThread, threadFetched } from "@/lib/campaigns/messages";
import { campaignProvider, type CampaignProvider, type ProviderCampaign, type ProviderContext, type ProviderEvent, type ProviderLead } from "@/lib/campaigns/providers";
import { processStops } from "@/lib/campaigns/stops";
import { refusedByProvider } from "@/lib/campaigns/stops";
import { liftBlocks, pushBlockList } from "@/lib/campaigns/suppression";
import { campaignWebhookUrl, ensureWebhookSecret } from "@/lib/campaigns/webhook-urls";
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
const HAND_OVER_BATCH = 500;
const REPLY_PAGES = 20;
const REQUESTED_BATCH = 25;
const WEBHOOK_RETRY_MS = 60 * 60_000;
const UNCONFIRMED_WEBHOOK = "registered";
const SEQUENCE_FORMAT = 2;
const STRAY_KEPT = 1_000;
const PROBE_EVERY_MS = 24 * 60 * 60_000;

export type SyncState = {
  sequenceAt?: string;
  sequenceFormat?: number;
  leadStateAt?: string;
  leadStateStarted?: boolean;
  statsAt?: string;
  leadsAt?: string;
  leadsOffset?: number | null;
  missingAt?: string | null;
  eventsAt?: string;
  eventsOffset?: number | null;
  eventsSince?: string | null;
  eventsStartedAt?: string | null;
  repliesSince?: string | null;
  repliesOffset?: number | null;
  repliesStartedAt?: string | null;
  repliesAt?: string;
  strayConversations?: number;
  strayIds?: string[];
  webhookId?: string | null;
  webhooks?: string[];
  webhookFailedAt?: string | null;
  listId?: string | null;
  listOffset?: number | null;
  listAt?: string;
  probedAt?: string | null;
};

export type SyncedEvent = { eventId: string; prospectId: string; contactId: string | null; kind: string; occurredAt: string };

export type SyncedCampaign = { id: string; workspaceId: string; provider: CampaignProviderId; externalId: string; name: string };

export type EventHandler = (
  campaign: SyncedCampaign,
  events: SyncedEvent[],
  actor: UserActor,
  context: ProviderContext,
) => Promise<void | { retry: string[]; busy?: string; syncError?: string }>;

export type CampaignSyncOptions = {
  deadline: number;
  fetchImpl?: typeof fetch;
  workspaceId?: string;
  provider?: CampaignProviderId;
  onEvents?: EventHandler;
};

export type CampaignSyncReport = {
  connections: number;
  campaigns: number;
  prospects: number;
  events: number;
  backfilled: number;
  busy: string[];
  errors: string[];
  threads: number;
  stopped: number;
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
    provider_state: lead.providerState ?? {},
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

export async function saveProviderLeads(campaignId: string, leads: ProviderLead[], handled = true) {
  if (leads.length === 0) return 0;
  const result = await query<{ saved: number }>("select private.campaign_sync_prospects($1, $2::jsonb, $3) as saved", [campaignId, JSON.stringify(leads.map(leadJson)), handled]);
  return result.rows[0]?.saved ?? 0;
}

type EventRow = { event_id: string; prospect_id: string; contact_id: string | null; kind: string; occurred_at: Date };

function syncedEvent(row: EventRow): SyncedEvent {
  return { eventId: row.event_id, prospectId: row.prospect_id, contactId: row.contact_id, kind: row.kind, occurredAt: row.occurred_at.toISOString() };
}

export async function saveProviderEvents(campaignId: string, events: ProviderEvent[], handled: boolean): Promise<SyncedEvent[]> {
  if (events.length === 0) return [];
  const result = await query<EventRow>("select * from private.campaign_sync_events($1, $2::jsonb, $3)", [campaignId, JSON.stringify(events.map(eventJson)), handled]);
  return result.rows.map(syncedEvent);
}

async function handOverEvents(pass: Pass, campaign: SyncedCampaign) {
  const onEvents = pass.options.onEvents;
  if (!onEvents) return;
  while (timeLeft(pass.options.deadline, STEP_RESERVE_MS)) {
    const waiting = await query<EventRow>("select * from private.campaign_claim_events($1, $2)", [campaign.id, HAND_OVER_BATCH]);
    if (waiting.rows.length === 0) return;
    const ids = waiting.rows.map((row) => row.event_id);
    let retry: string[] = [];
    try {
      const outcome = await onEvents(campaign, waiting.rows.map(syncedEvent), pass.actor, pass.context);
      retry = outcome?.retry ?? [];
      if (outcome?.busy) pass.report.busy.push(outcome.busy);
      if (outcome?.syncError) pass.notes.set(campaign.id, outcome.syncError);
    } catch (error) {
      await query("select private.campaign_events_release($1, $2::uuid[])", [campaign.id, ids]).catch(() => undefined);
      throw error;
    }
    await query("select private.campaign_events_handled($1, $2::uuid[])", [campaign.id, ids.filter((id) => !retry.includes(id))]);
    if (waiting.rows.length < HAND_OVER_BATCH || retry.length > 0) return;
  }
}

async function syncReplies(pass: Pass, row: CampaignRow, handled: boolean) {
  const { provider, context, options } = pass;
  if (!provider.readReplies) return true;
  const state = row.sync_state ?? {};
  const since = state.repliesSince ? Date.parse(state.repliesSince) : null;
  const startedAt = state.repliesStartedAt ?? new Date().toISOString();
  const stray = new Set(state.strayIds ?? []);
  let offset: number | null = state.repliesOffset ?? 0;
  const progress = () => saveCampaign(row.id, { syncState: { repliesOffset: offset, repliesStartedAt: startedAt, strayConversations: stray.size, strayIds: [...stray] } });
  const pause = async () => {
    await progress();
    return false;
  };
  for (let pages = 0; offset !== null; pages += 1) {
    if (pages >= REPLY_PAGES || !timeLeft(options.deadline, STEP_RESERVE_MS)) return pause();
    const page = await provider.readReplies(context, row.external_id, offset);
    let fresh = 0;
    for (const thread of page.items) {
      const last = thread.lastMessageAt ? Date.parse(thread.lastMessageAt) : null;
      if (since !== null && last !== null && last < since) continue;
      fresh += 1;
      const found = await query<{ id: string | null }>("select private.campaign_find_prospect($1, $2, $3) as id", [row.id, thread.leadId, thread.linkedin]);
      const prospectId = found.rows[0]?.id;
      if (!prospectId) {
        if (stray.size < STRAY_KEPT) stray.add(thread.conversationId);
        continue;
      }
      const saved = await saveThread(prospectId, thread.messages, { replyEvents: true, handled });
      if (saved.length > 0) pass.report.threads += 1;
    }
    offset = since !== null && fresh === 0 ? null : page.next;
    if (offset !== null) await progress();
  }
  await saveCampaign(row.id, {
    syncState: {
      repliesOffset: null,
      repliesStartedAt: null,
      repliesSince: new Date(Date.parse(startedAt) - EVENT_OVERLAP_MS).toISOString(),
      repliesAt: new Date().toISOString(),
      strayConversations: stray.size,
      strayIds: [...stray],
    },
  });
  return true;
}

export function registeredWebhooks(provider: Pick<CampaignProvider, "id" | "webhookEvents">, state: SyncState) {
  const done = new Set(state.webhooks ?? []);
  const first = provider.webhookEvents[0];
  const placeholder = provider.id === "heyreach" && state.webhookId === UNCONFIRMED_WEBHOOK;
  if (state.webhookId && !placeholder && first) done.add(first);
  if (placeholder && first) done.delete(first);
  return provider.webhookEvents.filter((event) => done.has(event));
}

async function registerWebhook(pass: Pass, row: CampaignRow) {
  const state = row.sync_state ?? {};
  const done = registeredWebhooks(pass.provider, state);
  const missing = pass.provider.webhookEvents.filter((event) => !done.includes(event));
  if (missing.length === 0 || (state.webhookFailedAt && !due(state.webhookFailedAt, WEBHOOK_RETRY_MS, Date.now()))) return;
  const secret = await ensureWebhookSecret(pass.workspaceId, pass.provider.id);
  const url = secret ? campaignWebhookUrl(pass.workspaceId, pass.provider.id, secret) : null;
  if (!url) return;
  let failed = false;
  const refusedHook = async (error: unknown, event: string) => {
    if (error instanceof ServiceBusy || pass.context.signal?.aborted || !timeLeft(pass.options.deadline, 0)) return "stop";
    const failure = pass.provider.failure(error);
    console.error(`Couldn't add the ${pass.provider.name} webhook`, event.slice(0, 200), failure ? failure.message : redactedError(error));
    await saveCampaign(row.id, { syncState: { webhookFailedAt: new Date().toISOString() } });
    failed = true;
    return !failure || failure.status === null || failure.status >= 500 || failure.status === 429 || failure.rejectedKey ? "stop" : "next";
  };
  const firstEvent = pass.provider.webhookEvents[0];
  const remember = (ids: Record<string, string | null>) => {
    done.push(...Object.keys(ids));
    const firstId = Object.hasOwn(ids, firstEvent) ? { webhookId: ids[firstEvent] } : {};
    return saveCampaign(row.id, { syncState: { webhooks: done, ...firstId, ...(failed ? {} : { webhookFailedAt: null }) } });
  };
  if (pass.provider.findWebhooks) {
    if (!timeLeft(pass.options.deadline, STEP_RESERVE_MS)) return;
    try {
      const found = await pass.provider.findWebhooks(pass.context, row.external_id, url, missing);
      if (Object.keys(found).length > 0) await remember(found);
    } catch (error) {
      if (error instanceof ServiceBusy || pass.context.signal?.aborted || !timeLeft(pass.options.deadline, 0)) return;
      const failure = pass.provider.failure(error);
      console.error(`Couldn't read the ${pass.provider.name} webhooks`, failure ? failure.message : redactedError(error));
      await saveCampaign(row.id, { syncState: { webhookFailedAt: new Date().toISOString() } });
      return;
    }
  }
  for (const event of missing.filter((item) => !done.includes(item))) {
    if (!timeLeft(pass.options.deadline, STEP_RESERVE_MS)) return;
    try {
      await remember({ [event]: await pass.provider.registerWebhook(pass.context, row.external_id, url, event) });
    } catch (error) {
      if ((await refusedHook(error, event)) === "stop") return;
    }
  }
}

type RequestedRow = {
  prospect_id: string;
  campaign_id: string;
  campaign_external_id: string;
  sender_ids: string[];
  external_lead_id: string | null;
  email: string | null;
  linkedin: string | null;
  sender_id: string | null;
  requested_at: Date;
};

async function syncRequested(pass: Pass, campaigns: Map<string, CampaignRow>) {
  const touched = new Set<string>();
  while (timeLeft(pass.options.deadline, STEP_RESERVE_MS)) {
    const claimed = await query<RequestedRow>("select * from private.campaign_claim_requested($1, $2, $3)", [pass.workspaceId, pass.provider.id, REQUESTED_BATCH]);
    if (claimed.rows.length === 0) break;
    for (const row of claimed.rows) {
      if (!timeLeft(pass.options.deadline, STEP_RESERVE_MS)) break;
      try {
        const messages = await pass.provider.readThread(pass.context, { externalId: row.campaign_external_id }, {
          externalLeadId: row.external_lead_id,
          email: row.email,
          linkedin: row.linkedin,
          senderId: row.sender_id,
        });
        const campaign = campaigns.get(row.campaign_id);
        await saveThread(row.prospect_id, messages, { replyEvents: pass.provider.repliesFromThreads, handled: !campaign?.backfilled_at || !pass.options.onEvents, fileFor: pass.actor });
        await threadFetched(row.prospect_id, row.requested_at);
        pass.report.threads += 1;
        touched.add(row.campaign_id);
      } catch (error) {
        if (error instanceof ServiceBusy) {
          pass.report.busy.push(`${pass.provider.name}: ${error.message}`);
          return touched;
        }
        const refused = refusedByProvider(pass.provider, error);
        if (refused) {
          await query("select private.campaign_thread_request_done($1, $2)", [row.prospect_id, row.requested_at]);
          pass.report.errors.push(`Couldn't read a thread from ${pass.provider.name}. ${refused}`);
          continue;
        }
        console.error(`Couldn't read a ${pass.provider.name} thread`, redactedError(error));
      }
    }
    if (claimed.rows.length < REQUESTED_BATCH) break;
  }
  return touched;
}

type Pass = {
  provider: CampaignProvider;
  context: ProviderContext;
  workspaceId: string;
  actor: UserActor;
  options: CampaignSyncOptions;
  report: CampaignSyncReport;
  listed: Map<string, ProviderCampaign>;
  notes: Map<string, string>;
  statsBusy: boolean;
};

function statsBusy(error: unknown) {
  return error instanceof ServiceBusy && error.service === "smartlead_stats";
}

async function syncCampaign(pass: Pass, row: CampaignRow) {
  const { provider, context, options, report } = pass;
  const state = row.sync_state ?? {};
  const now = Date.now();
  const backfilling = !row.backfilled_at;
  const live = row.status === "active" || row.status === "paused";
  const room = () => timeLeft(options.deadline, STEP_RESERVE_MS);
  const campaign: SyncedCampaign = { id: row.id, workspaceId: pass.workspaceId, provider: provider.id, externalId: row.external_id, name: row.name };
  if (state.missingAt && !due(state.missingAt, IDLE_EVERY_MS, now)) return;
  const senderIds = pass.listed.get(row.external_id)?.senderIds;
  if (senderIds) await saveCampaign(row.id, { senderIds });
  if (!backfilling) await handOverEvents(pass, campaign);
  if (live && !backfilling) await registerWebhook(pass, row);

  if ((backfilling && !state.sequenceAt) || state.sequenceFormat !== SEQUENCE_FORMAT || due(state.sequenceAt, live ? SEQUENCE_EVERY_MS : IDLE_EVERY_MS, now)) {
    if (!room()) return;
    const steps = await provider.readSequence(context, row.external_id);
    await saveCampaign(row.id, { sequence: steps, variables: provider.variables(steps), syncState: { sequenceAt: new Date().toISOString(), sequenceFormat: SEQUENCE_FORMAT } });
  }

  if (backfilling || live || due(state.statsAt, IDLE_EVERY_MS, now)) {
    if (!room()) return;
    const read = await provider.readStats(context, row.external_id);
    await saveCampaign(row.id, {
      stats: read.stats,
      ...(read.days ? { dayStats: read.days } : {}),
      syncState: { statsAt: new Date().toISOString(), ...(read.listId !== undefined ? { listId: read.listId } : {}) },
    });
    if (read.listId !== undefined) state.listId = read.listId;
  }

  const freshRead = !state.leadStateAt && !state.leadStateStarted;
  const leadsInProgress = typeof state.leadsOffset === "number" && !freshRead;
  let leadsComplete = !leadsInProgress && Boolean(state.leadsAt) && !freshRead;
  let leadsReadNow = false;
  if (freshRead || leadsInProgress || (backfilling && !leadsComplete) || due(state.leadsAt, live ? LEADS_EVERY_MS : IDLE_EVERY_MS, now)) {
    leadsComplete = false;
    let offset = freshRead ? 0 : (state.leadsOffset ?? 0);
    if (freshRead && room()) {
      await saveCampaign(row.id, { syncState: { leadsOffset: 0, leadStateStarted: true } });
    }
    while (room()) {
      const page = await provider.readLeads(context, row.external_id, offset);
      report.prospects += await saveProviderLeads(row.id, page.items, backfilling || !options.onEvents);
      if (page.next === null) {
        const finishedAt = new Date().toISOString();
        await saveCampaign(row.id, { syncState: { leadsOffset: null, leadsAt: finishedAt, leadStateAt: finishedAt, leadStateStarted: null } });
        leadsComplete = true;
        leadsReadNow = true;
        await query("select private.campaign_link_contacts($1, null)", [row.id]).catch((error) =>
          console.error("Couldn't link campaign prospects to contacts", redactedError(error)),
        );
        if (!backfilling) await handOverEvents(pass, campaign);
        break;
      }
      offset = page.next;
      await saveCampaign(row.id, { syncState: { leadsOffset: offset } });
    }
  }

  const listInProgress = typeof state.listOffset === "number";
  let listComplete = !provider.readListLeads || !state.listId || (!listInProgress && Boolean(state.listAt));
  if (provider.readListLeads && state.listId && (listInProgress || leadsReadNow || !state.listAt)) {
    listComplete = false;
    let offset = state.listOffset ?? 0;
    while (room()) {
      const page = await provider.readListLeads(context, state.listId, offset);
      report.prospects += await saveProviderLeads(row.id, page.items, backfilling || !options.onEvents);
      if (page.next === null) {
        await saveCampaign(row.id, { syncState: { listOffset: null, listAt: new Date().toISOString() } });
        listComplete = true;
        await query("select private.campaign_link_contacts($1, null)", [row.id]).catch((error) =>
          console.error("Couldn't link campaign prospects to contacts", redactedError(error)),
        );
        break;
      }
      offset = page.next;
      await saveCampaign(row.id, { syncState: { listOffset: offset } });
    }
  }

  const eventsInProgress = typeof state.eventsOffset === "number";
  let eventsComplete = !eventsInProgress && Boolean(state.eventsAt);
  let eventsReadNow = false;
  if (!pass.statsBusy && (eventsInProgress || backfilling || live || due(state.eventsAt, IDLE_EVERY_MS, now))) {
    eventsComplete = false;
    const startedAt = state.eventsStartedAt ?? new Date().toISOString();
    let offset = state.eventsOffset ?? 0;
    while (room()) {
      let page;
      try {
        page = await provider.readEvents(context, row.external_id, state.eventsSince ?? null, offset);
      } catch (error) {
        if (!statsBusy(error)) throw error;
        pass.statsBusy = true;
        report.busy.push(`${provider.name}: ${(error as ServiceBusy).message}`);
        await saveCampaign(row.id, { syncState: { eventsOffset: offset, eventsStartedAt: startedAt } });
        break;
      }
      if (page.leads && page.leads.length > 0) await saveProviderLeads(row.id, page.leads, backfilling || !options.onEvents);
      const inserted = await saveProviderEvents(row.id, page.items, backfilling || !options.onEvents);
      report.events += inserted.length;
      if (!backfilling && inserted.length > 0) await handOverEvents(pass, campaign);
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
        eventsReadNow = true;
        break;
      }
      offset = page.next;
      await saveCampaign(row.id, { syncState: { eventsOffset: offset, eventsStartedAt: startedAt } });
    }
  }

  if (provider.channel === "email" && room()) {
    const engaged = await query<{ count: number }>("select private.campaign_mark_engaged($1, $2, $3) as count", [
      row.id,
      backfilling ? null : (state.eventsSince ?? null),
      backfilling || !options.onEvents,
    ]);
    if (!backfilling && (engaged.rows[0]?.count ?? 0) > 0) await handOverEvents(pass, campaign);
  }

  let repliesComplete = !provider.readReplies || (!backfilling && Boolean(state.repliesAt));
  let repliesReadNow = !provider.readReplies;
  if (provider.readReplies && (backfilling || live || eventsReadNow || typeof state.repliesOffset === "number" || due(state.repliesAt, IDLE_EVERY_MS, now)) && room()) {
    try {
      repliesComplete = await syncReplies(pass, row, backfilling || !options.onEvents);
      repliesReadNow = repliesComplete;
    } catch (error) {
      const failure = provider.failure(error);
      if (error instanceof ServiceBusy || !failure || failure.rejectedKey || pass.context.signal?.aborted) throw error;
      report.errors.push(`Couldn't read replies from ${provider.name}. ${failure.message}`);
      repliesComplete = true;
    }
    if (!backfilling) await handOverEvents(pass, campaign);
  }

  const handled = backfilling || !options.onEvents;
  const backfillDone = backfilling && leadsComplete && listComplete && eventsComplete && repliesComplete;
  let finishedMarked = false;
  if (room() && (backfillDone || finishedReady({ handled, eventsReadNow, repliesReadNow }))) {
    const finished = await query<{ count: number }>("select private.campaign_mark_finished($1, $2) as count", [row.id, handled]);
    finishedMarked = true;
    if (!backfilling && (finished.rows[0]?.count ?? 0) > 0) await handOverEvents(pass, campaign);
  }

  if (backfillDone && finishedMarked) {
    await saveCampaign(row.id, { backfilled: true });
    report.backfilled += 1;
  }
  const unread = pass.notes.get(row.id) ?? (await query<{ note: string | null }>("select private.campaign_unread_note($1) as note", [row.id])).rows[0]?.note ?? null;
  await saveCampaign(row.id, { syncError: unread, syncState: { missingAt: null } });
  report.campaigns += 1;
}

export function finishedReady(pass: { handled: boolean; eventsReadNow: boolean; repliesReadNow: boolean }) {
  return pass.handled || (pass.eventsReadNow && pass.repliesReadNow);
}

function eventsOrder(row: CampaignRow) {
  const at = row.sync_state?.eventsAt ? Date.parse(row.sync_state.eventsAt) : NaN;
  return Number.isNaN(at) ? 0 : at;
}

async function probeUnlisted(pass: Pass, row: CampaignRow) {
  if (row.status === "archived") return;
  const state = row.sync_state ?? {};
  if (state.probedAt && !due(state.probedAt, PROBE_EVERY_MS, Date.now())) return;
  const probedAt = new Date().toISOString();
  let found;
  try {
    found = await pass.provider.readCampaign(pass.context, row.external_id);
  } catch (error) {
    if (!(error instanceof ServiceBusy) && pass.provider.failure(error) && !pass.context.signal?.aborted) await saveCampaign(row.id, { syncState: { probedAt } });
    throw error;
  }
  if (!found || found.status === "archived") {
    await saveCampaign(row.id, { status: "archived", syncState: { probedAt } });
    return;
  }
  await saveCampaign(row.id, { syncState: { probedAt } });
}

async function syncCampaignSafely(pass: Pass, row: CampaignRow) {
  try {
    await syncCampaign(pass, row);
  } catch (error) {
    if (error instanceof ServiceBusy) {
      pass.report.busy.push(`${pass.provider.name}: ${error.message}`);
      return;
    }
    if (pass.context.signal?.aborted) return;
    const failure = pass.provider.failure(error);
    if (!failure) console.error(`${pass.provider.name} campaign sync failed`, redactedError(error));
    const message = failure?.missing
      ? `${pass.provider.name} can't find this campaign.`
      : (failure?.message ?? `Couldn't sync ${row.name || "a campaign"}. Try again.`);
    pass.report.errors.push(message);
    await saveCampaign(row.id, { syncError: message, ...(failure?.missing ? { syncState: { missingAt: new Date().toISOString() } } : {}) });
  }
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
  const outOfTime = AbortSignal.timeout(Math.max(1_000, options.deadline - Date.now() - STEP_RESERVE_MS));
  try {
    const context: ProviderContext = {
      key: decryptSecret(target.key_encrypted),
      workspaceId: target.workspace_id,
      fetchImpl: options.fetchImpl,
      signal: outOfTime,
      details: target.details ?? {},
    };
    const listed = await provider.listCampaigns(context);
    const senders = provider.listSenders ? await provider.listSenders(context) : null;
    if (senders) await saveProviderSenders(actor, provider.id, senders);
    const rows = await query<CampaignRow>("select * from private.campaign_sync_campaigns($1, $2, $3, $4::jsonb)", [
      target.workspace_id,
      provider.id,
      provider.channel,
      JSON.stringify(listed.map((item) => ({ external_id: item.externalId, name: item.name, status: item.status }))),
    ]);
    const pass: Pass = {
      provider,
      context,
      workspaceId: target.workspace_id,
      actor,
      options,
      report,
      listed: new Map(listed.map((item) => [item.externalId, item])),
      notes: new Map(),
      statsBusy: false,
    };
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    const touched = await syncRequested(pass, byId);
    for (const id of touched) {
      const row = byId.get(id);
      if (!row?.backfilled_at || !timeLeft(options.deadline, STEP_RESERVE_MS)) continue;
      try {
        await handOverEvents(pass, { id: row.id, workspaceId: target.workspace_id, provider: provider.id, externalId: row.external_id, name: row.name });
      } catch (error) {
        if (error instanceof ServiceBusy) {
          report.busy.push(`${provider.name}: ${error.message}`);
          continue;
        }
        console.error(`Couldn't hand over ${row.name || "a campaign"}'s events`, redactedError(error));
        report.errors.push(`Couldn't sync ${row.name || "a campaign"}. Try again.`);
      }
    }
    if (timeLeft(options.deadline, STEP_RESERVE_MS)) report.stopped += await processStops(target.workspace_id, provider, context, options.deadline);
    const ordered = [...rows.rows].sort((a, b) => Number(Boolean(a.backfilled_at)) - Number(Boolean(b.backfilled_at)) || eventsOrder(a) - eventsOrder(b));
    for (const row of ordered) {
      if (!timeLeft(options.deadline, STEP_RESERVE_MS) || outOfTime.aborted) break;
      if (!pass.listed.has(row.external_id)) {
        try {
          await probeUnlisted(pass, row);
        } catch (error) {
          if (error instanceof ServiceBusy) {
            report.busy.push(`${provider.name}: ${error.message}`);
            continue;
          }
          if (outOfTime.aborted) break;
          if (!provider.failure(error)) console.error(`Couldn't check ${row.name || "a campaign"} at ${provider.name}`, redactedError(error));
        }
        continue;
      }
      await syncCampaignSafely(pass, row);
    }
    if (timeLeft(options.deadline, STEP_RESERVE_MS)) report.stopped += await processStops(target.workspace_id, provider, context, options.deadline);
    if (timeLeft(options.deadline, STEP_RESERVE_MS)) await pushBlockList(target.workspace_id, provider, context);
    if (timeLeft(options.deadline, STEP_RESERVE_MS)) await liftBlocks(target.workspace_id, provider, context);
    await finish(target, null, { campaigns: listed.length, ...(senders ? { senders: senders.length } : {}) });
  } catch (error) {
    if (error instanceof ServiceBusy) {
      report.busy.push(`${provider.name}: ${error.message}`);
      return;
    }
    if (outOfTime.aborted) return;
    const failure = provider.failure(error);
    const message = failure?.rejectedKey ? rejectedKeyLine(provider) : (failure?.message ?? `Couldn't sync ${provider.name}. Try again.`);
    if (!failure) console.error(`${provider.name} sync failed`, redactedError(error));
    report.errors.push(message);
    await finish(target, message);
  } finally {
    await query("select private.release_slot($1, $2)", [lockKey, holder]).catch((error) => console.error("Couldn't release the campaign sync lock", redactedError(error)));
  }
}

export async function syncCampaigns(options: CampaignSyncOptions): Promise<CampaignSyncReport> {
  const report: CampaignSyncReport = { connections: 0, campaigns: 0, prospects: 0, events: 0, backfilled: 0, busy: [], errors: [], threads: 0, stopped: 0 };
  const targets = await query<Target>("select * from private.campaign_connection_targets($1)", [options.workspaceId ?? null]);
  for (const target of targets.rows) {
    if (options.provider && target.provider !== options.provider) continue;
    if (!timeLeft(options.deadline, STEP_RESERVE_MS)) break;
    await syncConnection(target, options, report);
  }
  return report;
}
