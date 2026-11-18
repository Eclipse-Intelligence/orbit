import {
  PROVIDER_NAMES,
  type AutoAdd,
  type CampaignChannel,
  type CampaignEventKind,
  type CampaignProviderId,
  type CampaignStatus,
  type CampaignSummary,
  type CampaignDetail,
  type ProspectRow,
  type StatKey,
} from "@/lib/campaigns/types";
import { relativeWhen } from "@/lib/companies";

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  active: "Live",
  paused: "Paused",
  drafted: "Drafted",
  completed: "Completed",
  stopped: "Stopped",
  archived: "Archived",
};

export type StatLabel = { key: StatKey; label: string };

export type FunnelLabel = StatLabel & { of: StatKey };

export const PROVIDER_STATS: Record<CampaignProviderId, { funnel: FunnelLabel[]; statuses: StatLabel[] }> = {
  heyreach: {
    funnel: [
      { key: "contacted", label: "Contacted", of: "leads" },
      { key: "accepted", label: "Accepted", of: "leads" },
      { key: "replied", label: "Replied", of: "leads" },
      { key: "interested", label: "Interested", of: "leads" },
    ],
    statuses: [
      { key: "leads", label: "Total leads" },
      { key: "enrolled", label: "Enrolled in sequence" },
      { key: "notEnrolled", label: "Not enrolled yet" },
      { key: "finished", label: "Finished" },
      { key: "pausedLeads", label: "Paused" },
      { key: "failed", label: "Failed leads" },
      { key: "excluded", label: "Excluded leads" },
    ],
  },
  smartlead: {
    funnel: [
      { key: "contacted", label: "Sequence started", of: "leads" },
      { key: "opened", label: "Opened", of: "contacted" },
      { key: "replied", label: "Replied", of: "contacted" },
      { key: "positive", label: "Positive reply", of: "contacted" },
    ],
    statuses: [
      { key: "leads", label: "Total" },
      { key: "notStarted", label: "Not started" },
      { key: "inProgress", label: "In progress" },
      { key: "finished", label: "Completed" },
      { key: "blocked", label: "Blocked" },
      { key: "pausedLeads", label: "Paused" },
      { key: "stopped", label: "Stopped" },
      { key: "clicked", label: "Clicked" },
      { key: "bounced", label: "Bounced" },
      { key: "unsubscribed", label: "Unsubscribed" },
    ],
  },
};

export function providerFigure(campaign: Pick<CampaignDetail, "provider" | "stats" | "leadFunnel">, key: StatKey): number | undefined {
  if (campaign.provider === "heyreach" && (key === "contacted" || key === "accepted" || key === "replied")) return campaign.leadFunnel?.[key];
  if (campaign.provider === "heyreach" && key === "interested") return undefined;
  return campaign.stats[key];
}

export const HEYREACH_STATUS_LABELS: Record<string, string> = {
  in_sequence: "In progress",
  pending: "Pending",
  finished: "Finished",
  paused: "Paused",
  failed: "Failed",
  excluded: "Excluded",
};

const LEAD_STATUS_WORDS: Record<string, string> = {
  in_progress: "In progress",
  not_started: "Pending",
  completed: "Finished",
  paused: "Paused",
  stopped: "Failed",
};

export function linkedinStatus(row: ProspectRow) {
  if (row.providerStatus && HEYREACH_STATUS_LABELS[row.providerStatus]) return HEYREACH_STATUS_LABELS[row.providerStatus];
  if (row.leadStatus && LEAD_STATUS_WORDS[row.leadStatus]) return LEAD_STATUS_WORDS[row.leadStatus];
  return "Not enrolled yet";
}

export function linkedinTag(row: ProspectRow): { label: string; tone: TagTone } | null {
  if (row.stopRequestedAt && !row.stoppedAt) return { label: "Stopping", tone: "amber" };
  if (row.state === "skipped") return { label: "Skipped", tone: "neutral" };
  if (row.state === "failed") return { label: "Couldn't add", tone: "red" };
  if (row.state === "queued" || row.state === "filling" || row.state === "pushing") return { label: "Queued", tone: "neutral" };
  if (row.category) return { label: row.category, tone: categoryTone(row.category) };
  return null;
}

const ACTION_WORDS: Partial<Record<CampaignEventKind, string>> = {
  invite_sent: "Sent connection request",
  invite_accepted: "Connection accepted",
  message_sent: "Sent message",
  inmail_sent: "Sent InMail",
  profile_viewed: "Viewed profile",
  post_liked: "Liked post",
  followed: "Followed",
  replied: "Replied",
  finished: "Finished",
};

const SAME_ACTION_MS = 2 * 60_000;

export function actionAgo(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return days === 1 ? "1 day ago" : `${days} days ago`;
  return relativeWhen(iso, now).replace(/^about /, "");
}

export function lastActionLine(row: ProspectRow, now = Date.now()) {
  if (row.state === "skipped" || row.state === "failed") return row.skipReason ?? null;
  if (row.importError) return row.importError;
  if (row.stopError) return row.stopError;
  const known: { word: string; at: string }[] = [];
  if (row.repliedAt) known.push({ word: "Replied", at: row.repliedAt });
  const word = row.lastEvent ? ACTION_WORDS[row.lastEvent.kind] : undefined;
  if (row.lastEvent && word) known.push({ word, at: row.lastEvent.at });
  const latest = known.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  const provider = row.lastActionAt ? Date.parse(row.lastActionAt) : NaN;
  if (latest && (Number.isNaN(provider) || Date.parse(latest.at) >= provider - SAME_ACTION_MS)) return `${latest.word}, ${actionAgo(latest.at, now)}`;
  if (!Number.isNaN(provider)) return `Last action, ${actionAgo(row.lastActionAt!, now)}`;
  return null;
}

export const AUTO_ADD_LABELS: Record<AutoAdd, string> = {
  off: "Off",
  accepted: "When they accept",
  replied: "When they reply",
};

export function autoAddChoices(channel: CampaignChannel): AutoAdd[] {
  return channel === "linkedin" ? ["off", "accepted", "replied"] : ["off", "replied"];
}

export const CHANNEL_TAGS: Record<CampaignChannel, string> = { linkedin: "LinkedIn", email: "Email" };

export const CAMPAIGN_VIEWS = ["live", "paused", "archived"] as const;
export type CampaignView = (typeof CAMPAIGN_VIEWS)[number];

export function campaignView(status: CampaignStatus): CampaignView {
  if (status === "paused") return "paused";
  if (status === "completed" || status === "stopped" || status === "archived") return "archived";
  return "live";
}

export function percent(part: number | undefined, whole: number | undefined) {
  if (part === undefined || !whole) return null;
  const value = (part / whole) * 100;
  if (value === 0) return "0%";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

export function campaignRates(campaign: Pick<CampaignSummary, "stats" | "channel">) {
  const contacted = campaign.channel === "linkedin" ? (campaign.stats.contacted ?? campaign.stats.invites) : (campaign.stats.contacted ?? campaign.stats.prospects);
  return {
    replied: percent(campaign.stats.replied, contacted),
    positive: percent(campaign.stats.positive, contacted),
    opened: percent(campaign.stats.opened, contacted),
    accepted: campaign.channel === "linkedin" ? percent(campaign.stats.accepted, campaign.stats.invites) : null,
    bounced: campaign.channel === "email" ? percent(campaign.stats.bounced, campaign.stats.sent) : null,
  };
}

export function number(value: number | undefined | null) {
  return value === undefined || value === null ? null : value.toLocaleString("en-GB");
}

export type TagTone = "green" | "amber" | "red" | "neutral";

const POSITIVE = /interested|meeting|booked|positive/i;
const NEGATIVE = /not interested|negative|wrong person|do not contact/i;

export function categoryTone(category: string): TagTone {
  return POSITIVE.test(category) && !NEGATIVE.test(category) ? "green" : "neutral";
}

export function positiveCategory(category: string | null | undefined) {
  return Boolean(category) && categoryTone(category!) === "green";
}

export const CAMPAIGN_CATEGORIES = ["Interested", "Meeting request", "Meeting booked", "Information request", "Not interested", "Out of office", "Wrong person"] as const;

export function campaignThreadPath(prospectId: string) {
  return `/campaigns/threads/${prospectId}`;
}

export function prospectTag(row: ProspectRow, channel: CampaignChannel = "email"): { label: string; tone: TagTone } | null {
  if (row.stopRequestedAt && !row.stoppedAt) return { label: "Stopping", tone: "amber" };
  if (row.state === "skipped") return { label: "Skipped", tone: "neutral" };
  if (row.state === "failed") return { label: "Failed", tone: "red" };
  if (row.leadStatus === "bounced" || row.lastEvent?.kind === "bounced") return { label: "Bounced", tone: "red" };
  if (row.category) return { label: row.category, tone: categoryTone(row.category) };
  if (row.state === "queued" || row.state === "filling" || row.state === "pushing") return { label: "Queued", tone: "neutral" };
  if (row.leadStatus === "completed" && !row.repliedAt) return { label: channel === "linkedin" ? "Finished" : "Completed", tone: "neutral" };
  if (row.stage === "accepted") return { label: "Accepted", tone: "neutral" };
  if (row.stage === "invited") return { label: "Invited", tone: "neutral" };
  if (row.notEnrolled) return { label: "Not enrolled", tone: "neutral" };
  return null;
}

const EVENT_WORDS: Partial<Record<CampaignEventKind, string>> = {
  sent: "sent",
  opened: "opened",
  clicked: "clicked",
  bounced: "bounced",
  unsubscribed: "unsubscribed",
  invite_sent: "invite sent",
  invite_accepted: "invite accepted",
  message_sent: "message sent",
  inmail_sent: "InMail sent",
  profile_viewed: "profile viewed",
  post_liked: "post liked",
  followed: "followed",
  finished: "finished",
};

function when(iso: string, now: number) {
  const text = relativeWhen(iso, now);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function prospectLine(row: ProspectRow, now = Date.now()) {
  if (row.state === "skipped" || row.state === "failed") return row.skipReason ?? (row.state === "failed" ? "Failed" : "Skipped");
  if (row.importError) return row.importError;
  if (row.stopError) return row.stopError;
  if (row.repliedAt) return `Replied ${when(row.repliedAt, now)}`;
  const event = row.lastEvent;
  const word = event ? EVENT_WORDS[event.kind] : undefined;
  if (event?.kind === "message_sent" && event.step) return `Message ${event.step} sent ${when(event.at, now)}`;
  if (event && word) {
    const text = `${event.step ? `Step ${event.step} ` : ""}${word} ${when(event.at, now)}`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return "Added";
}

export function syncedAgo(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days} ${days === 1 ? "day" : "days"} ago`;
}

export function syncLine(input: { connected: boolean; error: string | null; syncedAt: string | null }, now = Date.now()) {
  if (!input.connected) return "Disconnected";
  if (input.error) return input.error;
  return input.syncedAt ? syncedAgo(input.syncedAt, now) : "Not synced yet";
}

type ConnectionStatus = { provider: CampaignProviderId; lastSyncedAt: string | null; lastError: string | null };

export function campaignsSyncLine(states: ConnectionStatus[], providers: CampaignProviderId[], now = Date.now()) {
  const all = [...new Set([...states.map((state) => state.provider), ...providers])];
  const lines = all.map((provider) => {
    const state = states.find((item) => item.provider === provider);
    const text = syncLine({ connected: Boolean(state), error: state?.lastError ?? null, syncedAt: state?.lastSyncedAt ?? null }, now);
    if (all.length === 1) return text;
    return `${PROVIDER_NAMES[provider]}: ${state?.lastError ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`}`;
  });
  return lines.length > 0 ? lines.join(" · ") : null;
}

export function campaignSyncLine(
  campaign: { provider: CampaignProviderId; syncError: string | null; syncedAt: string | null; backfilled: boolean },
  state: ConnectionStatus | undefined,
  now = Date.now(),
) {
  const error = campaign.syncError ?? state?.lastError ?? null;
  if (state && !error && !campaign.backfilled) return `Reading from ${PROVIDER_NAMES[campaign.provider]}…`;
  return syncLine({ connected: Boolean(state), error, syncedAt: campaign.syncedAt }, now);
}

function count(value: number) {
  return value.toLocaleString("en-GB");
}

function lowerStart(text: string) {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export type AddSummary = {
  campaign: { name: string };
  added: number;
  already: number;
  skipped: number;
  missing: number;
  reasons: { reason: string; count: number }[];
};

export function addedLine(result: AddSummary) {
  const parts = [`${count(result.added)} added to ${result.campaign.name || "the campaign"}.`];
  if (result.skipped > 0) parts.push(`${count(result.skipped)} skipped: ${result.reasons.map((item) => `${count(item.count)} ${lowerStart(item.reason)}`).join(", ")}.`);
  if (result.already > 0) parts.push(`${count(result.already)} already in it.`);
  if (result.missing > 0) parts.push(`${count(result.missing)} not found.`);
  return parts.join(" ");
}

export function sequenceSteps(sequence: { step: number }[]) {
  return new Set(sequence.map((item) => item.step)).size;
}

export function emailFit(daily: number, steps: number) {
  return Math.floor(daily / Math.max(1, steps));
}

export function emailCapacityLine(mailboxes: number, daily: number | null, steps: number) {
  const boxes = mailboxes === 1 ? "1 mailbox" : `${count(mailboxes)} mailboxes`;
  if (daily === null) return `${boxes}.`;
  const sends = `${boxes} ${mailboxes === 1 ? "sends" : "send"} ${count(daily)} a day.`;
  if (steps < 1) return sends;
  return `${sends} At ${steps === 1 ? "1 step" : `${count(steps)} steps`}, about ${count(emailFit(daily, steps))} new prospects a day fit.`;
}

export function overflowLine(addedToday: number, fit: number | null) {
  if (fit === null || addedToday <= fit) return null;
  return `Today's workflow added ${count(addedToday)}. The extra ${count(addedToday - fit)} wait for tomorrow.`;
}

export function linkedinFit(invites: number | null, messages: number | null, messageSteps: number) {
  if (invites === null) return null;
  if (messages === null || messageSteps < 1) return invites;
  return Math.min(invites, Math.floor(messages / messageSteps));
}

export function linkedinCapacityLine(capacity: { senders: number; invites: number | null; messages: number | null }, messageSteps: number) {
  const senders = capacity.senders === 1 ? "1 sender" : `${count(capacity.senders)} senders`;
  if (capacity.invites === null) return `${senders}.`;
  const fit = linkedinFit(capacity.invites, capacity.messages, messageSteps) ?? capacity.invites;
  return `${senders} ${capacity.senders === 1 ? "sends" : "send"} ${count(capacity.invites)} invites a day. About ${count(fit)} new prospects a day fit.`;
}
