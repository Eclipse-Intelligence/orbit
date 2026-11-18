import type { CampaignEvent, Trigger } from "@/lib/workflows/definition";

export type CampaignTrigger = Extract<Trigger, { type: "campaign_event" }>;
type Channel = "email" | "linkedin";
type CampaignChoice = { id: string; channel: Channel };

function stepFields(trigger: CampaignTrigger, channel: Channel): Partial<CampaignTrigger> {
  return channel === "email" ? { step: trigger.step ?? 1, action: null, nth: null } : { step: null, action: trigger.action ?? "invite_sent" };
}

export function withCampaignEvent(trigger: CampaignTrigger, event: CampaignEvent, campaigns: CampaignChoice[]): CampaignTrigger {
  if (event !== "step") return { type: trigger.type, event, channel: trigger.channel ?? null, campaignId: trigger.campaignId ?? null, campaignName: trigger.campaignName };
  const picked = campaigns.find((item) => item.id === trigger.campaignId)?.channel ?? null;
  const channel: Channel = picked ?? trigger.channel ?? "email";
  return { ...trigger, event, channel, ...stepFields(trigger, channel) };
}

export function withCampaignChannel(trigger: CampaignTrigger, value: Channel | null, campaigns: CampaignChoice[]): CampaignTrigger {
  const keepCampaign = !trigger.campaignId || value === null || campaigns.some((item) => item.id === trigger.campaignId && item.channel === value);
  const base: CampaignTrigger = { ...trigger, channel: value, ...(keepCampaign ? {} : { campaignId: null, campaignName: "" }) };
  if (trigger.event !== "step") return base;
  const channel: Channel = value ?? "email";
  return { ...base, channel, ...stepFields(trigger, channel) };
}
