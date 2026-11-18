import type { CampaignChannel } from "@/lib/campaigns/types";

export const CONVERSATION_SHOWS = ["needs_reply", "all", "linkedin", "email"] as const;
export type ConversationShow = (typeof CONVERSATION_SHOWS)[number];

export type ConversationView = { show: ConversationShow; campaignId: string | null; search: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

export function readConversationView(params: Record<string, string | string[] | undefined>): ConversationView {
  const show = one(params.show);
  const campaign = one(params.campaign);
  return {
    show: (CONVERSATION_SHOWS as readonly string[]).includes(show) ? (show as ConversationShow) : "needs_reply",
    campaignId: UUID.test(campaign) ? campaign.toLowerCase() : null,
    search: one(params.q).trim().slice(0, 200),
  };
}

export function conversationFilters(view: ConversationView): { needsReply: boolean; channel: CampaignChannel | null; campaignId: string | null; search: string } {
  return {
    needsReply: view.show === "needs_reply",
    channel: view.show === "linkedin" || view.show === "email" ? view.show : null,
    campaignId: view.campaignId,
    search: view.search,
  };
}

export function conversationsHref(view: ConversationView, prospectId: string | null) {
  const params = new URLSearchParams();
  if (view.show !== "needs_reply") params.set("show", view.show);
  if (view.campaignId) params.set("campaign", view.campaignId);
  if (view.search) params.set("q", view.search);
  const query = params.toString();
  return `/campaigns/conversations${prospectId ? `/${prospectId}` : ""}${query ? `?${query}` : ""}`;
}

export function adoptSearch(input: { value: string; sent: string; text: string }) {
  return input.value !== input.sent && input.text.trim() === input.sent;
}
