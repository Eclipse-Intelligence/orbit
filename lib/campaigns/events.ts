import { alertMembers } from "@/lib/alerts";
import { campaignThreadPath } from "@/lib/campaigns/format";
import { addedProvenance, FILABLE_SQL, fileAddedActivity, fileMessageActivity, saveThread, threadFetched, type FilableMessage } from "@/lib/campaigns/messages";
import { campaignProvider, type CampaignProvider, type ProviderContext } from "@/lib/campaigns/providers";
import { refusedByProvider } from "@/lib/campaigns/stops";
import { SUPPRESSION_AUDIT_EVENTS } from "@/lib/campaigns/suppression";
import type { SyncedCampaign, SyncedEvent } from "@/lib/campaigns/sync";
import type { CampaignChannel } from "@/lib/campaigns/types";
import { withActor } from "@/lib/crm/context";
import { recordAudit } from "@/lib/crm/mutate";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { automaticReply } from "@/lib/smartlead";
import { redactedError } from "@/lib/upstream";
import { kickWorkflows } from "@/lib/workflows/events";
import { ServiceBusy } from "@/lib/workflows/limits";

const REPLY_PROVENANCE: Provenance = { operation: "campaign_reply", source: "campaign" };
const MATCH_WINDOW_MS = 24 * 60 * 60_000;
const SNIPPET = 160;
export const THREAD_TRIES = 3;

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
  handle_attempts: number;
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
              s.user_id as sender_user_id, e.handle_attempts
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

async function refreshForReply(provider: CampaignProvider, context: ProviderContext, event: EventDetail): Promise<string | null> {
  try {
    const messages = await provider.readThread(context, { externalId: event.campaign_external_id }, {
      externalLeadId: event.external_lead_id,
      email: event.email,
      linkedin: event.linkedin,
      senderId: event.sender_id,
    });
    await saveThread(event.prospect_id, messages, { replyEvents: provider.repliesFromThreads, handled: false });
    await threadFetched(event.prospect_id);
    return null;
  } catch (error) {
    if (error instanceof ServiceBusy) throw error;
    if (provider.failure(error)?.missing) return null;
    const refused = refusedByProvider(provider, error);
    const lastTry = event.handle_attempts + 1 >= THREAD_TRIES;
    if (!refused) console.error(`Couldn't read a ${provider.name} thread after a reply`, redactedError(error));
    if (refused || lastTry) return refused ?? provider.failure(error)?.message ?? `Couldn't read the thread from ${provider.name}.`;
    throw error;
  }
}

async function noteUnreadThread(provider: CampaignProvider, event: EventDetail, reason: string) {
  const line = `Couldn't read ${event.person}'s reply from ${provider.name}. ${reason}`.slice(0, 500);
  await query("select private.campaign_sync_update($1, $2::jsonb)", [event.campaign_id, JSON.stringify({ syncError: line })]).catch((error) =>
    console.error("Couldn't note an unread campaign reply", redactedError(error)),
  );
  await query("select private.campaign_thread_unread($1, $2)", [event.prospect_id, line]).catch((error) =>
    console.error("Couldn't keep an unread campaign reply", redactedError(error)),
  );
  return line;
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

async function members(workspaceId: string) {
  const result = await query<{ workspace_id: string; user_id: string; role: string }>("select workspace_id, user_id, role from private.background_members()");
  return result.rows.filter((row) => row.workspace_id === workspaceId);
}

export async function replyRecipients(event: { workspaceId: string; addedBy: string | null; senderUser: string | null; channel: CampaignChannel }) {
  const team = await members(event.workspaceId);
  const member = (id: string | null): id is string => Boolean(id && team.some((row) => row.user_id === id));
  const people = new Set<string>(member(event.addedBy) ? [event.addedBy] : team.filter((row) => row.role === "owner").map((row) => row.user_id));
  if (event.channel === "linkedin" && member(event.senderUser)) people.add(event.senderUser);
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
  const unread = !provider.repliesFromThreads && context ? await refreshForReply(provider, context, event) : null;
  const note = unread ? await noteUnreadThread(provider, event, unread) : null;
  const messages = await replyMessages(actor, event);
  const reply = messages[0] ?? null;
  if (reply ? reply.automatic : automaticReply(event.category)) {
    const uncounted = await query<{ done: boolean }>("select private.campaign_reply_uncount($1) as done", [event.id]);
    if (uncounted.rows[0]?.done) return note;
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
  return note;
}

async function auditSuppression(actor: UserActor, event: EventDetail) {
  const unsubscribed = event.kind === "unsubscribed";
  await withActor(actor, (db) =>
    recordAudit(
      db,
      actor,
      unsubscribed ? SUPPRESSION_AUDIT_EVENTS.unsubscribed : SUPPRESSION_AUDIT_EVENTS.bounced,
      "campaign_prospect",
      event.prospect_id,
      { operation: unsubscribed ? "campaign_unsubscribe" : "campaign_bounce", source: "campaign" },
      { campaignId: event.campaign_id, campaign: event.campaign_name, contactId: event.contact_id, channel: event.channel, email: event.email, linkedin: unsubscribed ? event.linkedin : null },
    ),
  );
}

async function fileAdded(actor: UserActor, event: EventDetail) {
  if (!event.contact_id) return;
  const workflowId = typeof event.payload.sourceWorkflowId === "string" ? event.payload.sourceWorkflowId : null;
  const depth = typeof event.payload.depth === "number" ? event.payload.depth : 0;
  await withActor(actor, (db) =>
    fileAddedActivity(
      db,
      actor,
      { prospectId: event.prospect_id, contactId: event.contact_id, campaignId: event.campaign_id, campaignName: event.campaign_name },
      addedProvenance({ workflowId, depth }),
    ),
  );
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
  let syncError: string | undefined;
  for (const event of details) {
    if (event.kind === "added") {
      await fileAdded(actor, event).catch((error) => {
        console.error("Couldn't file a campaign add on the timeline", redactedError(error));
        retry.push(event.id);
      });
      continue;
    }
    if (event.kind === "unsubscribed" || event.kind === "bounced") {
      await auditSuppression(actor, event).catch((error) => console.error("Couldn't record a campaign opt-out", redactedError(error)));
      continue;
    }
    if (event.kind !== "replied") continue;
    if (busy) {
      retry.push(event.id);
      continue;
    }
    try {
      syncError = (await handleReply(actor, provider, context, event)) ?? syncError;
    } catch (error) {
      if (error instanceof ServiceBusy) busy = `${provider.name}: ${error.message}`;
      else {
        console.error("Couldn't handle a campaign reply", redactedError(error));
        await query("select private.campaign_events_attempted($1, $2::uuid[])", [event.campaign_id, [event.id]]).catch(() => undefined);
      }
      retry.push(event.id);
    }
  }
  await fireCampaignEvents(events.map((event) => event.eventId).filter((id) => !retry.includes(id)));
  return { retry, busy, syncError };
}
