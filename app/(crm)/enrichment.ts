"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { saveEnrichmentSettings, type EnrichmentSettings } from "@/lib/enrichment/settings";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export async function saveEnrichmentSettingsAction(input: Partial<EnrichmentSettings>): Promise<EnrichmentSettings | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const saved = await saveEnrichmentSettings(user, input);
    revalidatePath(SETTINGS_PATHS.integrations);
    return saved;
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Saving enrichment settings failed", error);
    return { error: "Couldn't save. Try again." };
  }
}
