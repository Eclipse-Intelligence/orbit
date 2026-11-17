import { PROVIDER_NAMES, type CampaignEventKind, type CampaignProviderId, type CampaignStats, type CampaignStatus, type CampaignSummary, type ProspectRow } from "@/lib/campaigns/types";
import { relativeWhen } from "@/lib/companies";

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  active: "Live",
  paused: "Paused",
  drafted: "Drafted",
  completed: "Completed",
  stopped: "Stopped",
  archived: "Archived",
};

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

export function contactedOf(stats: CampaignStats, prospects: number) {
  return stats.contacted ?? stats.prospects ?? prospects;
}

export function campaignRates(campaign: Pick<CampaignSummary, "stats" | "prospects" | "channel">) {
  const contacted = contactedOf(campaign.stats, campaign.prospects);
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

export function prospectTag(row: ProspectRow): { label: string; tone: TagTone } | null {
  if (row.stopRequestedAt && !row.stoppedAt) return { label: "Stopping", tone: "amber" };
  if (row.state === "skipped") return { label: "Skipped", tone: "neutral" };
  if (row.state === "failed") return { label: "Failed", tone: "red" };
  if (row.leadStatus === "bounced" || row.lastEvent?.kind === "bounced") return { label: "Bounced", tone: "red" };
  if (row.category) return { label: row.category, tone: categoryTone(row.category) };
  if (row.state === "queued" || row.state === "filling" || row.state === "pushing") return { label: "Queued", tone: "neutral" };
  if (row.stage === "accepted") return { label: "Accepted", tone: "neutral" };
  if (row.stage === "invited") return { label: "Invited", tone: "neutral" };
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
};

function when(iso: string, now: number) {
  const text = relativeWhen(iso, now);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function prospectLine(row: ProspectRow, now = Date.now()) {
  if (row.state === "skipped" || row.state === "failed") return row.skipReason ?? (row.state === "failed" ? "Failed" : "Skipped");
  if (row.importError) return row.importError;
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
