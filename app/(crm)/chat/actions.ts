"use server";

import { getUserActor } from "@/lib/auth/user";
import type { ChatConversation, ChatMessage, ChatPost, ChatResult } from "@/lib/chat/types";
import {
  addRoomMembers,
  createRoom,
  deleteMessage,
  editMessage,
  leaveRoom,
  openDm,
  postMessage,
  removeRoomMember,
  updateRoom,
} from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";

async function run<T extends object>(fallback: string, work: (actor: UserActor) => Promise<T>): Promise<ChatResult<T>> {
  try {
    const actor = await getUserActor();
    if (!actor) return { error: "Your session ended. Sign in again." };
    return { ok: true, ...(await work(actor)) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Chat action failed", error);
    return { error: fallback };
  }
}

export async function createRoomAction(input: { name: string; workspaceId?: string | null; memberIds?: string[] }): Promise<ChatResult<{ conversation: ChatConversation }>> {
  return run("Couldn't create the room. Try again.", async (actor) => ({ conversation: await createRoom(actor, input ?? {}) }));
}

export async function updateRoomAction(id: string, input: { name?: string; workspaceId?: string | null }): Promise<ChatResult<{ conversation: ChatConversation }>> {
  return run("Couldn't save the room. Try again.", async (actor) => ({ conversation: await updateRoom(actor, id, input ?? {}) }));
}

export async function addRoomMembersAction(id: string, userIds: string[]): Promise<ChatResult<{ added: string[] }>> {
  return run("Couldn't add them. Try again.", (actor) => addRoomMembers(actor, id, userIds));
}

export async function removeRoomMemberAction(id: string, userId: string): Promise<ChatResult<{ deleted: boolean }>> {
  return run("Couldn't remove them. Try again.", (actor) => removeRoomMember(actor, id, userId));
}

export async function leaveRoomAction(id: string): Promise<ChatResult<{ deleted: boolean }>> {
  return run("Couldn't leave the room. Try again.", (actor) => leaveRoom(actor, id));
}

export async function openDmAction(userId: string): Promise<ChatResult<{ conversation: ChatConversation }>> {
  return run("Couldn't open the conversation. Try again.", async (actor) => ({ conversation: await openDm(actor, userId) }));
}

export async function postMessageAction(input: { conversationId: string; parentId?: string | null; body: string; clientKey: string }): Promise<ChatResult<ChatPost>> {
  return run("Couldn't send. Try again.", (actor) => postMessage(actor, input ?? {}));
}

export async function editMessageAction(id: string, body: string): Promise<ChatResult<{ message: ChatMessage }>> {
  return run("Couldn't save the message. Try again.", async (actor) => ({ message: await editMessage(actor, id, body) }));
}

export async function deleteMessageAction(id: string): Promise<ChatResult<{ deleted: true }>> {
  return run("Couldn't delete the message. Try again.", (actor) => deleteMessage(actor, id));
}
