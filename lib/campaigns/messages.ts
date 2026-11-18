import type { ProviderMessage } from "@/lib/campaigns/providers";
import type { CampaignChannel } from "@/lib/campaigns/types";
import { createActivityInDb } from "@/lib/crm/activities";
import { withActor } from "@/lib/crm/context";
import type { Actor, Provenance } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";

export type SavedMessage = { messageId: string; direction: "inbound" | "outbound"; automatic: boolean; sentAt: string; eventId: string | null };

function messageJson(message: ProviderMessage) {
  return {
    external_id: message.externalId,
    direction: message.direction,
    step: message.step,
    subject: message.subject,
    body: message.body,
    sent_at: message.sentAt,
    conversation_id: message.conversationId,
    sender_id: message.senderId,
    stats_id: message.statsId,
    provider_message_id: message.providerMessageId,
    from_address: message.fromAddress,
    automatic: message.automatic,
    reply_key: message.replyKey,
  };
}

export async function saveThread(
  prospectId: string,
  messages: ProviderMessage[],
  options: { replyEvents: boolean; handled: boolean; fileFor?: Actor },
): Promise<SavedMessage[]> {
  if (messages.length === 0) return [];
  const result = await query<{ message_id: string; direction: "inbound" | "outbound"; automatic: boolean; sent_at: Date; event_id: string | null }>(
    "select * from private.campaign_sync_messages($1, $2::jsonb, $3, $4)",
    [prospectId, JSON.stringify(messages.map(messageJson)), options.replyEvents, options.handled],
  );
  const saved = result.rows.map((row) => ({ messageId: row.message_id, direction: row.direction, automatic: row.automatic, sentAt: row.sent_at.toISOString(), eventId: row.event_id }));
  if (options.fileFor) await fileCountedReplies(options.fileFor, prospectId, saved);
  return saved;
}

export async function fileCountedReplies(actor: Actor, prospectId: string, saved: SavedMessage[]) {
  const inbound = saved.filter((message) => message.direction === "inbound" && !message.automatic).map((message) => message.messageId);
  if (inbound.length === 0) return 0;
  return withActor(actor, async (db) => {
    const counted = await db.query(
      "select 1 from crm.campaign_events e where e.prospect_id = $1 and e.workspace_id = $2 and e.kind = 'replied' and e.counted_at is not null limit 1",
      [prospectId, actor.workspaceId],
    );
    if (counted.rows.length === 0) return 0;
    const found = await db.query<FilableMessage>(`${FILABLE_SQL} where m.id = any($1::uuid[]) and m.workspace_id = $2`, [inbound, actor.workspaceId]);
    for (const message of found.rows) await fileMessageActivity(db, actor, message, { operation: "campaign_reply", source: "campaign" });
    return found.rows.length;
  });
}

export async function threadFetched(prospectId: string, requestedAt: Date | null = null) {
  await query("select private.campaign_thread_fetched($1, $2)", [prospectId, requestedAt]);
}

export type FilableMessage = {
  id: string;
  direction: "inbound" | "outbound";
  channel: CampaignChannel;
  body: string;
  subject: string | null;
  sentAt: Date;
  contactId: string | null;
  campaignId: string;
  campaignName: string;
  prospectId: string;
};

const ACTIVITY_BODY_MAX = 10_000;

function activityTitle(message: FilableMessage) {
  const campaign = message.campaignName || "a campaign";
  return (message.direction === "inbound" ? `Reply to ${campaign}` : `Reply sent in ${campaign}`).slice(0, 200);
}

export async function fileMessageActivity(db: Db, actor: Actor, message: FilableMessage, provenance: Provenance) {
  if (!message.contactId) return null;
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`campaign-activity|${actor.workspaceId}|${message.id}`]);
  const existing = await db.query<{ id: string }>(
    "select id from crm.activities where workspace_id = $1 and contact_id = $3 and metadata->>'campaignMessageId' = $2 limit 1",
    [actor.workspaceId, message.id, message.contactId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const body = message.body.trim().slice(0, ACTIVITY_BODY_MAX) || null;
  const activity = await createActivityInDb(
    db,
    actor,
    {
      type: message.channel === "linkedin" ? "linkedin" : "email",
      title: activityTitle(message),
      body,
      occurredAt: message.sentAt.toISOString(),
      contactId: message.contactId,
      metadata: { campaignMessageId: message.id, campaignId: message.campaignId, prospectId: message.prospectId, direction: message.direction },
    },
    provenance,
  );
  return activity.id;
}

export type AddedProspect = { prospectId: string; contactId: string | null; campaignId: string; campaignName: string };

export function addedProvenance(payload: { workflowId: string | null; depth: number }): Provenance {
  return payload.workflowId
    ? { operation: "campaign_prospect_added", source: "workflow", workflowId: payload.workflowId, depth: payload.depth, sourceUrl: `/workflows/${payload.workflowId}` }
    : { operation: "campaign_prospect_added", source: "campaign" };
}

export async function fileAddedActivity(db: Db, actor: Actor, added: AddedProspect, provenance: Provenance) {
  if (!added.contactId) return null;
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`campaign-added|${actor.workspaceId}|${added.prospectId}`]);
  const existing = await db.query<{ id: string }>(
    "select id from crm.activities where workspace_id = $1 and contact_id = $3 and metadata->>'campaignAddedProspectId' = $2 limit 1",
    [actor.workspaceId, added.prospectId, added.contactId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const activity = await createActivityInDb(
    db,
    actor,
    {
      type: "note",
      title: `Added to ${added.campaignName || "a campaign"}`.slice(0, 200),
      contactId: added.contactId,
      metadata: { campaignAddedProspectId: added.prospectId, campaignId: added.campaignId },
    },
    provenance,
  );
  return activity.id;
}

export const FILABLE_SQL = `select m.id, m.direction, m.channel, m.body, m.subject, m.sent_at as "sentAt", p.contact_id as "contactId",
    m.campaign_id as "campaignId", k.name as "campaignName", m.prospect_id as "prospectId"
  from crm.campaign_messages m
  join crm.campaign_prospects p on p.id = m.prospect_id
  join crm.campaigns k on k.id = m.campaign_id`;
