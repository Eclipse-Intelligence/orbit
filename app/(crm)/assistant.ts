"use server";

import type { ModelSource } from "@/lib/assistant/models";
import { connectedSources, deleteConversation, getConversation, listConversations, stopConversation } from "@/lib/assistant/chat";
import { discardChatFiles, prepareChatFile, type PreparedChatFile } from "@/lib/assistant/files";
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

export async function stopConversationAction(id: string) {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    await stopConversation(user, id);
    return {};
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Could not stop that answer." };
  }
}

export async function connectedSourcesAction(): Promise<ModelSource[] | null> {
  const user = await getUserActor();
  if (!user) return null;
  try {
    return await connectedSources(user);
  } catch (error) {
    console.error("Could not read AI accounts", error);
    return null;
  }
}

export async function prepareChatFileAction(file: { name: string; size: number; contentType: string }): Promise<{ attachment?: PreparedChatFile; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to attach files." };
  try {
    return { attachment: await prepareChatFile(user, file) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Could not prepare a chat file", error);
    return { error: "Couldn't attach the file. Try again." };
  }
}

export async function discardChatFilesAction(ids: string[]) {
  const user = await getUserActor();
  if (!user) return;
  await discardChatFiles(user, ids).catch(() => undefined);
}
