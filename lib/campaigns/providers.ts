import { prospectEmail, prospectLinkedin, splitName } from "@/lib/campaigns/normalize";
import type {
  CampaignChannel,
  CampaignEventKind,
  CampaignProviderId,
  CampaignStats,
  CampaignStatus,
  LeadStatus,
  Mailbox,
  SequenceStep,
} from "@/lib/campaigns/types";
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

export type ProviderCampaign = { externalId: string; name: string; status: CampaignStatus };

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

export type ConnectionCheck = { details: Record<string, unknown>; campaigns: number };

export type CampaignProvider = {
  id: CampaignProviderId;
  channel: CampaignChannel;
  name: string;
  standardVariables: readonly string[];
  failure(error: unknown): { message: string; rejectedKey: boolean } | null;
  checkKey(context: ProviderContext): Promise<ConnectionCheck>;
  connectedLine(details: Record<string, unknown>, campaigns: number): string;
  listCampaigns(context: ProviderContext): Promise<ProviderCampaign[]>;
  readSequence(context: ProviderContext, externalId: string): Promise<SequenceStep[]>;
  variables(steps: SequenceStep[]): string[];
  readStats(context: ProviderContext, externalId: string): Promise<CampaignStats>;
  readLeads(context: ProviderContext, externalId: string, offset: number): Promise<ProviderPage<ProviderLead>>;
  readEvents(context: ProviderContext, externalId: string, since: string | null, offset: number): Promise<ProviderPage<ProviderEvent>>;
  readMailboxes?(context: ProviderContext, externalId: string): Promise<Mailbox[]>;
  campaignUrl(externalId: string): string | null;
};

function campaignsLine(campaigns: number) {
  return campaigns === 1 ? "1 campaign" : `${campaigns.toLocaleString("en-GB")} campaigns`;
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
  failure: (error) => (error instanceof SmartleadError ? { message: error.message, rejectedKey: error.rejectedKey } : null),
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
  readStats: (context, externalId) => readSmartleadStats(context.key, externalId, context),
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

export const CAMPAIGN_PROVIDER_CLIENTS: Partial<Record<CampaignProviderId, CampaignProvider>> = {
  smartlead: smartleadProvider,
};

export function campaignProvider(id: string): CampaignProvider | null {
  return CAMPAIGN_PROVIDER_CLIENTS[id as CampaignProviderId] ?? null;
}
