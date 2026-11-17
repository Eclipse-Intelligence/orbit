export const CAMPAIGN_PROVIDERS = ["smartlead", "heyreach"] as const;
export type CampaignProviderId = (typeof CAMPAIGN_PROVIDERS)[number];

export const CAMPAIGN_CHANNELS = ["email", "linkedin"] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const CAMPAIGN_STATUSES = ["active", "paused", "drafted", "completed", "stopped", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const PROVIDER_CHANNEL: Record<CampaignProviderId, CampaignChannel> = {
  smartlead: "email",
  heyreach: "linkedin",
};

export const PROVIDER_NAMES: Record<CampaignProviderId, string> = {
  smartlead: "Smartlead",
  heyreach: "HeyReach",
};

export const LEAD_STATUSES = ["not_started", "in_progress", "paused", "completed", "stopped", "blocked", "unsubscribed", "bounced"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const PROSPECT_STATES = ["queued", "filling", "pushing", "pushed", "skipped", "failed"] as const;
export type ProspectState = (typeof PROSPECT_STATES)[number];

export const EVENT_KINDS = [
  "added",
  "sent",
  "opened",
  "clicked",
  "engaged",
  "replied",
  "bounced",
  "unsubscribed",
  "category",
  "invite_sent",
  "invite_accepted",
  "message_sent",
  "inmail_sent",
] as const;
export type CampaignEventKind = (typeof EVENT_KINDS)[number];

export const STAT_KEYS = [
  "prospects",
  "contacted",
  "sent",
  "opened",
  "clicked",
  "replied",
  "positive",
  "bounced",
  "unsubscribed",
  "invites",
  "accepted",
  "messages",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type CampaignStats = Partial<Record<StatKey, number>>;

export type SequenceStep = {
  step: number;
  variant: string | null;
  subject: string;
  body: string;
  delayDays: number | null;
};

export type StepStats = {
  step: number;
  variant: string | null;
  sent: number;
  opened: number;
  replied: number;
  accepted?: number;
};

export type DayStats = { day: string; sent: number; replied: number; accepted?: number };

export type ProviderDay = { day: string; invites: number; accepted: number; messages: number; replies: number };

export type Mailbox = {
  address: string;
  dailyLimit: number | null;
  problem: string | null;
};

export type CampaignSummary = {
  id: string;
  provider: CampaignProviderId;
  channel: CampaignChannel;
  externalId: string;
  name: string;
  status: CampaignStatus;
  stats: CampaignStats;
  prospects: number;
  syncedAt: string | null;
  backfilled: boolean;
};

export type CampaignDetail = CampaignSummary & {
  sequence: SequenceStep[];
  variables: string[];
  standardVariables: string[];
  stepStats: StepStats[];
  days: DayStats[];
  unlinked: number;
  url: string | null;
  capacity: SenderCapacity | null;
};

export type SenderCapacity = { senders: number; invites: number | null };

export const PROSPECT_FILTERS = ["all", "replied", "skipped"] as const;
export type ProspectFilter = (typeof PROSPECT_FILTERS)[number];

export type ProspectRow = {
  id: string;
  contactId: string | null;
  companyId: string | null;
  name: string;
  companyName: string | null;
  email: string | null;
  state: ProspectState;
  skipReason: string | null;
  leadStatus: string | null;
  category: string | null;
  repliedAt: string | null;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
  lastEvent: { kind: CampaignEventKind; step: number | null; at: string } | null;
  stage: LinkedinStage | null;
  sender: string | null;
};

export type LinkedinStage = "invited" | "accepted";

export type CampaignSender = {
  id: string;
  externalId: string;
  name: string;
  linkedin: string | null;
  email: string | null;
  userId: string | null;
  inviteLimit: number | null;
  messageLimit: number | null;
};

export type SenderMember = { userId: string; name: string };

export type SendersView = { senders: CampaignSender[]; members: SenderMember[]; canAdmin: boolean };

export type ProspectPage = { rows: ProspectRow[]; total: number; page: number; pageSize: number };

export type ConnectionView = {
  provider: CampaignProviderId;
  connected: boolean;
  line: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  keyHint: string | null;
  canAdmin: boolean;
  senders?: SendersView;
};
