"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { removeCampaignConnection, saveCampaignConnection } from "@/lib/campaigns/connections";
import { syncCampaigns } from "@/lib/campaigns/sync";
import { importCampaignProspects, type ImportResult } from "@/lib/crm/campaigns";
import { CrmError } from "@/lib/crm/errors";
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
        await syncCampaigns({ workspaceId, deadline: Date.now() + FIRST_SYNC_MS });
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
