"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { OAuthError } from "@/lib/ai-accounts/oauth";
import {
  disconnectAiAccount,
  finishClaudeLogin,
  pollChatGptLogin,
  startChatGptLogin,
  startClaudeLogin,
} from "@/lib/ai-accounts/store";
import { getUserActor } from "@/lib/auth/user";
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

export async function startClaudeAction() {
  const user = await requireUser();
  try {
    return await startClaudeLogin(user);
  } catch (error) {
    return failed(error, "Claude sign-in couldn't start. Try again.");
  }
}

export async function finishClaudeAction(code: string) {
  const user = await requireUser();
  try {
    const result = await finishClaudeLogin(user, typeof code === "string" ? code : "");
    revalidatePath(SETTINGS_PATHS.integrations);
    return result;
  } catch (error) {
    return failed(error, "Claude sign-in failed. Try again.");
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
