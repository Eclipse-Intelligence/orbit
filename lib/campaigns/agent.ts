import type { ProviderOptions } from "@/lib/campaigns/context";
import { addedLine } from "@/lib/campaigns/format";
import { removeProspect, setCampaignPaused, setProspectCategory, setProspectPaused, startCampaign } from "@/lib/campaigns/manage";
import { addCompanyContacts, addProspects, type AddResult } from "@/lib/campaigns/prospects";
import { replyToProspect } from "@/lib/campaigns/replies";
import { campaignSenderNames } from "@/lib/campaigns/senders";
import { doNotContactFor } from "@/lib/campaigns/suppression";
import { getProspectThread } from "@/lib/campaigns/threads";
import { PROSPECT_FILTERS, type CampaignChannel, type ProspectFilter } from "@/lib/campaigns/types";
import { campaignChannel, campaignOfProspect, campaignSummaryOf, contactProspectId, getCampaign, listCampaignActivity, listCampaignProspects, listCampaigns } from "@/lib/crm/campaigns";
import { CrmError } from "@/lib/crm/errors";
import { isUuid, replayOrRunOutside, requestHash } from "@/lib/crm/mutate";
import { suppressedRefusal } from "@/lib/crm/suppressions";
import type { Actor, Provenance } from "@/lib/crm/types";
import { readDateTime } from "@/lib/time";

export const CAMPAIGN_READS = ["list", "campaign", "prospects", "thread", "activity"] as const;
export type CampaignRead = (typeof CAMPAIGN_READS)[number];

export const CAMPAIGN_ACTIONS = ["add", "start", "pause", "resume", "remove", "set_category", "reply"] as const;
export type CampaignActionName = (typeof CAMPAIGN_ACTIONS)[number];

export const NO_LIFT = "Only a person can lift Do not contact, from the person's page or thread in Orbit.";

export type CampaignReadInput = {
  view?: string | null;
  channel?: string | null;
  campaignId?: string | null;
  prospectId?: string | null;
  contactId?: string | null;
  filter?: string | null;
  search?: string | null;
  page?: number | null;
  kinds?: string[] | null;
  since?: string | null;
  until?: string | null;
  limit?: number | null;
};

export type ProspectTarget = { prospectId?: string | null; contactId?: string | null; campaignId?: string | null; channel?: string | null };

export type CampaignActionInput = ProspectTarget & {
  action?: string | null;
  contactIds?: string[] | null;
  companyIds?: string[] | null;
  category?: string | null;
  text?: string | null;
  clientKey?: string | null;
};

type ActionOptions = ProviderOptions & { provenance: Provenance; allowReply: boolean };

function needed(value: string | null | undefined, field: string, message: string) {
  if (!value) throw new CrmError("invalid_input", message, 400, { field });
  return value;
}

function when(value: string | null | undefined, field: string) {
  if (!value) return null;
  const reading = readDateTime(value);
  if (!reading.ok) throw new CrmError("invalid_input", `${field}: ${reading.error}`, 400, { field });
  return reading.date;
}

function filterOf(value: string | null | undefined): ProspectFilter | undefined {
  if (!value) return undefined;
  if ((PROSPECT_FILTERS as readonly string[]).includes(value)) return value as ProspectFilter;
  throw new CrmError("invalid_input", `filter is ${PROSPECT_FILTERS.join(", ")}.`, 400, { field: "filter" });
}

export async function resolveProspect(actor: Actor, target: ProspectTarget, options: { single?: boolean } = {}) {
  if (target.prospectId) return target.prospectId;
  const contactId = needed(target.contactId, "prospectId", "Say who: prospectId, or contactId.");
  return contactProspectId(actor, contactId, { channel: campaignChannel(target.channel), campaignId: target.campaignId ?? null, single: options.single });
}

export async function readCampaigns(actor: Actor, input: CampaignReadInput) {
  const view = (input.view || (input.prospectId || input.contactId ? "thread" : input.campaignId ? "campaign" : "list")) as string;
  const channel = campaignChannel(input.channel);
  switch (view) {
    case "list":
      return { campaigns: await listCampaigns(actor, { channel }) };
    case "campaign":
      return { campaign: await getCampaign(actor, needed(input.campaignId, "campaignId", "Pass campaignId from the list.")) };
    case "prospects":
      return {
        prospects: await listCampaignProspects(actor, needed(input.campaignId, "campaignId", "Pass campaignId from the list."), {
          filter: filterOf(input.filter),
          search: input.search ?? undefined,
          page: input.page ?? undefined,
        }),
      };
    case "thread":
      return { thread: await getProspectThread(actor, await resolveProspect(actor, input)) };
    case "activity":
      return listCampaignActivity(actor, {
        channel,
        campaignId: input.campaignId ?? null,
        kinds: input.kinds ?? null,
        since: when(input.since, "since"),
        until: when(input.until, "until"),
        limit: input.limit ?? undefined,
      });
    default:
      throw new CrmError("invalid_input", `view is ${CAMPAIGN_READS.join(", ")}.`, 400, { field: "view" });
  }
}

function addSummary(result: AddResult) {
  return { ...result, line: addedLine(result) };
}

function ids(value: string[] | null | undefined) {
  return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
}

export async function replyTarget(actor: Actor, target: ProspectTarget): Promise<{ prospectId: string; channel: CampaignChannel; senderName: string | null; reason: string | null; person: string; campaignName: string }> {
  const opened = await resolveProspect(actor, target);
  const thread = await getProspectThread(actor, opened);
  const own = target.prospectId ? thread.campaigns.find((item) => item.prospectId === opened)?.channel : null;
  const channel = campaignChannel(target.channel) ?? own ?? thread.defaultChannel;
  const option = thread.replyOptions.find((item) => item.channel === channel);
  if (!option) {
    throw new CrmError("conflict", channel === "linkedin" ? "There's no LinkedIn conversation to reply in." : "There's no campaign email to reply to.", 409, { field: "channel" });
  }
  return { prospectId: option.prospectId, channel: option.channel, senderName: option.senderName, reason: option.canReply ? null : option.reason, person: thread.person.name, campaignName: option.campaignName };
}

async function assertContactable(actor: Actor, target: { prospectId: string; person: string }) {
  if (await doNotContactFor(actor, { prospectId: target.prospectId })) throw suppressedRefusal([target.person]);
}

export async function replyInCampaign(actor: Actor, input: ProspectTarget & { text?: string | null; clientKey?: string | null }, options: ProviderOptions & { provenance: Provenance }) {
  const target = await replyTarget(actor, input);
  await assertContactable(actor, target);
  const result = await replyToProspect(actor, target.prospectId, { text: input.text ?? "", clientKey: input.clientKey ?? null }, options);
  return { ...result, prospectId: target.prospectId, channel: target.channel, campaign: await campaignOfProspect(actor, target.prospectId), to: target.person };
}

export async function runCampaignAction(actor: Actor, input: CampaignActionInput, options: ActionOptions) {
  const action = input.action ?? "";
  const { provenance, allowReply, ...provider } = options;
  if (/lift|unsuppress|do_not_contact|dnc/i.test(action)) throw new CrmError("forbidden", NO_LIFT, 403, { field: "action" });
  switch (action) {
    case "add": {
      const campaignId = needed(input.campaignId, "campaignId", "Pass campaignId from the list.");
      const contacts = ids(input.contactIds);
      const companies = ids(input.companyIds);
      if (contacts.length > 0 && companies.length > 0) throw new CrmError("invalid_input", "Send contactIds or companyIds, not both.", 400, { field: "companyIds" });
      if (companies.length > 0) return addSummary(await addCompanyContacts(actor, campaignId, companies, provenance));
      return addSummary(await addProspects(actor, campaignId, contacts, provenance));
    }
    case "start": {
      const campaignId = needed(input.campaignId, "campaignId", "Pass campaignId from the list.");
      const result = await startCampaign(actor, campaignId, { ...provider, provenance });
      return { ...result, campaign: await campaignSummaryOf(actor, campaignId) };
    }
    case "pause":
    case "resume": {
      const paused = action === "pause";
      if (input.campaignId && !input.prospectId && !input.contactId) {
        const result = await setCampaignPaused(actor, input.campaignId, paused, { ...provider, provenance });
        return { ...result, campaign: await campaignSummaryOf(actor, input.campaignId) };
      }
      const prospectId = await resolveProspect(actor, input, { single: true });
      const result = await setProspectPaused(actor, prospectId, paused, { ...provider, provenance });
      return { ...result, prospectId, campaign: await campaignOfProspect(actor, prospectId) };
    }
    case "remove": {
      const prospectId = await resolveProspect(actor, input, { single: true });
      const result = await removeProspect(actor, prospectId, { ...provider, provenance });
      return { ...result, prospectId, campaign: await campaignOfProspect(actor, prospectId) };
    }
    case "set_category": {
      if (input.category === undefined) throw new CrmError("invalid_input", "Pass category, or null to clear it.", 400, { field: "category" });
      const prospectId = await resolveProspect(actor, input, { single: true });
      const result = await setProspectCategory(actor, prospectId, input.category, { ...provider, provenance });
      return { ...result, prospectId, campaign: await campaignOfProspect(actor, prospectId) };
    }
    case "reply":
      if (!allowReply) throw new CrmError("forbidden", "Reply with campaign_reply.", 403, { field: "action" });
      return replyInCampaign(actor, input, { ...provider, provenance });
    default:
      throw new CrmError("invalid_input", `action is ${CAMPAIGN_ACTIONS.filter((name) => allowReply || name !== "reply").join(", ")}.`, 400, { field: "action" });
  }
}

function possessive(name: string) {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export function sendsFromLine(names: string[]) {
  const owned = names.map(possessive);
  const listed = owned.length === 1 ? owned[0] : `${owned.slice(0, -1).join(", ")} and ${owned[owned.length - 1]}`;
  return `Sends from ${listed} ${names.length === 1 ? "account" : "accounts"}.`;
}

export async function addProspectsFromApi(
  actor: Actor,
  campaignId: string,
  input: { contactIds?: string[]; companyIds?: string[] },
  options: { idempotencyKey?: string | null; provenance: Provenance },
) {
  const hash = requestHash("add_campaign_prospects", { campaignId, input, provenance: options.provenance });
  return replayOrRunOutside(actor, options.idempotencyKey, hash, 200, () =>
    runCampaignAction(actor, { action: "add", campaignId, contactIds: input.contactIds ?? null, companyIds: input.companyIds ?? null }, { provenance: options.provenance, allowReply: false }),
  );
}

export async function campaignActionNames(actor: Actor, input: CampaignActionInput): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  if (input.campaignId && isUuid(input.campaignId)) {
    const campaign = await getCampaign(actor, input.campaignId).catch(() => null);
    if (campaign) {
      names[input.campaignId] = campaign.name;
      names[`${input.campaignId}:channel`] = campaign.channel;
      if (campaign.channel === "linkedin" && input.action === "add") {
        const senders = await campaignSenderNames(actor, input.campaignId).catch(() => []);
        if (senders.length > 0) names["add:senders"] = sendsFromLine(senders);
      }
    }
  }
  const action = input.action ?? "";
  if (!["pause", "resume", "remove", "set_category", "reply"].includes(action)) return names;
  if (action === "reply") {
    const target = await replyTarget(actor, input).catch(() => null);
    if (target) {
      names["reply:person"] = target.person;
      names["reply:channel"] = target.channel;
      names["reply:campaign"] = target.campaignName;
      if (target.senderName) names["reply:sender"] = target.senderName;
      const blocked = await assertContactable(actor, target).then(
        () => null,
        (error: unknown) => (error instanceof CrmError ? error.message : null),
      );
      const refused = target.reason ?? blocked;
      if (refused) names["reply:refused"] = refused;
    }
    return names;
  }
  if (action !== "remove" && action !== "set_category" && input.campaignId && !input.prospectId && !input.contactId) return names;
  const prospectId = await resolveProspect(actor, input, { single: true }).catch((error: unknown) => {
    if (error instanceof CrmError && error.status < 500) names["prospect:refused"] = error.message;
    return null;
  });
  if (!prospectId) return names;
  const thread = await getProspectThread(actor, prospectId).catch(() => null);
  const row = thread?.campaigns.find((item) => item.prospectId === prospectId);
  if (thread && row) {
    names["prospect:person"] = thread.person.name;
    names["prospect:campaign"] = row.name;
  }
  return names;
}
