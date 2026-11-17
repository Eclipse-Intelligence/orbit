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
} from "@/lib/campaigns/types";
import {
  checkHeyReachKey,
  HEYREACH_APP,
  HeyReachError,
  listHeyReachAccounts,
  listHeyReachCampaigns,
  listHeyReachLeads,
  readHeyReachSequence,
  readHeyReachStats,
  variablesIn as heyReachVariables,
  type HeyReachLead,
} from "@/lib/heyreach";
import {
  listSmartleadCampaigns,
  listSmartleadLeads,
  readSmartleadClient,
  readSmartleadMailboxes,
  readSmartleadSequence,
  readSmartleadStatistics,
  readSmartleadStats,
  SMARTLEAD_APP,
  SmartleadError,
  type SmartleadStatRow,
  variablesIn,
} from "@/lib/smartlead";

export type ProviderContext = {
  key: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export type ProviderCampaign = { externalId: string; name: string; status: CampaignStatus; senderIds?: string[] };

export type ProviderSender = {
  externalId: string;
  name: string;
  email: string | null;
  linkedin: string | null;
  inviteLimit: number | null;
  messageLimit: number | null;
};

export type StatsRead = { stats: CampaignStats; days?: ProviderDay[] };

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

export type ProviderPage<T> = { items: T[]; next: number | null };

export type ConnectionCheck = { details: Record<string, unknown>; campaigns: number; senders?: ProviderSender[] };

export type CampaignProvider = {
  id: CampaignProviderId;
  channel: CampaignChannel;
  name: string;
  standardVariables: readonly string[];
  failure(error: unknown): { message: string; rejectedKey: boolean; missing: boolean } | null;
  checkKey(context: ProviderContext): Promise<ConnectionCheck>;
  connectedLine(details: Record<string, unknown>, campaigns: number): string;
  listCampaigns(context: ProviderContext): Promise<ProviderCampaign[]>;
  readSequence(context: ProviderContext, externalId: string): Promise<SequenceStep[]>;
  variables(steps: SequenceStep[]): string[];
  readStats(context: ProviderContext, externalId: string): Promise<StatsRead>;
  readLeads(context: ProviderContext, externalId: string, offset: number): Promise<ProviderPage<ProviderLead>>;
  readEvents(context: ProviderContext, externalId: string, since: string | null, offset: number): Promise<ProviderPage<ProviderEvent>>;
  readMailboxes?(context: ProviderContext, externalId: string): Promise<Mailbox[]>;
  listSenders?(context: ProviderContext): Promise<ProviderSender[]>;
  campaignUrl(externalId: string): string | null;
};

function campaignsLine(campaigns: number) {
  return campaigns === 1 ? "1 campaign" : `${campaigns.toLocaleString("en-GB")} campaigns`;
}

function accountsLine(accounts: number) {
  return accounts === 1 ? "1 LinkedIn account" : `${accounts.toLocaleString("en-GB")} LinkedIn accounts`;
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
  }
  return events;
}

export const smartleadProvider: CampaignProvider = {
  id: "smartlead",
  channel: "email",
  name: "Smartlead",
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
  failure: (error) => (error instanceof SmartleadError ? { message: error.message, rejectedKey: error.rejectedKey, missing: error.status === 404 } : null),
  async checkKey(context) {
    const campaigns = await listSmartleadCampaigns(context.key, context);
    const clientIds = [...new Set(campaigns.map((item) => item.clientId).filter((id): id is string => Boolean(id)))];
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
    return (await listSmartleadCampaigns(context.key, context)).map((item) => ({ externalId: item.id, name: item.name, status: item.status }));
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
};

function heyReachProfile(lead: HeyReachLead): LeadProfile {
  return { firstName: lead.firstName, lastName: lead.lastName, companyName: lead.companyName, title: lead.title, linkedinUrl: lead.profileUrl };
}

function heyReachLeadKey(lead: HeyReachLead) {
  return lead.id ?? prospectLinkedin(lead.profileUrl);
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
  }
  return events;
}

export const heyReachProvider: CampaignProvider = {
  id: "heyreach",
  channel: "linkedin",
  name: "HeyReach",
  standardVariables: ["first_name", "last_name", "company_name", "position", "location"],
  failure: (error) => (error instanceof HeyReachError ? { message: error.message, rejectedKey: error.rejectedKey, missing: error.status === 404 } : null),
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
  readSequence: (context, externalId) => readHeyReachSequence(context.key, externalId, context),
  variables: heyReachVariables,
  readStats: (context, externalId) => readHeyReachStats(context.key, externalId, context),
  async readLeads(context, externalId, offset) {
    const page = await listHeyReachLeads(context.key, externalId, offset, context);
    return {
      items: page.leads.flatMap((lead): ProviderLead[] => {
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
          },
        ];
      }),
      next: page.next,
    };
  },
  async readEvents(context, externalId, since, offset) {
    const page = await listHeyReachLeads(context.key, externalId, offset, { ...context, since });
    return { items: heyReachEvents(externalId, page.leads), next: page.next };
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
};

export const CAMPAIGN_PROVIDER_CLIENTS: Partial<Record<CampaignProviderId, CampaignProvider>> = {
  smartlead: smartleadProvider,
  heyreach: heyReachProvider,
};

export function campaignProvider(id: string): CampaignProvider | null {
  return CAMPAIGN_PROVIDER_CLIENTS[id as CampaignProviderId] ?? null;
}
