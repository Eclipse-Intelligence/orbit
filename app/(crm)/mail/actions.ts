"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { addPersonHere, setThreadDomainRule, setThreadFiling, type AddedPerson, type FilingChange } from "@/lib/mail/filing";
import { revalidateRecordPages } from "@/lib/revalidate";
import { removeDomainRule, setAddressHome } from "@/lib/mail/routing";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { COLD_PITCH_MODES, setMailHelp, type ColdPitchMode } from "@/lib/mail/prepare";
import { setReadStatuses } from "@/lib/mail/tracking";

export async function setReadStatusesAction(on: boolean): Promise<{ on?: boolean; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return { on: await setReadStatuses(user, Boolean(on)) };
  } catch {
    return { error: "That didn't save. Try again." };
  }
}

export async function setMailHelpAction(input: { prepareReplies?: boolean; autoRemindDays?: number | null; coldPitches?: ColdPitchMode }): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await setMailHelp(user, {
      prepareReplies: typeof input.prepareReplies === "boolean" ? input.prepareReplies : undefined,
      autoRemindDays: input.autoRemindDays === undefined ? undefined : input.autoRemindDays,
      coldPitches: COLD_PITCH_MODES.find((mode) => mode === input.coldPitches),
    });
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "That didn't save. Try again." };
  }
}

function filingError(error: unknown) {
  if (error instanceof CrmError) return { error: error.message };
  console.error("Filing mail failed", error);
  return { error: "That didn't file. Try again." };
}

function refreshFiled() {
  revalidatePath("/capture");
  revalidateRecordPages();
}

export async function setThreadFilingAction(key: string, workspaceIds: string[]): Promise<Partial<FilingChange> & { error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const change = await setThreadFiling(user, key, workspaceIds);
    refreshFiled();
    return change;
  } catch (error) {
    return filingError(error);
  }
}

export async function setThreadDomainRuleAction(key: string, workspaceIds: string[]): Promise<Partial<FilingChange> & { domain?: string; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const change = await setThreadDomainRule(user, key, workspaceIds);
    refreshFiled();
    return change;
  } catch (error) {
    return filingError(error);
  }
}

export async function addPersonHereAction(key: string, email: string): Promise<{ person?: AddedPerson; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    const person = await addPersonHere(user, key, email);
    refreshFiled();
    return { person };
  } catch (error) {
    return filingError(error);
  }
}

export async function setAddressHomeAction(address: string, workspaceId: string): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await setAddressHome(user, address, workspaceId);
    revalidatePath(SETTINGS_PATHS.integrations);
    revalidatePath("/capture");
    return {};
  } catch (error) {
    return error instanceof CrmError ? { error: error.message } : { error: "That didn't save. Try again." };
  }
}

export async function removeDomainRuleAction(domain: string): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await removeDomainRule(user, domain);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch {
    return { error: "That didn't save. Try again." };
  }
}
