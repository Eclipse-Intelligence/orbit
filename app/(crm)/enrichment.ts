"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { createSuggestedCompany, suggestCompanyForEmail, type CompanySuggestion } from "@/lib/enrichment/companies";
import { enrichmentAllowed } from "@/lib/enrichment/limits";
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

export async function suggestCompanyAction(email: string): Promise<CompanySuggestion> {
  const user = await getUserActor();
  if (!user) return { kind: "none" };
  try {
    if (!(await enrichmentAllowed(user.userId, 1))) return { kind: "none" };
    return await suggestCompanyForEmail(user, email);
  } catch (error) {
    if (!(error instanceof CrmError)) console.error("Company suggestion failed", error);
    return { kind: "none" };
  }
}

export async function addSuggestedCompanyAction(name: string, domain: string): Promise<{ id: string; name: string } | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const company = await createSuggestedCompany(user, name, domain);
    revalidatePath("/");
    return company;
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Adding the suggested company failed", error);
    return { error: "Couldn't add that company." };
  }
}
