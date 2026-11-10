"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { issueMarketAgentToken } from "@/lib/learning/grok";
import { addWatchItems, deleteMarketNote, removeWatchItems } from "@/lib/learning/market";
import { forgetMemory, rememberNote, updateMemory } from "@/lib/learning/memories";
import { learnNow } from "@/lib/learning/nightly";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function failure(error: unknown, fallback: string) {
  return { error: error instanceof CrmError ? error.message : fallback, field: error instanceof CrmError && typeof error.details?.field === "string" ? error.details.field : undefined };
}

async function act<T>(fallback: string, work: (user: Awaited<ReturnType<typeof requireUser>>) => Promise<T>): Promise<{ error?: string; field?: string; result?: T }> {
  const user = await requireUser();
  try {
    const result = await work(user);
    revalidatePath(SETTINGS_PATHS.learning);
    revalidatePath(SETTINGS_PATHS.memory);
    return { result };
  } catch (error) {
    return failure(error, fallback);
  }
}

export async function addMemoryAction(input: { title: string; body: string; shared: boolean; allWorkspaces?: boolean }) {
  return act("Couldn't save the note.", (user) => rememberNote(user, input, "manual"));
}

export async function updateMemoryAction(id: string, patch: { title?: string; body?: string; pinned?: boolean; allWorkspaces?: boolean }) {
  return act("Couldn't update the note.", (user) => updateMemory(user, id, patch));
}

export async function forgetMemoryAction(id: string) {
  return act("Couldn't forget the note.", (user) => forgetMemory(user, id));
}

export async function addWatchAction(item: { kind: string; label: string; url: string; notes: string }) {
  return act("Couldn't add it to the watchlist.", (user) => addWatchItems(user, [item]));
}

export async function removeWatchAction(id: string) {
  return act("Couldn't remove it.", (user) => removeWatchItems(user, [id]));
}

export async function deleteMarketNoteAction(id: string) {
  return act("Couldn't delete the note.", (user) => deleteMarketNote(user, id));
}

export async function connectGrokAction() {
  return act("Couldn't create the Grok Bot token.", (user) => issueMarketAgentToken(user));
}

export async function learnNowAction() {
  return act("Learning didn't finish. It will run again tonight.", (user) => learnNow(user, { deadline: Date.now() + 270_000 }));
}
