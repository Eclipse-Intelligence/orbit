import { alertMembers } from "@/lib/alerts";
import { campaignThreadPath } from "@/lib/campaigns/format";
import { FILABLE_SQL, fileMessageActivity, saveThread, threadFetched, type FilableMessage } from "@/lib/campaigns/messages";
import { campaignProvider, type CampaignProvider, type ProviderContext } from "@/lib/campaigns/providers";
import type { SyncedCampaign, SyncedEvent } from "@/lib/campaigns/sync";
import type { CampaignChannel } from "@/lib/campaigns/types";
import { withActor } from "@/lib/crm/context";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { automaticReply } from "@/lib/smartlead";
import { redactedError } from "@/lib/upstream";
import { kickWorkflows } from "@/lib/workflows/events";
import { ServiceBusy } from "@/lib/workflows/limits";

const REPLY_PROVENANCE: Provenance = { operation: "campaign_reply", source: "campaign" };
const MATCH_WINDOW_MS = 24 * 60 * 60_000;
const SNIPPET = 160;

type EventDetail = {
  id: string;
  kind: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
  prospect_id: string;
  contact_id: string | null;
  category: string | null;
  added_by_user_id: string | null;
  sender_id: string | null;
  external_lead_id: string | null;
  email: string | null;
  linkedin: string | null;
  campaign_id: string;
  campaign_name: string;
  campaign_external_id: string;
  channel: CampaignChannel;
  person: string;
  sender_user_id: string | null;
};

async function eventDetails(actor: UserActor, ids: string[]) {
  return withActor(actor, async (db) => {
    const result = await db.query<EventDetail>(
      `select e.id, e.kind, e.occurred_at, e.payload, e.prospect_id, p.contact_id, p.category, p.added_by_user_id, p.sender_id,
              p.external_lead_id, p.email, p.linkedin, k.id as campaign_id, k.name as campaign_name, k.external_id as campaign_external_id, k.channel,
              coalesce(
                nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                nullif(btrim(concat_ws(' ', p.lead->>'firstName', p.lead->>'lastName')), ''),
                c.email, p.email, p.linkedin, 'Someone'
              ) as person,
              s.user_id as sender_user_id
       from crm.campaign_events e
       join crm.campaign_prospects p on p.id = e.prospect_id
       join crm.campaigns k on k.id = e.campaign_id
       left join crm.contacts c on c.id = p.contact_id
       left join crm.campaign_senders s on s.workspace_id = p.workspace_id and s.provider = k.provider
         and s.external_id = coalesce(e.payload->>'senderId', p.sender_id)
       where e.id = any($1::uuid[]) and e.workspace_id = $2
       order by e.occurred_at, e.id`,
      [ids, actor.workspaceId],
    );
    return result.rows;
  });
}

async function refreshForReply(provider: CampaignProvider, context: ProviderContext, event: EventDetail) {
  try {
    const messages = await provider.readThread(context, { externalId: event.campaign_external_id }, {
      externalLeadId: event.external_lead_id,
      email: event.email,
      linkedin: event.linkedin,
      senderId: event.sender_id,
    });
    await saveThread(event.prospect_id, messages, { replyEvents: provider.repliesFromThreads, handled: false });
    await threadFetched(event.prospect_id);
  } catch (error) {
    if (provider.failure(error)?.missing) return;
    if (!(error instanceof ServiceBusy)) console.error(`Couldn't read a ${provider.name} thread after a reply`, redactedError(error));
    throw error;
  }
}

async function replyMessages(actor: UserActor, event: EventDetail): Promise<(FilableMessage & { automatic: boolean })[]> {
  const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : null;
  return withActor(actor, async (db) => {
    const result = await db.query<FilableMessage & { automatic: boolean }>(
      `${FILABLE_SQL.replace('select m.id,', 'select m.automatic, m.id,')}
       where m.prospect_id = $1 and m.workspace_id = $2 and m.direction = 'inbound'
         and (($3::uuid is not null and m.id = $3) or ($3::uuid is null and m.sent_at between $4::timestamptz - make_interval(secs => $5) and $4::timestamptz + make_interval(secs => $5)))
       order by abs(extract(epoch from (m.sent_at - $4::timestamptz))), m.sent_at desc`,
      [event.prospect_id, actor.workspaceId, messageId, event.occurred_at, MATCH_WINDOW_MS / 1000],
    );
    return result.rows;
  });
}

async function owners(workspaceId: string) {
  const result = await query<{ workspace_id: string; user_id: string; role: string }>("select workspace_id, user_id, role from private.background_members()");
  return result.rows.filter((row) => row.workspace_id === workspaceId && row.role === "owner").map((row) => row.user_id);
}

export async function replyRecipients(event: { workspaceId: string; addedBy: string | null; senderUser: string | null; channel: CampaignChannel }) {
  const people = new Set<string>(event.addedBy ? [event.addedBy] : await owners(event.workspaceId));
  if (event.channel === "linkedin" && event.senderUser) people.add(event.senderUser);
  return [...people];
}

function snippet(text: string | null | undefined) {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET - 1).trimEnd()}…` : flat;
}

async function notifyReply(actor: UserActor, event: EventDetail, body: string | null) {
  const recipients = await replyRecipients({ workspaceId: actor.workspaceId, addedBy: event.added_by_user_id, senderUser: event.sender_user_id, channel: event.channel });
  if (recipients.length === 0) return;
  const text = snippet(body);
  try {
    await alertMembers(
      actor,
      recipients,
      {
        source: "campaign",
        key: `campaign-reply:${event.id}`,
        title: `${event.person} replied`,
        body: text ? `${event.campaign_name}: ${text}` : event.campaign_name,
        href: campaignThreadPath(event.prospect_id),
        tag: `campaign:${event.prospect_id}`,
        workspaceId: actor.workspaceId,
      },
      { includeSelf: true },
    );
  } catch (error) {
    console.error("Couldn't tell people about a campaign reply", redactedError(error));
  }
}

async function handleReply(actor: UserActor, provider: CampaignProvider, context: ProviderContext | undefined, event: EventDetail) {
  if (!provider.repliesFromThreads && context) await refreshForReply(provider, context, event);
  const messages = await replyMessages(actor, event);
  const reply = messages[0] ?? null;
  if (reply ? reply.automatic : automaticReply(event.category)) {
    const uncounted = await query<{ done: boolean }>("select private.campaign_reply_uncount($1) as done", [event.id]);
    if (uncounted.rows[0]?.done) return;
  }
  await query("select private.campaign_reply_counted($1)", [event.id]);
  await query("select * from private.campaign_stop_person($1, $2)", [actor.workspaceId, event.prospect_id]);
  const filable = messages.filter((message) => !message.automatic);
  if (filable.length > 0) {
    await withActor(actor, async (db) => {
      for (const message of filable) await fileMessageActivity(db, actor, message, REPLY_PROVENANCE);
    });
  }
  await notifyReply(actor, event, reply?.body ?? null);
}

export async function fireCampaignEvents(ids: string[]) {
  if (ids.length === 0) return 0;
  const result = await query<{ fired: number }>("select private.campaign_fire_events($1::uuid[]) as fired", [ids]);
  const fired = result.rows[0]?.fired ?? 0;
  if (fired > 0) kickWorkflows();
  return fired;
}

export async function handleCampaignEvents(campaign: SyncedCampaign, events: SyncedEvent[], actor: UserActor, context?: ProviderContext) {
  if (events.length === 0) return { retry: [] };
  const provider = campaignProvider(campaign.provider);
  if (!provider) return { retry: [] };
  const details = await eventDetails(actor, events.map((event) => event.eventId));
  const retry: string[] = [];
  let busy: string | undefined;
  for (const event of details) {
    if (event.kind !== "replied") continue;
    if (busy) {
      retry.push(event.id);
      continue;
    }
    try {
      await handleReply(actor, provider, context, event);
    } catch (error) {
      if (error instanceof ServiceBusy) busy = `${provider.name}: ${error.message}`;
      else console.error("Couldn't handle a campaign reply", redactedError(error));
      retry.push(event.id);
    }
  }
  await fireCampaignEvents(events.map((event) => event.eventId).filter((id) => !retry.includes(id)));
  return { retry, busy };
}
