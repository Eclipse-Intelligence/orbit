"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { removeCampaignConnection, saveCampaignConnection } from "@/lib/campaigns/connections";
import { handleCampaignEvents } from "@/lib/campaigns/events";
import { addedLine, campaignThreadPath } from "@/lib/campaigns/format";
import { addCompanyContacts, addProspects, saveCampaignVariables } from "@/lib/campaigns/prospects";
import type { VariableBrief } from "@/lib/campaigns/types";
import { removeProspect, setCampaignAutoAdd, setCampaignPaused, setProspectCategory, setProspectPaused, startCampaign, type RemoveResult } from "@/lib/campaigns/manage";
import { replyToProspect, type ReplyResult } from "@/lib/campaigns/replies";
import { linkCampaignSender } from "@/lib/campaigns/senders";
import { liftDoNotContact, setDoNotContact, type DoNotContactTarget } from "@/lib/campaigns/suppression";
import { syncCampaigns } from "@/lib/campaigns/sync";
import { refreshProspectThread } from "@/lib/campaigns/threads";
import { importCampaignProspect, importCampaignProspects, type ImportResult } from "@/lib/crm/campaigns";
import { CrmError } from "@/lib/crm/errors";
import { contactHref } from "@/lib/crm/hrefs";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

const IMPORT_BUDGET_MS = 45_000;
const FIRST_SYNC_MS = 40_000;

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function syncSoon(workspaceId: string) {
  try {
    after(async () => {
      try {
        await syncCampaigns({ workspaceId, deadline: Date.now() + FIRST_SYNC_MS, onEvents: handleCampaignEvents });
      } catch (error) {
        console.error("Campaign sync after connecting failed", error);
      }
    });
  } catch (error) {
    console.error("Couldn't start the campaign sync", error);
  }
}

export async function saveCampaignConnectionAction(provider: string, key: string): Promise<{ error?: string; line?: string }> {
  const user = await requireUser();
  try {
    const saved = await saveCampaignConnection(user, provider, key);
    syncSoon(user.workspaceId);
    revalidatePath(SETTINGS_PATHS.tools);
    revalidatePath("/campaigns");
    return { line: saved.line };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't save the key. Try again." };
  }
}

export async function removeCampaignConnectionAction(provider: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await removeCampaignConnection(user, provider);
    revalidatePath(SETTINGS_PATHS.tools);
    revalidatePath("/campaigns");
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't disconnect. Try again." };
  }
}

export async function importCampaignProspectsAction(campaignId: string): Promise<{ error?: string; result?: ImportResult }> {
  const user = await requireUser();
  try {
    const result = await importCampaignProspects(user, campaignId, { deadline: Date.now() + IMPORT_BUDGET_MS });
    revalidatePath(`/campaigns/${campaignId}`);
    return { result };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't import. Try again." };
  }
}

export async function importCampaignProspectAction(campaignId: string, prospectId: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await importCampaignProspect(user, prospectId);
    revalidatePath(`/campaigns/${campaignId}`);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't import. Try again." };
  }
}

export async function setCampaignAutoAddAction(campaignId: string, value: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await setCampaignAutoAdd(user, campaignId, value);
    revalidatePath(`/campaigns/${campaignId}`);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't save. Try again." };
  }
}

function revalidateCampaign(campaignId?: string | null, prospectId?: string | null) {
  revalidatePath("/campaigns");
  if (campaignId) revalidatePath(`/campaigns/${campaignId}`);
  if (prospectId) revalidatePath(campaignThreadPath(prospectId));
}

function errorText(error: unknown, fallback: string) {
  return error instanceof CrmError ? error.message : fallback;
}

export async function replyToProspectAction(
  prospectId: string,
  text: string,
  clientKey: string,
): Promise<{ error?: string; stored?: boolean; retryable?: boolean; result?: ReplyResult }> {
  const user = await requireUser();
  try {
    const result = await replyToProspect(user, prospectId, { text, clientKey });
    revalidateCampaign(null, prospectId);
    return { result };
  } catch (error) {
    const stored = error instanceof CrmError && typeof error.details?.messageId === "string";
    if (stored) revalidateCampaign(null, prospectId);
    const retryable = stored || !(error instanceof CrmError) || error.status === 429 || error.status >= 500;
    return { error: errorText(error, "Couldn't send. Try again."), stored, retryable };
  }
}

export async function refreshProspectThreadAction(prospectId: string): Promise<{ error?: string; saved?: number }> {
  const user = await requireUser();
  try {
    const { saved } = await refreshProspectThread(user, prospectId);
    if (saved > 0) revalidateCampaign(null, prospectId);
    return { saved };
  } catch (error) {
    return { error: errorText(error, "Couldn't read the conversation. Try again.") };
  }
}

export async function setCampaignPausedAction(campaignId: string, paused: boolean): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await setCampaignPaused(user, campaignId, paused);
    revalidateCampaign(campaignId);
    return {};
  } catch (error) {
    return { error: errorText(error, paused ? "Couldn't pause the campaign. Try again." : "Couldn't resume the campaign. Try again.") };
  }
}

export async function startCampaignAction(campaignId: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await startCampaign(user, campaignId);
    revalidateCampaign(campaignId);
    return {};
  } catch (error) {
    return { error: errorText(error, "Couldn't start the campaign. Try again.") };
  }
}

export async function setProspectPausedAction(prospectId: string, paused: boolean): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await setProspectPaused(user, prospectId, paused);
    revalidateCampaign(null, prospectId);
    return {};
  } catch (error) {
    return { error: errorText(error, paused ? "Couldn't pause. Try again." : "Couldn't resume. Try again.") };
  }
}

export async function removeProspectAction(prospectId: string): Promise<{ error?: string; result?: RemoveResult }> {
  const user = await requireUser();
  try {
    const result = await removeProspect(user, prospectId);
    revalidateCampaign(null, prospectId);
    return { result };
  } catch (error) {
    return { error: errorText(error, "Couldn't remove. Try again.") };
  }
}

export async function setProspectCategoryAction(prospectId: string, category: string | null): Promise<{ error?: string; category?: string | null }> {
  const user = await requireUser();
  try {
    const result = await setProspectCategory(user, prospectId, category);
    revalidateCampaign(null, prospectId);
    return { category: result.category };
  } catch (error) {
    return { error: errorText(error, "Couldn't save. Try again.") };
  }
}

export async function linkCampaignSenderAction(senderId: string, userId: string | null): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await linkCampaignSender(user, senderId, userId);
    revalidatePath(SETTINGS_PATHS.tools);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't save. Try again." };
  }
}

function revalidatePerson(target: DoNotContactTarget) {
  if ("prospectId" in target) revalidatePath(campaignThreadPath(target.prospectId));
  if ("contactId" in target) revalidatePath(contactHref(target.contactId));
  revalidatePath("/campaigns");
}

export async function setDoNotContactAction(target: DoNotContactTarget): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await setDoNotContact(user, target);
    revalidatePerson(target);
    return {};
  } catch (error) {
    return { error: errorText(error, "Couldn't save. Try again.") };
  }
}

export async function liftDoNotContactAction(target: DoNotContactTarget): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await liftDoNotContact(user, target);
    revalidatePerson(target);
    return {};
  } catch (error) {
    return { error: errorText(error, "Couldn't lift. Try again.") };
  }
}

export async function addToCampaignAction(
  campaignId: string,
  kind: "contact" | "company",
  ids: string[],
): Promise<{ error?: string; message?: string }> {
  const user = await requireUser();
  try {
    const provenance = { operation: "add_to_campaign", source: "web" };
    const result = kind === "company" ? await addCompanyContacts(user, campaignId, ids, provenance) : await addProspects(user, campaignId, ids, provenance);
    revalidateCampaign(campaignId);
    return { message: addedLine(result) };
  } catch (error) {
    return { error: errorText(error, "Couldn't add to the campaign. Try again.") };
  }
}

export async function saveCampaignVariablesAction(campaignId: string, variables: VariableBrief[]): Promise<{ error?: string; briefs?: VariableBrief[] }> {
  const user = await requireUser();
  try {
    const briefs = await saveCampaignVariables(user, campaignId, variables, { operation: "save_campaign_variables", source: "web" });
    revalidateCampaign(campaignId);
    return { briefs };
  } catch (error) {
    return { error: errorText(error, "Couldn't save. Try again.") };
  }
}
