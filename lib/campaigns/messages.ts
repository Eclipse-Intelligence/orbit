import type { ProviderMessage } from "@/lib/campaigns/providers";
import type { CampaignChannel } from "@/lib/campaigns/types";
import { createActivityInDb } from "@/lib/crm/activities";
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

export async function saveThread(prospectId: string, messages: ProviderMessage[], options: { replyEvents: boolean; handled: boolean }): Promise<SavedMessage[]> {
  if (messages.length === 0) return [];
  const result = await query<{ message_id: string; direction: "inbound" | "outbound"; automatic: boolean; sent_at: Date; event_id: string | null }>(
    "select * from private.campaign_sync_messages($1, $2::jsonb, $3, $4)",
    [prospectId, JSON.stringify(messages.map(messageJson)), options.replyEvents, options.handled],
  );
  return result.rows.map((row) => ({ messageId: row.message_id, direction: row.direction, automatic: row.automatic, sentAt: row.sent_at.toISOString(), eventId: row.event_id }));
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
    "select id from crm.activities where workspace_id = $1 and metadata->>'campaignMessageId' = $2 limit 1",
    [actor.workspaceId, message.id],
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

export const FILABLE_SQL = `select m.id, m.direction, m.channel, m.body, m.subject, m.sent_at as "sentAt", p.contact_id as "contactId",
    m.campaign_id as "campaignId", k.name as "campaignName", m.prospect_id as "prospectId"
  from crm.campaign_messages m
  join crm.campaign_prospects p on p.id = m.prospect_id
  join crm.campaigns k on k.id = m.campaign_id`;
