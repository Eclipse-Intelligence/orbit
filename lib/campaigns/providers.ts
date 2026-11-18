import { prospectEmail, prospectLinkedin, splitName } from "@/lib/campaigns/normalize";
import type {
  CampaignChannel,
  CampaignEventKind,
  CampaignProviderId,
  CampaignStats,
  CampaignStatus,
  LeadStatus,
  Mailbox,
  ProviderDay,
  SequenceStep,
  StopReason,
} from "@/lib/campaigns/types";
import {
  addHeyReachLeads,
  checkHeyReachKey,
  createHeyReachWebhook,
  findHeyReachLead,
  HEYREACH_APP,
  HEYREACH_PUSH_BATCH,
  HEYREACH_WEBHOOK_EVENTS,
  HeyReachError,
  heyReachWebhookAction,
  heyReachWebhookHint,
  listHeyReachAccounts,
  listHeyReachCampaigns,
  listHeyReachConversations,
  listHeyReachLeads,
  listHeyReachListLeads,
  readHeyReachCampaign,
  readHeyReachChatroom,
  readHeyReachSequence,
  readHeyReachStats,
  sendHeyReachMessage,
  listHeyReachWebhooks,
  allCampaignsWebhook,
  heyReachWebhookTag,
  setHeyReachCampaignStatus,
  startHeyReachCampaign,
  stopHeyReachLead,
  variablesIn as heyReachVariables,
  type HeyReachConversation,
  type HeyReachLead,
  type HeyReachLeadCounts,
} from "@/lib/heyreach";
import {
  addSmartleadLeads,
  blockSmartleadAddresses,
  clearSmartleadCategory,
  createSmartleadWebhook,
  findSmartleadLead,
  listSmartleadCampaigns,
  listSmartleadCategories,
  listSmartleadLeads,
  pauseSmartleadLead,
  readSmartleadCampaign,
  readSmartleadClient,
  readSmartleadMailboxes,
  readSmartleadSequence,
  readSmartleadStatistics,
  readSmartleadStats,
  readSmartleadThread,
  removeSmartleadLead,
  resumeSmartleadLead,
  sendSmartleadReply,
  setSmartleadCampaignStatus,
  setSmartleadCategory,
  SMARTLEAD_APP,
  SMARTLEAD_PUSH_BATCH,
  SmartleadError,
  smartleadClients,
  SMARTLEAD_WEBHOOK_EVENTS,
  smartleadWebhookHint,
  unblockSmartleadAddress,
  type SmartleadStatRow,
  type WebhookHint,
  variablesIn,
} from "@/lib/smartlead";

export type ProviderContext = {
  key: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  details?: Record<string, unknown>;
  lane?: "push";
};

export const ACCOUNT_KEY = "Use the client's key, not the account key.";

export type ProviderCampaign = { externalId: string; name: string; status: CampaignStatus | null; senderIds?: string[] };

export type ProviderSender = {
  externalId: string;
  name: string;
  email: string | null;
  linkedin: string | null;
  inviteLimit: number | null;
  messageLimit: number | null;
};

export type StatsRead = { stats: CampaignStats; days?: ProviderDay[]; listId?: string | null };

export type LeadProfile = {
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  website?: string | null;
  title?: string | null;
  linkedinUrl?: string | null;
};

export type ProviderLead = {
  externalId: string | null;
  email: string | null;
  linkedin: string | null;
  lead: LeadProfile;
  leadStatus: LeadStatus | null;
  category: string | null;
  addedAt: string | null;
  senderId?: string | null;
  providerState?: ProviderLeadState;
};

export type ProviderLeadState = {
  status?: string | null;
  connection?: string | null;
  messaging?: string | null;
  lastActionAt?: string | null;
  senderName?: string | null;
};

export type ProviderEvent = {
  externalLeadId: string | null;
  email: string | null;
  linkedin: string | null;
  lead: LeadProfile;
  kind: CampaignEventKind;
  step: number | null;
  variant: string | null;
  occurredAt: string;
  dedupeKey: string;
  category: string | null;
  payload?: Record<string, unknown>;
};

export type ProviderPage<T> = { items: T[]; next: number | null; leads?: ProviderLead[] };

export type WebhookTags = { linkedin: string; patch: Record<string, unknown>; positive: boolean };

export type WebhookActions = { campaignExternalId: string | null; events: ProviderEvent[]; tags?: WebhookTags };

export type ConnectionCheck = { details: Record<string, unknown>; campaigns: number; senders?: ProviderSender[] };

export type LeadRef = { externalLeadId: string | null; email: string | null; linkedin: string | null; senderId: string | null };

export type ProviderMessage = {
  externalId: string;
  direction: "inbound" | "outbound";
  step: number | null;
  subject: string | null;
  body: string;
  sentAt: string;
  conversationId: string | null;
  senderId: string | null;
  statsId: string | null;
  providerMessageId: string | null;
  fromAddress: string | null;
  automatic: boolean;
  replyKey: string | null;
};

export type ProviderThread = {
  conversationId: string;
  leadId: string | null;
  linkedin: string | null;
  lastMessageAt: string | null;
  messages: ProviderMessage[];
  tags: string[];
};

export type ReplyTarget = {
  lead: LeadRef;
  conversationId: string | null;
  senderId: string | null;
  statsId: string | null;
  replyTo: { messageId: string | null; sentAt: string; body: string } | null;
};

export type ProviderFailure = { message: string; rejectedKey: boolean; missing: boolean; status: number | null };

export type { WebhookHint };

export type PushLead = {
  key: string;
  email: string | null;
  linkedin: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  website: string | null;
  title: string | null;
  senderId: string | null;
  values: Record<string, string>;
};

export type PushOutcome = { taken: Set<string>; unsure: Set<string> };

export type FoundLead = { externalLeadId: string | null };

export type CampaignProvider = {
  id: CampaignProviderId;
  channel: CampaignChannel;
  name: string;
  standardVariables: readonly string[];
  failure(error: unknown): ProviderFailure | null;
  needsLeadId: boolean;
  checkKey(context: ProviderContext): Promise<ConnectionCheck>;
  connectedLine(details: Record<string, unknown>, campaigns: number): string;
  listCampaigns(context: ProviderContext): Promise<ProviderCampaign[]>;
  readCampaign(context: ProviderContext, externalId: string): Promise<ProviderCampaign | null>;
  readSequence(context: ProviderContext, externalId: string): Promise<SequenceStep[]>;
  variables(steps: SequenceStep[]): string[];
  readStats(context: ProviderContext, externalId: string): Promise<StatsRead>;
  readLeads(context: ProviderContext, externalId: string, offset: number): Promise<ProviderPage<ProviderLead>>;
  readEvents(context: ProviderContext, externalId: string, since: string | null, offset: number): Promise<ProviderPage<ProviderEvent>>;
  readListLeads?(context: ProviderContext, listId: string, offset: number): Promise<ProviderPage<ProviderLead>>;
  readMailboxes?(context: ProviderContext, externalId: string): Promise<Mailbox[]>;
  listSenders?(context: ProviderContext): Promise<ProviderSender[]>;
  campaignUrl(externalId: string): string | null;
  repliesFromThreads: boolean;
  readThread(context: ProviderContext, campaign: { externalId: string }, lead: LeadRef): Promise<ProviderMessage[]>;
  readReplies?(context: ProviderContext, externalId: string, offset: number): Promise<ProviderPage<ProviderThread>>;
  sendReply(context: ProviderContext, campaignExternalId: string, target: ReplyTarget, text: string): Promise<{ providerMessageId: string | null }>;
  setCampaignStatus(context: ProviderContext, externalId: string, status: "paused" | "active"): Promise<void>;
  startCampaign(context: ProviderContext, externalId: string): Promise<void>;
  pauseLead?(context: ProviderContext, campaignExternalId: string, lead: LeadRef): Promise<void>;
  resumeLead?(context: ProviderContext, campaignExternalId: string, lead: LeadRef): Promise<void>;
  stopLead(context: ProviderContext, campaignExternalId: string, lead: LeadRef, reason: StopReason): Promise<LeadStatus>;
  setCategory?(context: ProviderContext, campaignExternalId: string, lead: LeadRef, category: string): Promise<void>;
  clearCategory?(context: ProviderContext, campaignExternalId: string, lead: LeadRef): Promise<void>;
  unblockAddress?(context: ProviderContext, address: string): Promise<number>;
  blockAddresses?(context: ProviderContext, addresses: string[]): Promise<void>;
  categoryKey(campaignExternalId: string, lead: LeadRef, category: string): string;
  webhookEvents: string[];
  registerWebhook?(context: ProviderContext, campaignExternalId: string, url: string, event: string): Promise<string | null>;
  connectionWebhookEvents?: string[];
  findConnectionWebhooks?(context: ProviderContext, url: string): Promise<Record<string, string>>;
  createConnectionWebhook?(context: ProviderContext, url: string, event: string): Promise<string | null>;
  webhookHint(payload: unknown, headers: Headers): WebhookHint | null;
  webhookActions?(payload: unknown): WebhookActions | null;
  pushBatch: number;
  valueLimit: number;
  variableToken(name: string): string;
  pushLeads(context: ProviderContext, campaignExternalId: string, leads: PushLead[]): Promise<PushOutcome>;
  findLead(context: ProviderContext, campaignExternalId: string, lead: { email: string | null; linkedin: string | null }): Promise<FoundLead | null>;
};

export class LeadNotReady extends Error {
  constructor() {
    super("The provider hasn't given this lead an id yet.");
    this.name = "LeadNotReady";
  }
}

function leadIdOf(lead: LeadRef) {
  if (!lead.externalLeadId) throw new LeadNotReady();
  return lead.externalLeadId;
}

function categoryPart(category: string) {
  return category.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);
}

function profileUrl(linkedin: string | null) {
  return linkedin ? `https://www.${linkedin}` : null;
}

function campaignsLine(campaigns: number) {
  return campaigns === 1 ? "1 campaign" : `${campaigns.toLocaleString("en-GB")} campaigns`;
}

function accountsLine(accounts: number) {
  return accounts === 1 ? "1 LinkedIn account" : `${accounts.toLocaleString("en-GB")} LinkedIn accounts`;
}

export function smartleadCategoryKey(campaignId: string, lead: string, category: string) {
  return `smartlead:${campaignId}:${lead}:category:${categoryPart(category)}`;
}

export function smartleadEvents(campaignId: string, rows: SmartleadStatRow[]): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const row of rows) {
    const email = prospectEmail(row.email);
    const lead = row.leadId ?? email;
    if (!lead) continue;
    const base = `smartlead:${campaignId}:${lead}`;
    const step = row.step;
    const shared = {
      externalLeadId: row.leadId,
      email,
      linkedin: null,
      lead: splitName(row.name),
      step,
      variant: row.variant,
      category: row.category,
    };
    const add = (kind: CampaignEventKind, at: string | null, timed: boolean) => {
      if (!at) return;
      events.push({ ...shared, kind, occurredAt: at, dedupeKey: `${base}:${kind}:${step ?? 0}${timed ? `:${at}` : ""}` });
    };
    add("sent", row.sentAt, false);
    add("opened", row.openedAt, true);
    add("clicked", row.clickedAt, true);
    add("replied", row.repliedAt, true);
    if (row.bounced) add("bounced", row.sentAt, false);
    if (row.unsubscribed) add("unsubscribed", row.repliedAt ?? row.sentAt, false);
    const categoryAt = row.repliedAt ?? row.sentAt;
    if (row.category && categoryAt) {
      events.push({ ...shared, kind: "category", occurredAt: categoryAt, dedupeKey: smartleadCategoryKey(campaignId, lead, row.category), payload: { category: row.category } });
    }
  }
  return events;
}

function pushOutcome(leads: PushLead[], taken: number, refused: Set<string>, refusedKey: (lead: PushLead) => string | null): PushOutcome {
  const outcome: PushOutcome = { taken: new Set(), unsure: new Set() };
  const accepted = leads.filter((lead) => {
    const key = refusedKey(lead);
    return !key || !refused.has(key);
  });
  const all = taken >= accepted.length && accepted.length === leads.length;
  for (const lead of leads) {
    const key = refusedKey(lead);
    if (key && refused.has(key)) continue;
    if (all) outcome.taken.add(lead.key);
    else outcome.unsure.add(lead.key);
  }
  return outcome;
}

export const smartleadProvider: CampaignProvider = {
  id: "smartlead",
  channel: "email",
  name: "Smartlead",
  needsLeadId: true,
  standardVariables: [
    "first_name",
    "last_name",
    "email",
    "company_name",
    "website",
    "company_url",
    "location",
    "phone_number",
    "linkedin_profile",
    "sl_time_of_day",
    "sl_day_of_week",
  ],
  failure: (error) => (error instanceof SmartleadError ? { message: error.message, rejectedKey: error.rejectedKey, missing: error.status === 404, status: error.status } : null),
  async checkKey(context) {
    const campaigns = await listSmartleadCampaigns(context.key, context);
    const clientIds = smartleadClients(campaigns);
    if (clientIds.length > 1) throw new SmartleadError(ACCOUNT_KEY, 400);
    const client = await readSmartleadClient(context.key, clientIds, context);
    return {
      details: { clientId: client?.id ?? clientIds[0] ?? null, clientName: client?.name ?? null, campaigns: campaigns.length },
      campaigns: campaigns.length,
    };
  },
  connectedLine(details, campaigns) {
    const client = typeof details.clientName === "string" && details.clientName ? ` to client ${details.clientName}` : "";
    return `Connected${client}. ${campaignsLine(campaigns)}.`;
  },
  async listCampaigns(context) {
    const campaigns = await listSmartleadCampaigns(context.key, context);
    const stored = typeof context.details?.clientId === "string" && context.details.clientId ? context.details.clientId : null;
    if (!stored && smartleadClients(campaigns).length > 1) throw new SmartleadError(ACCOUNT_KEY, 400);
    return campaigns
      .filter((item) => !stored || item.clientId === null || item.clientId === stored)
      .map((item) => ({ externalId: item.id, name: item.name, status: item.status }));
  },
  async readCampaign(context, externalId) {
    const found = await readSmartleadCampaign(context.key, externalId, context);
    if (!found) return null;
    const stored = typeof context.details?.clientId === "string" && context.details.clientId ? context.details.clientId : null;
    if (stored && found.clientId && found.clientId !== stored) return null;
    return { externalId: found.id, name: found.name, status: found.status };
  },
  readSequence: (context, externalId) => readSmartleadSequence(context.key, externalId, context),
  variables: variablesIn,
  readStats: async (context, externalId) => ({ stats: await readSmartleadStats(context.key, externalId, context) }),
  async readLeads(context, externalId, offset) {
    const page = await listSmartleadLeads(context.key, externalId, offset, context);
    return {
      items: page.leads.map((lead) => ({
        externalId: lead.id,
        email: prospectEmail(lead.email),
        linkedin: prospectLinkedin(lead.linkedin),
        lead: {
          firstName: lead.firstName,
          lastName: lead.lastName,
          companyName: lead.companyName,
          website: lead.website,
          title: lead.title,
          linkedinUrl: lead.linkedin,
        },
        leadStatus: lead.status,
        category: lead.category,
        addedAt: lead.addedAt,
      })),
      next: page.next,
    };
  },
  async readEvents(context, externalId, since, offset) {
    const page = await readSmartleadStatistics(context.key, externalId, since, offset, context);
    return { items: smartleadEvents(externalId, page.rows), next: page.next };
  },
  readMailboxes: (context, externalId) => readSmartleadMailboxes(context.key, externalId, context),
  campaignUrl: (externalId) => `${SMARTLEAD_APP}/${encodeURIComponent(externalId)}/analytics`,
  repliesFromThreads: false,
  async readThread(context, campaign, lead) {
    if (!lead.externalLeadId) return [];
    const messages = await readSmartleadThread(context.key, campaign.externalId, lead.externalLeadId, context);
    return messages.map((message) => ({
      externalId: message.id,
      direction: message.direction,
      step: message.step,
      subject: message.subject,
      body: message.body,
      sentAt: message.sentAt,
      conversationId: null,
      senderId: null,
      statsId: message.statsId,
      providerMessageId: message.messageId,
      fromAddress: message.from,
      automatic: message.automatic,
      replyKey: null,
    }));
  },
  async sendReply(context, campaignExternalId, target, text) {
    if (!target.statsId) throw new SmartleadError("Smartlead hasn't sent this person anything yet.", 400);
    const sent = await sendSmartleadReply(context.key, campaignExternalId, { statsId: target.statsId, replyTo: target.replyTo, text }, context);
    return { providerMessageId: sent.messageId };
  },
  setCampaignStatus: (context, externalId, status) => setSmartleadCampaignStatus(context.key, externalId, status === "paused" ? "PAUSED" : "START", context),
  startCampaign: (context, externalId) => setSmartleadCampaignStatus(context.key, externalId, "START", context),
  pauseLead: (context, campaignExternalId, lead) => pauseSmartleadLead(context.key, campaignExternalId, leadIdOf(lead), context),
  resumeLead: (context, campaignExternalId, lead) => resumeSmartleadLead(context.key, campaignExternalId, leadIdOf(lead), context),
  async stopLead(context, campaignExternalId, lead, reason) {
    if (reason === "removed") {
      await removeSmartleadLead(context.key, campaignExternalId, leadIdOf(lead), context);
      return "stopped";
    }
    await pauseSmartleadLead(context.key, campaignExternalId, leadIdOf(lead), context);
    return "stopped";
  },
  async setCategory(context, campaignExternalId, lead, category) {
    const categories = await listSmartleadCategories(context.key, context);
    const wanted = categoryPart(category);
    const match = categories.find((item) => categoryPart(item.name) === wanted);
    if (!match) throw new SmartleadError(`Smartlead has no category called ${category}.`, 400);
    await setSmartleadCategory(context.key, campaignExternalId, leadIdOf(lead), match.id, context);
  },
  clearCategory: (context, campaignExternalId, lead) => clearSmartleadCategory(context.key, campaignExternalId, leadIdOf(lead), context),
  unblockAddress: (context, address) => unblockSmartleadAddress(context.key, address, context),
  categoryKey: (campaignExternalId, lead, category) => smartleadCategoryKey(campaignExternalId, lead.externalLeadId ?? lead.email ?? "", category),
  blockAddresses: (context, addresses) => blockSmartleadAddresses(context.key, addresses, context),
  webhookEvents: [SMARTLEAD_WEBHOOK_EVENTS.join(",")],
  registerWebhook: (context, campaignExternalId, url) => createSmartleadWebhook(context.key, campaignExternalId, url, context),
  webhookHint: (payload, headers) => smartleadWebhookHint(payload, headers.get("x-request-id")),
  pushBatch: SMARTLEAD_PUSH_BATCH,
  valueLimit: 2000,
  variableToken: (name) => `{{${name}}}`,
  async pushLeads(context, campaignExternalId, leads) {
    const ready = leads.filter((lead) => lead.email);
    const pushed = await addSmartleadLeads(
      context.key,
      campaignExternalId,
      ready.map((lead) => ({
        email: lead.email!,
        firstName: lead.firstName,
        lastName: lead.lastName,
        companyName: lead.companyName,
        website: lead.website,
        linkedin: profileUrl(lead.linkedin),
        customFields: lead.values,
      })),
      context,
    );
    return pushOutcome(ready, pushed.taken, new Set(pushed.refused), (lead) => lead.email);
  },
  async findLead(context, campaignExternalId, lead) {
    if (!lead.email) return null;
    const found = await findSmartleadLead(context.key, campaignExternalId, lead.email, context);
    return found ? { externalLeadId: found.id } : null;
  },
};

function heyReachProfile(lead: HeyReachLead): LeadProfile {
  return { firstName: lead.firstName, lastName: lead.lastName, companyName: lead.companyName, title: lead.title, linkedinUrl: lead.profileUrl };
}

function heyReachLeadKey(lead: HeyReachLead) {
  return lead.id ?? prospectLinkedin(lead.profileUrl);
}

export function heyReachCategoryKey(campaignId: string, lead: string, category: string) {
  return `heyreach:${campaignId}:${lead}:category:${categoryPart(category)}`;
}

function heyReachMessages(campaignId: string, conversation: HeyReachConversation): ProviderMessage[] {
  return (conversation.messages ?? []).map((message) => {
    const direction = message.fromThem ? "inbound" : "outbound";
    return {
      externalId: `${conversation.id}:${message.at}:${direction}`,
      direction,
      step: null,
      subject: null,
      body: message.body,
      sentAt: message.at,
      conversationId: conversation.id,
      senderId: conversation.accountId,
      statsId: null,
      providerMessageId: null,
      fromAddress: null,
      automatic: message.automatic,
      replyKey: direction === "inbound" ? `heyreach:${campaignId}:${conversation.id}:replied:${message.at}` : null,
    };
  });
}

async function conversationThread(context: ProviderContext, campaignId: string, conversation: HeyReachConversation): Promise<ProviderThread> {
  const full = conversation.messages === null && conversation.accountId ? await readHeyReachChatroom(context.key, conversation.accountId, conversation.id, context) : null;
  const read = full ? { ...conversation, messages: full.messages ?? [] } : conversation;
  return {
    conversationId: conversation.id,
    leadId: conversation.leadId,
    linkedin: prospectLinkedin(conversation.profileUrl),
    lastMessageAt: conversation.lastMessageAt,
    messages: heyReachMessages(campaignId, read),
    tags: conversation.tags,
  };
}

export function heyReachEvents(campaignId: string, leads: HeyReachLead[]): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const lead of leads) {
    const key = heyReachLeadKey(lead);
    if (!key) continue;
    const base = `heyreach:${campaignId}:${key}`;
    const shared = { externalLeadId: lead.id, email: null, linkedin: prospectLinkedin(lead.profileUrl), lead: heyReachProfile(lead), variant: null, category: null };
    const add = (kind: CampaignEventKind, at: string | null, step: number | null, suffix = "") => {
      if (!at) return;
      events.push({ ...shared, kind, step, occurredAt: at, dedupeKey: `${base}:${kind}${suffix}`, payload: lead.accountId ? { senderId: lead.accountId } : {} });
    };
    add("invite_sent", lead.invitedAt, null);
    add("invite_accepted", lead.acceptedAt, null);
    for (let message = 1; message <= Math.min(lead.messagesSent, 50); message += 1) add("message_sent", lead.lastMessageAt, message, `:${message}`);
    const tag = lead.tags[0];
    const taggedAt = lead.acceptedAt ?? lead.lastMessageAt ?? lead.invitedAt ?? lead.addedAt;
    if (tag && taggedAt) {
      events.push({ ...shared, category: tag, kind: "category", step: null, occurredAt: taggedAt, dedupeKey: heyReachCategoryKey(campaignId, key, tag), payload: { category: tag } });
    }
  }
  return events;
}

function heyReachProviderLeads(leads: HeyReachLead[]): ProviderLead[] {
  return leads.flatMap((lead): ProviderLead[] => {
    const linkedin = prospectLinkedin(lead.profileUrl);
    if (!lead.id && !linkedin) return [];
    return [
      {
        externalId: lead.id,
        email: null,
        linkedin,
        lead: heyReachProfile(lead),
        leadStatus: lead.status,
        category: null,
        addedAt: lead.addedAt,
        senderId: lead.accountId,
        providerState: { status: lead.state, connection: lead.connection, messaging: lead.messaging, lastActionAt: lead.lastActionAt, senderName: lead.senderName },
      },
    ];
  });
}

export function heyReachLeadStats(counts: HeyReachLeadCounts | null): CampaignStats {
  if (!counts) return {};
  const stats: CampaignStats = {
    leads: counts.total,
    enrolled: counts.enrolled,
    notEnrolled: counts.notEnrolled,
    finished: counts.finished,
    pausedLeads: counts.paused,
    failed: counts.failed,
    excluded: counts.excluded,
  };
  return Object.fromEntries(Object.entries(stats).filter(([, value]) => value !== undefined));
}

export const heyReachProvider: CampaignProvider = {
  id: "heyreach",
  channel: "linkedin",
  name: "HeyReach",
  needsLeadId: false,
  standardVariables: ["first_name", "last_name", "company_name", "position", "location", "FIRST_NAME", "LAST_NAME", "COMPANY", "COMPANY_NAME", "POSITION", "LOCATION"],
  failure: (error) => (error instanceof HeyReachError ? { message: error.message, rejectedKey: error.rejectedKey, missing: error.status === 404, status: error.status } : null),
  async checkKey(context) {
    await checkHeyReachKey(context.key, context);
    const [campaigns, senders] = await Promise.all([listHeyReachCampaigns(context.key, context), heyReachProvider.listSenders!(context)]);
    return { details: { campaigns: campaigns.length, senders: senders.length }, campaigns: campaigns.length, senders };
  },
  connectedLine(details, campaigns) {
    const senders = typeof details.senders === "number" ? details.senders : 0;
    return `Connected. ${accountsLine(senders)}, ${campaignsLine(campaigns)}.`;
  },
  async listCampaigns(context) {
    return (await listHeyReachCampaigns(context.key, context)).map((item) => ({ externalId: item.id, name: item.name, status: item.status, senderIds: item.accountIds }));
  },
  async readCampaign(context, externalId) {
    const found = await readHeyReachCampaign(context.key, externalId, context);
    return found ? { externalId: found.id, name: found.name, status: found.status, senderIds: found.accountIds } : null;
  },
  readSequence: (context, externalId) => readHeyReachSequence(context.key, externalId, context),
  variables: heyReachVariables,
  async readStats(context, externalId) {
    const read = await readHeyReachStats(context.key, externalId, context);
    return { stats: { ...read.stats, ...heyReachLeadStats(read.leadCounts) }, days: read.days, listId: read.listId };
  },
  async readLeads(context, externalId, offset) {
    const page = await listHeyReachLeads(context.key, externalId, offset, context);
    return { items: heyReachProviderLeads(page.leads), next: page.next };
  },
  async readEvents(context, externalId, since, offset) {
    const page = await listHeyReachLeads(context.key, externalId, offset, { ...context, since });
    return { items: heyReachEvents(externalId, page.leads), next: page.next, leads: heyReachProviderLeads(page.leads) };
  },
  async readListLeads(context, listId, offset) {
    const page = await listHeyReachListLeads(context.key, listId, offset, context);
    return {
      items: page.leads.flatMap((lead): ProviderLead[] => {
        const linkedin = prospectLinkedin(lead.profileUrl);
        if (!linkedin) return [];
        return [
          {
            externalId: null,
            email: null,
            linkedin,
            lead: { firstName: lead.firstName, lastName: lead.lastName, companyName: lead.companyName, title: lead.title, linkedinUrl: lead.profileUrl },
            leadStatus: null,
            category: null,
            addedAt: null,
            senderId: null,
          },
        ];
      }),
      next: page.next,
    };
  },
  async listSenders(context) {
    return (await listHeyReachAccounts(context.key, context)).map((account) => ({
      externalId: account.id,
      name: account.name,
      email: account.email,
      linkedin: prospectLinkedin(account.profileUrl),
      inviteLimit: account.inviteLimit,
      messageLimit: account.messageLimit,
    }));
  },
  campaignUrl: (externalId) => `${HEYREACH_APP}/${encodeURIComponent(externalId)}`,
  repliesFromThreads: true,
  async readThread(context, campaign, lead) {
    const url = profileUrl(lead.linkedin);
    if (!url) return [];
    const messages: ProviderMessage[] = [];
    for (let offset: number | null = 0, pages = 0; offset !== null && pages < 5; pages += 1) {
      const page = await listHeyReachConversations(context.key, { campaignId: campaign.externalId, profileUrl: url }, offset, context);
      for (const conversation of page.conversations) {
        if (conversation.profileUrl && prospectLinkedin(conversation.profileUrl) !== lead.linkedin) continue;
        messages.push(...(await conversationThread(context, campaign.externalId, conversation)).messages);
      }
      offset = page.next;
    }
    return messages;
  },
  async readReplies(context, externalId, offset) {
    const page = await listHeyReachConversations(context.key, { campaignId: externalId }, offset, context);
    const items: ProviderThread[] = [];
    for (const conversation of page.conversations) items.push(await conversationThread(context, externalId, conversation));
    return { items, next: page.next };
  },
  async sendReply(context, _campaignExternalId, target, text) {
    if (!target.conversationId || !target.senderId) throw new HeyReachError("There's no LinkedIn conversation with this person yet.", 400);
    await sendHeyReachMessage(context.key, { conversationId: target.conversationId, accountId: target.senderId, text }, context);
    return { providerMessageId: null };
  },
  setCampaignStatus: (context, externalId, status) => setHeyReachCampaignStatus(context.key, externalId, status, context),
  startCampaign: (context, externalId) => startHeyReachCampaign(context.key, externalId, context),
  async stopLead(context, campaignExternalId, lead) {
    const url = profileUrl(lead.linkedin);
    if (!url) throw new LeadNotReady();
    await stopHeyReachLead(context.key, campaignExternalId, url, context);
    return "stopped";
  },
  categoryKey: (campaignExternalId, lead, category) => heyReachCategoryKey(campaignExternalId, lead.externalLeadId ?? lead.linkedin ?? "", category),
  webhookEvents: [],
  connectionWebhookEvents: HEYREACH_WEBHOOK_EVENTS,
  async findConnectionWebhooks(context, url) {
    const hooks = await listHeyReachWebhooks(context.key, url, context);
    const found: Record<string, string> = {};
    for (const event of HEYREACH_WEBHOOK_EVENTS) {
      const id = allCampaignsWebhook(hooks, url, event);
      if (id) found[event] = id;
    }
    return found;
  },
  async createConnectionWebhook(context, url, event) {
    const id = await createHeyReachWebhook(context.key, url, { ...context, eventType: event });
    if (id) return id;
    try {
      return allCampaignsWebhook(await listHeyReachWebhooks(context.key, url, context), url, event);
    } catch {
      return null;
    }
  },
  webhookActions(payload) {
    const tag = heyReachWebhookTag(payload);
    if (tag) {
      const linkedin = prospectLinkedin(tag.profileUrl);
      if (!linkedin) return null;
      const category = tag.autoTag === "positive" ? "Interested" : tag.autoTag === "negative" ? "Not interested" : null;
      const patch: Record<string, unknown> = { ...(tag.tags ? { tags: tag.tags } : {}), ...(tag.autoTag ? { autoTag: tag.autoTag, autoTagAt: tag.at } : {}) };
      return {
        campaignExternalId: tag.campaignId,
        tags: { linkedin, patch, positive: tag.autoTag === "positive" },
        events: category
          ? [
              {
                externalLeadId: null,
                email: null,
                linkedin,
                lead: { linkedinUrl: tag.profileUrl },
                kind: "category" as const,
                step: null,
                variant: null,
                occurredAt: tag.at,
                dedupeKey: `heyreach:${tag.campaignId}:${linkedin}:auto_tag:${tag.autoTag}`,
                category,
                payload: { category, autoTag: tag.autoTag, fromWebhook: true },
              },
            ]
          : [],
      };
    }
    const action = heyReachWebhookAction(payload);
    const linkedin = action ? prospectLinkedin(action.profileUrl) : null;
    if (!action || !linkedin) return null;
    const counted = action.kind === "message_sent" || action.kind === "inmail_sent";
    return {
      campaignExternalId: action.campaignId,
      events: [
        {
          externalLeadId: null,
          email: null,
          linkedin,
          lead: { firstName: action.firstName, lastName: action.lastName, companyName: action.companyName, title: action.title, linkedinUrl: action.profileUrl },
          kind: action.kind,
          step: null,
          variant: null,
          occurredAt: action.at,
          dedupeKey: `heyreach:${action.campaignId}:${linkedin}:${action.kind}`,
          category: null,
          payload: { ...(action.accountId ? { senderId: action.accountId } : {}), fromWebhook: true, ...(counted ? { countSent: true } : {}) },
        },
      ],
    };
  },
  webhookHint(payload) {
    const hint = heyReachWebhookHint(payload);
    return hint ? { campaignId: hint.campaignId, leadId: hint.leadId, email: null, linkedin: prospectLinkedin(hint.profileUrl), receiptKey: hint.receiptKey } : null;
  },
  pushBatch: HEYREACH_PUSH_BATCH,
  valueLimit: 1000,
  variableToken: (name) => `{${name}}`,
  async pushLeads(context, campaignExternalId, leads) {
    const ready = leads.filter((lead) => lead.linkedin && lead.firstName && lead.lastName);
    const pushed = await addHeyReachLeads(
      context.key,
      campaignExternalId,
      ready.map((lead) => ({
        profileUrl: profileUrl(lead.linkedin)!,
        firstName: lead.firstName!,
        lastName: lead.lastName!,
        companyName: lead.companyName,
        position: lead.title,
        email: lead.email,
        accountId: lead.senderId,
        customFields: lead.values,
      })),
      context,
    );
    return pushOutcome(ready, pushed.taken, new Set(), () => null);
  },
  async findLead(context, campaignExternalId, lead) {
    const url = profileUrl(lead.linkedin);
    if (!url) return null;
    const found = await findHeyReachLead(context.key, campaignExternalId, url, context);
    return found ? { externalLeadId: found.id } : null;
  },
};

export const CAMPAIGN_PROVIDER_CLIENTS: Partial<Record<CampaignProviderId, CampaignProvider>> = {
  smartlead: smartleadProvider,
  heyreach: heyReachProvider,
};

export function campaignProvider(id: string): CampaignProvider | null {
  return CAMPAIGN_PROVIDER_CLIENTS[id as CampaignProviderId] ?? null;
}
