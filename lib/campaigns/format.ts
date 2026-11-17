import type { CampaignEventKind, CampaignStats, CampaignStatus, CampaignSummary, ProspectRow } from "@/lib/campaigns/types";
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

export function prospectTag(row: ProspectRow): { label: string; tone: TagTone } | null {
  if (row.stopRequestedAt && !row.stoppedAt) return { label: "Stopping", tone: "amber" };
  if (row.state === "skipped") return { label: "Skipped", tone: "neutral" };
  if (row.state === "failed") return { label: "Failed", tone: "red" };
  if (row.leadStatus === "bounced" || row.lastEvent?.kind === "bounced") return { label: "Bounced", tone: "red" };
  if (row.category) return { label: row.category, tone: categoryTone(row.category) };
  if (row.state === "queued" || row.state === "filling" || row.state === "pushing") return { label: "Queued", tone: "neutral" };
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
  if (row.repliedAt) return `Replied ${when(row.repliedAt, now)}`;
  const event = row.lastEvent;
  const word = event ? EVENT_WORDS[event.kind] : undefined;
  if (event && word) {
    const text = `${event.step ? `Step ${event.step} ` : ""}${word} ${when(event.at, now)}`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return "Added";
}
