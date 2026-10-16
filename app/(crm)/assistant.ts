"use server";

import { connectedProviders } from "@/lib/ai-accounts/store";
import type { ModelSource } from "@/lib/assistant/models";
import { listCompanions } from "@/lib/companion/pairing";
import { deleteConversation, getConversation, listConversations } from "@/lib/assistant/chat";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";

export async function listConversationsAction() {
  const user = await getUserActor();
  if (!user) return [];
  return listConversations(user);
}

export async function getConversationAction(id: string) {
  const user = await getUserActor();
  if (!user) return null;
  try {
    return await getConversation(user, id);
  } catch (error) {
    if (error instanceof CrmError) return null;
    throw error;
  }
}

export async function deleteConversationAction(id: string) {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await deleteConversation(user, id);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not delete that chat." };
  }
}

export async function connectedSourcesAction(): Promise<ModelSource[]> {
  const user = await getUserActor();
  if (!user) return [];
  try {
    const [providers, companions] = await Promise.all([connectedProviders(user), listCompanions(user)]);
    return [...providers, ...(companions.length > 0 ? (["claude"] as const) : [])];
  } catch (error) {
    console.error("Could not read AI accounts", error);
    return [];
  }
}
