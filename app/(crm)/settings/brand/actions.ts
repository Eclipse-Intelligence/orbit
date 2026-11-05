"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { draftBrandFromWebsite, saveBrandPlaybook, saveBrandProfile, setEclipseTools, type BrandDraft, type BrandProfile } from "@/lib/crm/brand";
import { CrmError } from "@/lib/crm/errors";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

type Result<T> = { error?: string; field?: string } & T;

const WEB = { source: "web" };

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function failure(error: unknown, fallback: string) {
  if (error instanceof CrmError) return { error: error.message, field: typeof error.details?.field === "string" ? error.details.field : undefined };
  console.error(fallback, error);
  return { error: fallback };
}

export async function saveBrandProfileAction(input: unknown): Promise<Result<{ saved?: BrandProfile }>> {
  const user = await requireUser();
  try {
    const saved = await saveBrandProfile(user, input, { ...WEB, operation: "save_brand_profile" });
    revalidatePath(SETTINGS_PATHS.brand, "layout");
    return { saved };
  } catch (error) {
    return failure(error, "Could not save the brand profile.");
  }
}

export async function draftBrandAction(input: { website: string }): Promise<Result<{ draft?: BrandDraft }>> {
  const user = await requireUser();
  try {
    return { draft: await draftBrandFromWebsite(user, input, { deadline: Date.now() + 90_000 }) };
  } catch (error) {
    return failure(error, "Could not draft from the website.");
  }
}

export async function setEclipseToolsAction(enabled: boolean): Promise<Result<{ saved?: BrandProfile }>> {
  const user = await requireUser();
  try {
    const saved = await setEclipseTools(user, enabled, { ...WEB, operation: "set_eclipse_tools" });
    revalidatePath(SETTINGS_PATHS.brand, "layout");
    return { saved };
  } catch (error) {
    return failure(error, "Could not change Eclipse tools.");
  }
}

export async function saveBrandPlaybookAction(input: unknown): Promise<Result<{ saved?: BrandProfile }>> {
  const user = await requireUser();
  try {
    const saved = await saveBrandPlaybook(user, input, { ...WEB, operation: "save_cold_email_playbook" });
    revalidatePath(SETTINGS_PATHS.brand, "layout");
    return { saved };
  } catch (error) {
    return failure(error, "Could not save the playbook.");
  }
}
