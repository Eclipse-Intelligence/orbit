import type { CampaignChannel } from "@/lib/campaigns/types";
import type { CampaignLine, CampaignTimelineRow, ReplyOption, ThreadCampaign, ThreadItem, ThreadMessage, ThreadNote } from "@/lib/campaigns/threads";
import { appTimeZone } from "@/lib/time";

export const SEND_FAILED = "Couldn't send. Try again.";

export type PendingReply = {
  clientKey: string;
  prospectId: string;
  channel: CampaignChannel;
  text: string;
  at: string;
  state: "sending" | "sent" | "failed";
  messageId: string | null;
  error: string | null;
};

export type ShownItem = ThreadItem | { type: "pending"; id: string; reply: PendingReply };

const CLIENT_KEY = /^[A-Za-z0-9_:.-]{1,200}$/;

export function newClientKey(random: () => string = () => globalThis.crypto.randomUUID()) {
  const key = `web-${random()}`;
  return CLIENT_KEY.test(key) ? key : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function serverKeys(items: ThreadItem[]) {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.type !== "message") continue;
    keys.add(`id:${item.id}`);
    if (item.clientKey) keys.add(`key:${item.clientKey}`);
  }
  return keys;
}

export function unsettled(items: ThreadItem[], pending: PendingReply[]) {
  const keys = serverKeys(items);
  return pending.filter((reply) => !keys.has(`key:${reply.clientKey}`) && !(reply.messageId && keys.has(`id:${reply.messageId}`)));
}

export function withPending(items: ThreadItem[], pending: PendingReply[]): ShownItem[] {
  const left = unsettled(items, pending);
  if (left.length === 0) return items;
  return [...items, ...left.map((reply) => ({ type: "pending" as const, id: `pending:${reply.clientKey}`, reply }))];
}

export type DraftRestore = { text: string; channel: CampaignChannel; at: number };

export function withoutReply(pending: PendingReply[], clientKey: string) {
  return pending.filter((reply) => reply.clientKey !== clientKey);
}

export function draftAfterRestore(current: string, restore: DraftRestore) {
  return current.trim() ? current : restore.text;
}

export function retryable(message: ThreadMessage) {
  return message.direction === "outbound" && message.sendState === "failed" && Boolean(message.clientKey);
}

export function replyChannel(options: ReplyOption[], preferred: CampaignChannel, current?: CampaignChannel | null): CampaignChannel | null {
  if (options.length === 0) return null;
  if (current && options.some((option) => option.channel === current)) return current;
  const usable = options.filter((option) => option.canReply);
  return (usable.find((option) => option.channel === preferred) ?? usable[0] ?? options.find((option) => option.channel === preferred) ?? options[0]).channel;
}

export function shortDay(iso: string, timeZone = appTimeZone(), now = Date.now()) {
  const at = new Date(iso);
  const year = (date: Date | number) => new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(date);
  const sameYear = year(at) === year(now);
  return new Intl.DateTimeFormat("en-GB", sameYear ? { day: "numeric", month: "short", timeZone } : { day: "numeric", month: "short", year: "numeric", timeZone }).format(at);
}

export function noteLabel(note: ThreadNote, timeZone = appTimeZone(), now = Date.now()) {
  if (note.kind === "accepted") return `Accepted ${shortDay(note.at, timeZone, now)}`;
  return note.text;
}

const STATE_WORDS: Record<ThreadCampaign["state"], string> = {
  queued: "queued",
  running: "running",
  paused: "paused",
  replied: "replied",
  stopping: "stopping",
  stopped: "stopped",
  removed: "removed",
  finished: "finished",
  skipped: "skipped",
  failed: "failed",
};

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function campaignStateLine(campaign: ThreadCampaign) {
  const reason = (campaign.state === "skipped" || campaign.state === "failed") && campaign.skipReason ? lowerFirst(campaign.skipReason) : STATE_WORDS[campaign.state];
  return `${campaign.name} · ${reason}`;
}

const DATED_LINES = new Set(["Replied", "Accepted", "Invited", "Bounced"]);

export function contactLineText(line: CampaignLine, timeZone = appTimeZone(), now = Date.now()) {
  const label = line.at && DATED_LINES.has(line.label) ? `${line.label} ${shortDay(line.at, timeZone, now)}` : line.label;
  return `${label} · ${line.campaignName}`;
}

export function sourceLink(source: string | null): { label: string; href: string | null } | null {
  const text = source?.trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return { label: text, href: null };
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { label: text, href: null };
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return { label: `${url.hostname.replace(/^www\./, "")}${path}`, href: url.href };
  } catch {
    return { label: text, href: null };
  }
}

export type TimelineEntry<A> = { type: "activity"; id: string; occurredAt: string; activity: A } | { type: "campaign"; id: string; occurredAt: string; row: CampaignTimelineRow };

export function timelineEntries<A extends { id: string; occurredAt: string }>(activities: A[], campaignRows: CampaignTimelineRow[]): TimelineEntry<A>[] {
  return [
    ...activities.map((activity) => ({ type: "activity" as const, id: activity.id, occurredAt: activity.occurredAt, activity })),
    ...campaignRows.map((row) => ({ type: "campaign" as const, id: `campaign:${row.id}`, occurredAt: row.at, row })),
  ];
}

export function campaignRowMeta(row: CampaignTimelineRow) {
  return [row.campaignName, row.detail].filter(Boolean).join(" · ");
}

export function messageStatus(message: Pick<ThreadMessage, "direction" | "sendState" | "automatic">) {
  if (message.direction === "inbound") return message.automatic ? "Automatic reply" : null;
  if (message.sendState === "sending") return "Sending…";
  if (message.sendState === "failed") return "Couldn't send.";
  if (message.sendState === "unknown") return "May not have gone.";
  return null;
}
