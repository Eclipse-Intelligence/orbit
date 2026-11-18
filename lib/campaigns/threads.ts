import { connectedContext, providerError, type ProviderOptions } from "@/lib/campaigns/context";
import { leadRef, readProspectRef } from "@/lib/campaigns/manage";
import { saveThread, threadFetched } from "@/lib/campaigns/messages";
import { linkedinReplyPermission } from "@/lib/campaigns/replies";
import { doNotContactIn, type DoNotContact } from "@/lib/campaigns/suppression";
import type { CampaignChannel, CampaignEventKind, CampaignProviderId, ProspectState, StopReason } from "@/lib/campaigns/types";
import { withActor } from "@/lib/crm/context";
import { notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { signalCampaigns } from "@/lib/sync-signals";

const REFRESH_EVERY_MS = 60_000;
export const SENDING_STALE_MS = 5 * 60_000;
const THREAD_MESSAGES = 500;
const TIMELINE_ROWS = 100;

export type ThreadMessage = {
  type: "message";
  id: string;
  prospectId: string;
  campaignId: string;
  campaignName: string;
  channel: CampaignChannel;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string;
  at: string;
  author: string;
  address: string | null;
  sentByUserId: string | null;
  sendState: "sending" | "sent" | "unknown" | "failed" | null;
  sendError: string | null;
  clientKey: string | null;
  automatic: boolean;
};

export type ThreadNote = {
  type: "note";
  id: string;
  kind: "accepted" | "stopped" | "removed";
  text: string;
  prospectId: string;
  campaignId: string;
  campaignName: string;
  channel: CampaignChannel;
  at: string;
};

export type ThreadItem = ThreadMessage | ThreadNote;

export type ThreadCampaignState = "queued" | "running" | "paused" | "replied" | "stopping" | "stopped" | "removed" | "finished" | "skipped" | "failed";

export type ThreadCampaign = {
  prospectId: string;
  campaignId: string;
  name: string;
  channel: CampaignChannel;
  provider: CampaignProviderId;
  state: ThreadCampaignState;
  skipReason: string | null;
  category: string | null;
  sender: string | null;
  canPause: boolean;
  canResume: boolean;
  canRemove: boolean;
};

export type ReplyOption = {
  channel: CampaignChannel;
  prospectId: string;
  campaignName: string;
  canReply: boolean;
  reason: string | null;
  senderName: string | null;
};

export type ThreadVariable = { name: string; value: string; source: string | null };

export type ProspectThread = {
  prospectId: string;
  person: { name: string; contactId: string | null; companyName: string | null; email: string | null; linkedin: string | null };
  category: string | null;
  items: ThreadItem[];
  campaigns: ThreadCampaign[];
  replyOptions: ReplyOption[];
  defaultChannel: CampaignChannel;
  variables: ThreadVariable[];
  fetchedAt: string | null;
  doNotContact: DoNotContact | null;
};

type PersonRow = {
  id: string;
  campaign_id: string;
  campaign_name: string;
  channel: CampaignChannel;
  provider: CampaignProviderId;
  campaign_status: string;
  state: ProspectState;
  skip_reason: string | null;
  lead_status: string | null;
  category: string | null;
  replied_at: Date | null;
  stop_requested_at: Date | null;
  stopped_at: Date | null;
  stop_reason: StopReason | null;
  contact_id: string | null;
  email: string | null;
  linkedin: string | null;
  values: Record<string, unknown>;
  sources: Record<string, unknown>;
  thread_fetched_at: Date | null;
  sender_name: string | null;
  name: string;
  company_name: string | null;
  created_at: Date;
};

const PERSON_SQL = `with source as (
    select p.id, p.contact_id, p.email, p.linkedin, c.normalized_email, c.normalized_linkedin
    from crm.campaign_prospects p
    left join crm.contacts c on c.id = p.contact_id
    where p.id = $1 and p.workspace_id = $2
  )
  select p.id, p.campaign_id, k.name as campaign_name, k.channel, k.provider, k.status as campaign_status, p.state, p.skip_reason, p.lead_status,
         p.category, p.replied_at, p.stop_requested_at, p.stopped_at, p.stop_reason, p.contact_id, coalesce(c.email, p.email) as email,
         coalesce(c.normalized_linkedin, p.linkedin) as linkedin, p."values", p.sources, p.thread_fetched_at, p.created_at,
         coalesce(nullif(btrim(pr.full_name), ''), nullif(s.name, '')) as sender_name,
         coalesce(
           nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
           nullif(btrim(concat_ws(' ', p.lead->>'firstName', p.lead->>'lastName')), ''),
           c.email, p.email, p.linkedin, 'Unnamed'
         ) as name,
         coalesce(co.name, nullif(p.lead->>'companyName', '')) as company_name
  from source src
  join crm.campaign_prospects p on p.workspace_id = $2 and (
    p.id = src.id
    or (src.contact_id is not null and p.contact_id = src.contact_id)
    or (src.email is not null and p.email = src.email)
    or (src.linkedin is not null and p.linkedin = src.linkedin)
    or (src.normalized_email is not null and p.email = src.normalized_email)
    or (src.normalized_linkedin is not null and p.linkedin = src.normalized_linkedin)
  )
  join crm.campaigns k on k.id = p.campaign_id
  left join crm.contacts c on c.id = p.contact_id
  left join crm.companies co on co.id = coalesce(p.company_id, c.company_id)
  left join crm.campaign_senders s on s.workspace_id = p.workspace_id and s.provider = k.provider and s.external_id = p.sender_id
  left join crm.profiles pr on pr.id = s.user_id
  order by p.created_at, p.id`;

const FINISHED = new Set(["completed", "stopped", "blocked", "unsubscribed", "bounced"]);

function campaignState(row: PersonRow): ThreadCampaignState {
  if (row.state === "skipped") return "skipped";
  if (row.state === "failed") return "failed";
  if (row.state !== "pushed") return row.stop_requested_at ? "stopping" : "queued";
  if (row.replied_at) return "replied";
  if (row.stopped_at) return row.stop_reason === "removed" ? "removed" : "stopped";
  if (row.stop_requested_at) return "stopping";
  if (row.lead_status === "paused") return "paused";
  if (FINISHED.has(row.lead_status ?? "") || ["completed", "stopped", "archived"].includes(row.campaign_status)) return "finished";
  return "running";
}

async function personRows(db: Db, actor: Actor, prospectId: string) {
  if (!isUuid(prospectId)) throw notFound("prospect");
  const rows = await db.query<PersonRow>(PERSON_SQL, [prospectId, actor.workspaceId]);
  if (!rows.rows.some((row) => row.id === prospectId)) throw notFound("prospect");
  return rows.rows;
}

export async function personProspectIds(db: Db, actor: Actor, prospectId: string) {
  return (await personRows(db, actor, prospectId)).map((row) => row.id);
}

type MessageRow = {
  id: string;
  prospect_id: string;
  campaign_id: string;
  channel: CampaignChannel;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string;
  sent_at: Date;
  from_address: string | null;
  sent_by_user_id: string | null;
  sent_by: string | null;
  sender_name: string | null;
  send_state: ThreadMessage["sendState"];
  send_error: string | null;
  client_key: string | null;
  created_at: Date;
  automatic: boolean;
  conversation_id: string | null;
  sender_id: string | null;
  stats_id: string | null;
  provider_message_id: string | null;
};

function variablesOf(row: PersonRow): ThreadVariable[] {
  const values = row.values && typeof row.values === "object" ? row.values : {};
  const sources = row.sources && typeof row.sources === "object" ? row.sources : {};
  const sourceText = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(sourceText).find(Boolean) ?? null;
    if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      return typeof item.label === "string" ? item.label : typeof item.url === "string" ? item.url : null;
    }
    return null;
  };
  return Object.entries(values).flatMap(([name, value]) =>
    typeof value === "string" && value.trim() ? [{ name, value, source: sourceText((sources as Record<string, unknown>)[name]) }] : [],
  );
}

export async function getProspectThread(actor: Actor, prospectId: string): Promise<ProspectThread> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const rows = await personRows(db, actor, prospectId);
    const opened = rows.find((row) => row.id === prospectId)!;
    const ids = rows.map((row) => row.id);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const messages = await db.query<MessageRow>(
      `select m.id, m.prospect_id, m.campaign_id, m.channel, m.direction, m.subject, m.body, m.sent_at, m.from_address, m.sent_by_user_id,
              coalesce(nullif(btrim(pr.full_name), ''), pr.email) as sent_by, s.name as sender_name, m.send_state, m.send_error, m.client_key, m.automatic, m.created_at,
              m.conversation_id, m.sender_id, m.stats_id, m.provider_message_id
       from crm.campaign_messages m
       left join crm.profiles pr on pr.id = m.sent_by_user_id
       left join crm.campaigns k on k.id = m.campaign_id
       left join crm.campaign_senders s on s.workspace_id = m.workspace_id and s.provider = k.provider and s.external_id = m.sender_id
       where m.workspace_id = $1 and m.prospect_id = any($2::uuid[])
       order by m.sent_at desc, m.created_at desc
       limit $3`,
      [actor.workspaceId, ids, THREAD_MESSAGES],
    );
    const accepted = await db.query<{ id: string; prospect_id: string; occurred_at: Date }>(
      `select e.id, e.prospect_id, e.occurred_at from crm.campaign_events e
       where e.workspace_id = $1 and e.prospect_id = any($2::uuid[]) and e.kind = 'invite_accepted'`,
      [actor.workspaceId, ids],
    );
    const items: ThreadItem[] = [];
    for (const message of messages.rows) {
      const prospect = byId.get(message.prospect_id)!;
      if (message.send_state === "sending" && Date.now() - message.created_at.getTime() > SENDING_STALE_MS) {
        message.send_state = "unknown";
        message.send_error = "May not have gone.";
      }
      const author =
        message.direction === "inbound" ? prospect.name : (message.sent_by ?? (message.channel === "linkedin" ? (prospect.sender_name ?? message.sender_name) : null) ?? message.from_address ?? "Campaign");
      items.push({
        type: "message",
        id: message.id,
        prospectId: message.prospect_id,
        campaignId: message.campaign_id,
        campaignName: prospect.campaign_name,
        channel: message.channel,
        direction: message.direction,
        subject: message.subject,
        body: message.body,
        at: message.sent_at.toISOString(),
        author: author ?? "Campaign",
        address: message.channel === "email" ? message.from_address : null,
        sentByUserId: message.sent_by_user_id,
        sendState: message.send_state,
        sendError: message.send_state === "failed" || message.send_state === "unknown" ? message.send_error : null,
        clientKey: actor.type === "user" && message.sent_by_user_id === actor.userId ? message.client_key : null,
        automatic: message.automatic,
      });
    }
    for (const event of accepted.rows) {
      const prospect = byId.get(event.prospect_id)!;
      items.push({ type: "note", id: event.id, kind: "accepted", text: "Accepted", prospectId: prospect.id, campaignId: prospect.campaign_id, campaignName: prospect.campaign_name, channel: prospect.channel, at: event.occurred_at.toISOString() });
    }
    for (const row of rows) {
      if (!row.stop_requested_at || !row.stop_reason) continue;
      items.push({
        type: "note",
        id: `stop:${row.id}`,
        kind: row.stop_reason === "removed" ? "removed" : "stopped",
        text: row.stop_reason === "removed" ? `Removed from ${row.campaign_name}` : `Stopped in ${row.campaign_name}`,
        prospectId: row.id,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        channel: row.channel,
        at: row.stop_requested_at.toISOString(),
      });
    }
    items.sort((a, b) => a.at.localeCompare(b.at) || (a.type === b.type ? 0 : a.type === "message" ? -1 : 1));

    const campaigns: ThreadCampaign[] = rows.map((row) => {
      const state = campaignState(row);
      return {
        prospectId: row.id,
        campaignId: row.campaign_id,
        name: row.campaign_name,
        channel: row.channel,
        provider: row.provider,
        state,
        skipReason: row.skip_reason,
        category: row.category,
        sender: row.channel === "linkedin" ? row.sender_name : null,
        canPause: row.channel === "email" && state === "running",
        canResume: row.channel === "email" && state === "paused",
        canRemove: state === "queued" || state === "running" || state === "paused" || state === "replied",
      };
    });

    const replyOptions: ReplyOption[] = [];
    for (const channel of ["email", "linkedin"] as const) {
      const candidates = rows.filter((row) => row.channel === channel && row.state === "pushed");
      if (candidates.length === 0) continue;
      const lastFrom = (row: PersonRow) => messages.rows.find((message) => message.prospect_id === row.id && message.direction === "inbound")?.sent_at.getTime() ?? 0;
      const lastAny = (row: PersonRow) => messages.rows.find((message) => message.prospect_id === row.id)?.sent_at.getTime() ?? 0;
      const chosen = [...candidates].sort((a, b) => lastFrom(b) - lastFrom(a) || lastAny(b) - lastAny(a) || b.created_at.getTime() - a.created_at.getTime())[0];
      if (channel === "email") {
        replyOptions.push({ channel, prospectId: chosen.id, campaignName: chosen.campaign_name, canReply: actor.type === "user", reason: actor.type === "user" ? null : "Only a person can reply.", senderName: null });
        continue;
      }
      const own = messages.rows
        .filter((message) => message.prospect_id === chosen.id)
        .map((message) => ({ ...message, body: message.body }));
      const permission = await linkedinReplyPermission(db, actor, own);
      replyOptions.push({ channel, prospectId: chosen.id, campaignName: chosen.campaign_name, canReply: permission.canReply, reason: permission.reason, senderName: permission.senderName });
    }
    const latestInbound = messages.rows.find((message) => message.direction === "inbound" && !message.automatic);
    const fetched = rows.map((row) => row.thread_fetched_at?.getTime() ?? 0).reduce((top, value) => Math.max(top, value), 0);
    return {
      prospectId: opened.id,
      person: { name: opened.name, contactId: opened.contact_id, companyName: opened.company_name, email: rows.find((row) => row.email)?.email ?? null, linkedin: rows.find((row) => row.linkedin)?.linkedin ?? null },
      category: opened.category,
      items,
      campaigns,
      replyOptions,
      defaultChannel: latestInbound?.channel ?? opened.channel,
      variables: variablesOf(opened),
      fetchedAt: fetched ? new Date(fetched).toISOString() : null,
      doNotContact: await doNotContactIn(db, actor, { prospectId: opened.id }),
    };
  });
}

export async function refreshProspectThread(actor: Actor, prospectId: string, options: ProviderOptions & { force?: boolean } = {}) {
  assertScope(actor.scopes, "crm:read");
  const rows = await withActor(actor, async (db) => {
    const people = await personRows(db, actor, prospectId);
    const refs = [];
    for (const row of people) {
      if (row.state !== "pushed") continue;
      if (!options.force && row.thread_fetched_at && Date.now() - row.thread_fetched_at.getTime() < REFRESH_EVERY_MS) continue;
      refs.push(await readProspectRef(db, actor, row.id));
    }
    return refs;
  });
  let saved = 0;
  let read = 0;
  let failure: Error | null = null;
  for (const prospect of rows) {
    const { provider, context } = await connectedContext(actor.workspaceId, prospect.provider, options).catch(() => ({ provider: null, context: null }));
    if (!provider || !context) continue;
    try {
      const messages = await provider.readThread(context, { externalId: prospect.campaign_external_id }, leadRef(prospect));
      saved += (await saveThread(prospect.id, messages, { replyEvents: provider.repliesFromThreads, handled: false, fileFor: actor })).length;
      await threadFetched(prospect.id);
      read += 1;
    } catch (error) {
      failure ??= providerError(provider, error, "Couldn't read the conversation. Try again.");
    }
  }
  if (saved > 0) await signalCampaigns(actor.workspaceId);
  if (failure && read === 0) throw failure;
  return { saved, failed: failure ? true : false };
}

export type CampaignLine = {
  prospectId: string;
  campaignId: string;
  campaignName: string;
  channel: CampaignChannel;
  label: string;
  at: string | null;
};

type LineRow = {
  id: string;
  campaign_id: string;
  campaign_name: string;
  channel: CampaignChannel;
  state: ProspectState;
  replied_at: Date | null;
  stop_requested_at: Date | null;
  stopped_at: Date | null;
  stop_reason: string | null;
  last_kind: CampaignEventKind | null;
  last_step: number | null;
  last_at: Date | null;
  active: boolean;
};

const LINE_KINDS = ["sent", "opened", "clicked", "bounced", "invite_sent", "invite_accepted", "message_sent", "inmail_sent"];

function lineLabel(row: LineRow) {
  if (row.replied_at) return "Replied";
  if (row.stopped_at) return row.stop_reason === "removed" ? "Removed" : "Stopped";
  if (row.stop_requested_at) return "Stopping";
  if (row.state !== "pushed") return "Queued";
  switch (row.last_kind) {
    case "invite_accepted":
      return "Accepted";
    case "invite_sent":
      return "Invited";
    case "message_sent":
      return row.last_step ? `Message ${row.last_step} sent` : "Message sent";
    case "inmail_sent":
      return "InMail sent";
    case "sent":
      return row.last_step ? `Step ${row.last_step} sent` : "Sent";
    case "opened":
      return row.last_step ? `Step ${row.last_step} opened` : "Opened";
    case "clicked":
      return row.last_step ? `Step ${row.last_step} clicked` : "Clicked";
    case "bounced":
      return "Bounced";
    default:
      return "Added";
  }
}

export async function contactCampaignLines(actor: Actor, contactId: string): Promise<CampaignLine[]> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(contactId)) return [];
  return withActor(actor, async (db) => {
    const result = await db.query<LineRow>(
      `select p.id, p.campaign_id, k.name as campaign_name, k.channel, p.state, p.replied_at, p.stop_requested_at, p.stopped_at, p.stop_reason,
              last.kind as last_kind, last.step as last_step, last.occurred_at as last_at,
              (p.state in ('queued', 'filling', 'pushing') or (p.state = 'pushed' and p.stopped_at is null and k.status not in ('completed', 'stopped', 'archived')
                and coalesce(p.lead_status, '') not in ('completed', 'stopped', 'blocked', 'unsubscribed', 'bounced'))) as active
       from crm.campaign_prospects p
       join crm.campaigns k on k.id = p.campaign_id
       left join lateral (
         select e.kind, e.step, e.occurred_at from crm.campaign_events e
         where e.prospect_id = p.id and e.kind = any($3::text[])
         order by e.occurred_at desc,
                  case e.kind when 'invite_accepted' then 3 when 'message_sent' then 2 when 'sent' then 2 else 1 end desc,
                  e.step desc nulls last
         limit 1
       ) last on true
       where p.workspace_id = $1 and p.contact_id = $2 and p.state not in ('skipped', 'failed')
       order by coalesce(p.last_event_at, p.created_at) desc, p.id`,
      [actor.workspaceId, contactId, LINE_KINDS],
    );
    return result.rows
      .filter((row) => row.active || row.replied_at)
      .map((row) => ({
        prospectId: row.id,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        channel: row.channel,
        label: lineLabel(row),
        at: (row.replied_at ?? row.last_at)?.toISOString() ?? null,
      }));
  });
}

export type CampaignTimelineRow = {
  id: string;
  kind: CampaignEventKind;
  title: string;
  at: string;
  prospectId: string;
  campaignId: string;
  campaignName: string;
  channel: CampaignChannel;
  detail: string | null;
};

const TIMELINE_KINDS = ["sent", "opened", "clicked", "bounced", "invite_sent", "invite_accepted", "message_sent", "inmail_sent"];

function timelineTitle(kind: string, step: number | null) {
  switch (kind) {
    case "sent":
      return step ? `Step ${step} sent` : "Email sent";
    case "opened":
      return step ? `Step ${step} opened` : "Email opened";
    case "clicked":
      return step ? `Step ${step} clicked` : "Link clicked";
    case "bounced":
      return "Email bounced";
    case "invite_sent":
      return "Invite sent";
    case "invite_accepted":
      return "Invite accepted";
    case "message_sent":
      return step ? `Message ${step} sent` : "Message sent";
    default:
      return "InMail sent";
  }
}

export async function contactCampaignTimeline(actor: Actor, contactId: string, options: { limit?: number } = {}): Promise<CampaignTimelineRow[]> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(contactId)) return [];
  const limit = Math.min(Math.max(1, options.limit ?? TIMELINE_ROWS), TIMELINE_ROWS);
  return withActor(actor, async (db) => {
    const result = await db.query<{
      id: string;
      kind: CampaignEventKind;
      step: number | null;
      occurred_at: Date;
      prospect_id: string;
      campaign_id: string;
      campaign_name: string;
      channel: CampaignChannel;
      mailbox: string | null;
      sender: string | null;
    }>(
      `select e.id, e.kind, e.step, e.occurred_at, e.prospect_id, e.campaign_id, k.name as campaign_name, k.channel,
              (select m.from_address from crm.campaign_messages m
               where m.prospect_id = p.id and m.direction = 'outbound' and m.from_address is not null and m.step is not distinct from e.step
               order by m.sent_at desc limit 1) as mailbox,
              coalesce(nullif(btrim(pr.full_name), ''), nullif(s.name, '')) as sender
       from crm.campaign_events e
       join crm.campaign_prospects p on p.id = e.prospect_id
       join crm.campaigns k on k.id = e.campaign_id
       left join crm.campaign_senders s on s.workspace_id = p.workspace_id and s.provider = k.provider
         and s.external_id = coalesce(e.payload->>'senderId', p.sender_id)
       left join crm.profiles pr on pr.id = s.user_id
       where e.workspace_id = $1 and p.workspace_id = $1 and p.contact_id = $2 and e.kind = any($3::text[])
       order by e.occurred_at desc, e.id
       limit $4`,
      [actor.workspaceId, contactId, TIMELINE_KINDS, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: timelineTitle(row.kind, row.step),
      at: row.occurred_at.toISOString(),
      prospectId: row.prospect_id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      channel: row.channel,
      detail: row.channel === "linkedin" ? row.sender : row.mailbox,
    }));
  });
}
