"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { OAuthError } from "@/lib/ai-accounts/oauth";
import {
  disconnectAiAccount,
  pollChatGptLogin,
  startChatGptLogin,
} from "@/lib/ai-accounts/store";
import { getUserActor } from "@/lib/auth/user";
import { createPairingCode, listCompanions, revokeCompanion, type CompanionSummary } from "@/lib/companion/pairing";
import { CrmError } from "@/lib/crm/errors";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function failed(error: unknown, fallback: string) {
  if (error instanceof OAuthError) return { error: error.message };
  console.error(fallback, error);
  return { error: fallback };
}

export async function startChatGptAction() {
  const user = await requireUser();
  try {
    return await startChatGptLogin(user);
  } catch (error) {
    return failed(error, "ChatGPT sign-in couldn't start. Try again.");
  }
}

export async function pollChatGptAction() {
  const user = await requireUser();
  try {
    const result = await pollChatGptLogin(user);
    if (result.status === "connected") revalidatePath(SETTINGS_PATHS.integrations);
    return result;
  } catch (error) {
    return { status: "failed" as const, ...failed(error, "ChatGPT sign-in failed. Try again.") };
  }
}

export async function disconnectAiAccountAction(provider: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await disconnectAiAccount(user, provider);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch (error) {
    return failed(error, "Couldn't disconnect that account.");
  }
}

export async function createPairingCodeAction(): Promise<{ code: string; expiresAt: string } | { error: string }> {
  const user = await requireUser();
  try {
    return await createPairingCode(user);
  } catch (error) {
    console.error("Could not create a pairing code", error);
    return { error: "Couldn't make a pairing code. Try again." };
  }
}

export async function listCompanionsAction(): Promise<CompanionSummary[]> {
  const user = await requireUser();
  return listCompanions(user);
}

export async function revokeCompanionAction(id: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await revokeCompanion(user, id);
    revalidatePath(SETTINGS_PATHS.integrations);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't remove that Mac." };
  }
}
