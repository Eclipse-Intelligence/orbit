import { personProspectIds, workspacePeople } from "@/lib/campaigns/people";
import { CAMPAIGN_CHANNELS, type CampaignChannel } from "@/lib/campaigns/types";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { stripQuoted } from "@/lib/mail/format";
import { signalCampaigns } from "@/lib/sync-signals";

export const CONVERSATION_LIMIT = 200;
export const AGENT_CONVERSATION_LIMIT = 50;
const PREVIEW_MAX = 500;
const QUIET_CATEGORIES = new Set(["not interested", "out of office"]);

export type ConversationCampaign = { id: string; name: string; channel: CampaignChannel };

export type ConversationMessage = { direction: "inbound" | "outbound"; channel: CampaignChannel; text: string; at: string };

export type Conversation = {
  prospectId: string;
  name: string;
  companyName: string | null;
  contactId: string | null;
  category: string | null;
  channels: CampaignChannel[];
  campaigns: ConversationCampaign[];
  lastMessage: ConversationMessage | null;
  messages: number;
  needsReply: boolean;
  unread: boolean;
  doNotContact: boolean;
};

export type ConversationFilters = {
  needsReply?: boolean | null;
  channel?: CampaignChannel | null;
  campaignId?: string | null;
  search?: string | null;
  limit?: number | null;
};

export type ConversationList = { conversations: Conversation[]; needsReply: number; total: number; more: boolean };

type Row = {
  id: string;
  campaign_id: string;
  campaign_name: string;
  channel: CampaignChannel;
  category: string | null;
  contact_id: string | null;
  email: string | null;
  linkedin: string | null;
  normalized_email: string | null;
  normalized_linkedin: string | null;
  contact_email: string | null;
  name: string;
  company_name: string | null;
  messages: number;
  channels: CampaignChannel[];
  last_in: Date | null;
  last_out: Date | null;
  unread: boolean;
  do_not_contact: boolean;
  last_direction: "inbound" | "outbound" | null;
  last_channel: CampaignChannel | null;
  last_body: string | null;
  last_at: Date | null;
};

function rowsSql(withLast: boolean) {
  return `with talked as (
    select m.prospect_id,
           count(*)::int as messages,
           array_agg(distinct m.channel) as channels,
           max(m.sent_at) filter (where m.direction = 'inbound' and not m.automatic) as last_in,
           max(m.sent_at) filter (where m.direction = 'outbound' and coalesce(m.send_state, 'sent') <> 'failed') as last_out,
           max(m.created_at) filter (where m.direction = 'inbound' and not m.automatic) as last_in_stored
    from crm.campaign_messages m
    where m.workspace_id = $1
    group by m.prospect_id
  )
  select p.id, p.campaign_id, k.name as campaign_name, k.channel, p.category, p.contact_id, p.email, p.linkedin,
         c.normalized_email, c.normalized_linkedin, c.email as contact_email,
         coalesce(
           nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
           nullif(btrim(concat_ws(' ', p.lead->>'firstName', p.lead->>'lastName')), ''),
           c.email, p.email, p.linkedin, 'Unnamed'
         ) as name,
         coalesce(co.name, nullif(p.lead->>'companyName', '')) as company_name,
         t.messages, t.channels, t.last_in, t.last_out,
         (t.last_in_stored is not null and t.last_in_stored > coalesce(p.conversation_read_at, '-infinity'::timestamptz)) as unread,
         exists (
           select 1 from crm.suppressions s
           where s.workspace_id = p.workspace_id and s.reason <> 'bounced'
             and ((p.contact_id is not null and s.contact_id = p.contact_id)
               or (s.kind = 'email' and s.value in (p.email, c.normalized_email))
               or (s.kind = 'linkedin' and s.value in (p.linkedin, c.normalized_linkedin)))
         ) as do_not_contact,
         ${withLast ? "last.direction as last_direction, last.channel as last_channel, last.body as last_body, last.sent_at as last_at" : "null as last_direction, null as last_channel, null as last_body, null::timestamptz as last_at"}
  from talked t
  join crm.campaign_prospects p on p.id = t.prospect_id and p.workspace_id = $1
  join crm.campaigns k on k.id = p.campaign_id
  left join crm.contacts c on c.id = p.contact_id
  left join crm.companies co on co.id = coalesce(p.company_id, c.company_id)
  ${withLast
    ? `left join lateral (
    select m.direction, m.channel, left(m.body, 4000) as body, m.sent_at
    from crm.campaign_messages m
    where m.prospect_id = p.id and (m.direction = 'inbound' or coalesce(m.send_state, 'sent') <> 'failed')
    order by m.sent_at desc, m.created_at desc
    limit 1
  ) last on true`
    : ""}`;
}

function time(value: Date | null) {
  return value?.getTime() ?? 0;
}

export function previewText(body: string, channel: CampaignChannel) {
  const text = (channel === "email" ? stripQuoted(body) || body : body).replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : text;
}

export function quietCategory(category: string | null | undefined) {
  return QUIET_CATEGORIES.has((category ?? "").trim().toLowerCase());
}

export function needsReplyNow(input: { lastIn: Date | null; lastOut: Date | null; category: string | null; doNotContact: boolean }) {
  if (!input.lastIn || input.doNotContact || quietCategory(input.category)) return false;
  return !input.lastOut || input.lastIn.getTime() > input.lastOut.getTime();
}

type Person = Conversation & { search: string; campaignIds: Set<string> };

function personOf(rows: Row[]): Person {
  const opened =
    [...rows].filter((row) => row.last_in).sort((a, b) => time(b.last_in) - time(a.last_in))[0] ??
    [...rows].sort((a, b) => time(b.last_at) - time(a.last_at))[0];
  const latest = [...rows].sort((a, b) => time(b.last_at) - time(a.last_at))[0];
  const lastIn = rows.reduce<Date | null>((top, row) => (row.last_in && time(row.last_in) > time(top) ? row.last_in : top), null);
  const lastOut = rows.reduce<Date | null>((top, row) => (row.last_out && time(row.last_out) > time(top) ? row.last_out : top), null);
  const doNotContact = opened.do_not_contact;
  const channels = CAMPAIGN_CHANNELS.filter((channel) => rows.some((row) => row.channels.includes(channel)));
  const campaigns: ConversationCampaign[] = [];
  for (const row of [...rows].sort((a, b) => time(b.last_at) - time(a.last_at))) {
    if (!campaigns.some((item) => item.id === row.campaign_id)) campaigns.push({ id: row.campaign_id, name: row.campaign_name, channel: row.channel });
  }
  const search = rows
    .flatMap((row) => [row.name, row.company_name, row.email, row.contact_email, row.normalized_email, row.linkedin, row.normalized_linkedin])
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    prospectId: opened.id,
    name: opened.name,
    companyName: opened.company_name ?? rows.find((row) => row.company_name)?.company_name ?? null,
    contactId: opened.contact_id ?? rows.find((row) => row.contact_id)?.contact_id ?? null,
    category: opened.category,
    channels,
    campaigns,
    lastMessage:
      latest.last_direction && latest.last_channel && latest.last_at
        ? { direction: latest.last_direction, channel: latest.last_channel, text: previewText(latest.last_body ?? "", latest.last_channel), at: latest.last_at.toISOString() }
        : null,
    messages: rows.reduce((sum, row) => sum + row.messages, 0),
    needsReply: needsReplyNow({ lastIn, lastOut, category: opened.category, doNotContact }),
    unread: rows.some((row) => row.unread),
    doNotContact,
    search,
    campaignIds: new Set(rows.map((row) => row.campaign_id)),
  };
}

function publicConversation(person: Person): Conversation {
  return {
    prospectId: person.prospectId,
    name: person.name,
    companyName: person.companyName,
    contactId: person.contactId,
    category: person.category,
    channels: person.channels,
    campaigns: person.campaigns,
    lastMessage: person.lastMessage,
    messages: person.messages,
    needsReply: person.needsReply,
    unread: person.unread,
    doNotContact: person.doNotContact,
  };
}

function limitOf(value: number | null | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), CONVERSATION_LIMIT);
}

async function people(actor: Actor, withLast: boolean) {
  return withActor(actor, async (db) => {
    const rows = (await db.query<Row>(rowsSql(withLast), [actor.workspaceId])).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return (await workspacePeople(db, actor.workspaceId))
      .map((group) => group.flatMap((key) => (byId.has(key.id) ? [byId.get(key.id)!] : [])))
      .filter((group) => group.length > 0)
      .map(personOf);
  });
}

export async function listConversations(
  actor: Actor,
  filters: ConversationFilters = {},
  options: { fallbackLimit?: number; countInChannel?: boolean } = {},
): Promise<ConversationList> {
  assertScope(actor.scopes, "crm:read");
  const campaignId = filters.campaignId?.trim() || null;
  if (campaignId && !isUuid(campaignId)) throw new CrmError("invalid_input", "Pass campaignId from campaigns view list.", 400, { field: "campaignId" });
  const channel = filters.channel ?? null;
  if (channel && !(CAMPAIGN_CHANNELS as readonly string[]).includes(channel)) throw new CrmError("invalid_input", "channel is email or linkedin.", 400, { field: "channel" });
  const words = (filters.search ?? "").trim().toLowerCase().slice(0, 200).split(/\s+/).filter(Boolean);
  const limit = limitOf(filters.limit, options.fallbackLimit ?? CONVERSATION_LIMIT);
  const scoped = (await people(actor, true)).filter((person) => (!campaignId || person.campaignIds.has(campaignId)) && words.every((word) => person.search.includes(word)));
  const inChannel = scoped.filter((person) => !channel || person.channels.includes(channel));
  const shown = inChannel
    .filter((person) => filters.needsReply === false || filters.needsReply === null || person.needsReply)
    .sort((a, b) => (b.lastMessage?.at ?? "").localeCompare(a.lastMessage?.at ?? "") || a.name.localeCompare(b.name));
  return {
    conversations: shown.slice(0, limit).map(publicConversation),
    needsReply: (options.countInChannel ? inChannel : scoped).filter((person) => person.needsReply).length,
    total: shown.length,
    more: shown.length > limit,
  };
}

export async function conversationsWaiting(actor: Actor) {
  assertScope(actor.scopes, "crm:read");
  return (await people(actor, false)).filter((person) => person.needsReply).length;
}

export async function markConversationRead(actor: Actor, prospectId: string) {
  assertScope(actor.scopes, "crm:read");
  if (actor.type !== "user") return { read: 0 };
  const ids = await withActor(actor, (db) => personProspectIds(db, actor.workspaceId, prospectId));
  const result = await query<{ count: number }>("select private.campaign_conversation_read($1, $2, $3::uuid[]) as count", [actor.workspaceId, actor.userId, ids]);
  const read = result.rows[0]?.count ?? 0;
  if (read > 0) await signalCampaigns(actor.workspaceId);
  return { read };
}
