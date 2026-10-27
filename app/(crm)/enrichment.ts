"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { createSuggestedCompany, suggestCompanyForEmail, type CompanySuggestion } from "@/lib/enrichment/companies";
import { enrichmentAllowed } from "@/lib/enrichment/limits";
import { getEnrichmentSettings, saveEnrichmentSettings, type EnrichmentSettings } from "@/lib/enrichment/settings";
import { backfillWebChecks, ensureDefaultSignals, icpProfile, markAllDue, listWebChecks, removeWebCheck, saveWebCheck, type CompanyCheck, type WebCheck } from "@/lib/enrichment/web-checks";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export async function saveEnrichmentSettingsAction(input: Partial<EnrichmentSettings>): Promise<EnrichmentSettings | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const before = await getEnrichmentSettings(user);
    const saved = await saveEnrichmentSettings(user, input);
    if (input.webSignals === true) await ensureDefaultSignals(user);
    if ((saved.webTags && !before.webTags) || (saved.webGaps && !before.webGaps)) await markAllDue(user);
    if (saved.webIcp && !saved.icpText && (await icpProfile(user))) return await getEnrichmentSettings(user);
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

function failure(error: unknown, fallback: string) {
  if (error instanceof CrmError) return { error: error.message };
  console.error(fallback, error);
  return { error: fallback };
}

export async function listWebChecksAction(): Promise<{ checks: WebCheck[] } | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return { checks: await listWebChecks(user) };
  } catch (error) {
    return failure(error, "Couldn't load the checks.");
  }
}

export async function saveWebCheckAction(input: { id?: string; kind: "tag" | "signal"; label: string; question: string; noteKind?: string }): Promise<{ check: WebCheck } | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const check = await saveWebCheck(user, input);
    revalidatePath(SETTINGS_PATHS.integrations);
    return { check };
  } catch (error) {
    return failure(error, "Couldn't save the check.");
  }
}

export async function removeWebCheckAction(id: string): Promise<{ removed: true } | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await removeWebCheck(user, id);
    revalidatePath(SETTINGS_PATHS.integrations);
    return { removed: true };
  } catch (error) {
    return failure(error, "Couldn't remove the check.");
  }
}

export async function backfillWebChecksAction(): Promise<{ results: (CompanyCheck & { companyId: string })[]; remaining: number } | { error: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return await backfillWebChecks(user);
  } catch (error) {
    return failure(error, "That stopped early. Try again.");
  }
}
