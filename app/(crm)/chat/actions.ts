"use server";

import { getUserActor } from "@/lib/auth/user";
import type { ChatFormat } from "@/lib/chat/markdown";
import type { ChatConversation, ChatHook, ChatHookSecret, ChatMessage, ChatNeedsShare, ChatNotifyInput, ChatPost, ChatReacted, ChatRemindWhen, ChatResult, ChatSavedState, ChatUpload } from "@/lib/chat/types";
import {
  addRoomMembers,
  createRoom,
  deleteMessage,
  editMessage,
  leaveRoom,
  markAllChatRead,
  markConversationUnread,
  openDm,
  openGroup,
  postMessage,
  reactToMessage,
  removeRoomMember,
  setConversationNotify,
  setRoomArchived,
  updateRoom,
} from "@/lib/crm/chat";
import { discardChatUploads, prepareChatUpload } from "@/lib/crm/chat-attachments";
import { remindAboutMessage, setMessageSaved } from "@/lib/crm/chat-saved";
import { createHook, deleteHook, listHooks, rotateHookSecret, setHookPaused } from "@/lib/crm/chat-hooks";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Reminder } from "@/lib/crm/reminders";
import type { UserActor } from "@/lib/crm/types";

function needsShare(error: CrmError): { needsShare?: ChatNeedsShare } {
  const value = error.details?.needsShare as ChatNeedsShare | undefined;
  return value ? { needsShare: value } : {};
}

async function run<T extends object>(fallback: string, work: (actor: UserActor) => Promise<T>): Promise<ChatResult<T>> {
  try {
    const actor = await getUserActor();
    if (!actor) return { error: "Your session ended. Sign in again." };
    return { ok: true, ...(await work(actor)) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message, ...needsShare(error) };
    console.error("Chat action failed", error);
    return { error: fallback };
  }
}

export async function createRoomAction(input: { name: string; workspaceId?: string | null; memberIds?: string[] }): Promise<ChatResult<{ conversation: ChatConversation }>> {
  return run("Couldn't create the room. Try again.", async (actor) => ({ conversation: await createRoom(actor, input ?? {}) }));
}

export async function updateRoomAction(id: string, input: { name?: string; workspaceId?: string | null; topic?: string | null }): Promise<ChatResult<{ conversation: ChatConversation }>> {
  return run("Couldn't save the room. Try again.", async (actor) => ({ conversation: await updateRoom(actor, id, input ?? {}) }));
}

export async function setRoomArchivedAction(id: string, archived: boolean): Promise<ChatResult<{ conversation: ChatConversation }>> {
  return run(archived ? "Couldn't archive the room. Try again." : "Couldn't unarchive the room. Try again.", async (actor) => ({
    conversation: await setRoomArchived(actor, id, archived === true),
  }));
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

export async function openGroupAction(userIds: string[]): Promise<ChatResult<{ conversation: ChatConversation }>> {
  return run("Couldn't open the conversation. Try again.", async (actor) => ({ conversation: await openGroup(actor, userIds) }));
}

export async function postMessageAction(input: {
  conversationId: string;
  parentId?: string | null;
  body: string;
  format?: ChatFormat;
  clientKey: string;
  attachmentIds?: string[];
}): Promise<ChatResult<ChatPost>> {
  return run("Couldn't send. Try again.", (actor) => postMessage(actor, input ?? {}, { roomMention: true }));
}

export async function editMessageAction(id: string, body: string, format?: ChatFormat, removeAttachmentIds?: string[]): Promise<ChatResult<{ message: ChatMessage }>> {
  return run("Couldn't save the message. Try again.", async (actor) => ({ message: await editMessage(actor, id, body, { format, roomMention: true, removeAttachmentIds }) }));
}

export async function prepareChatUploadAction(
  conversationId: string,
  files: { name: string; size: number; contentType: string; width?: number | null; height?: number | null }[],
): Promise<ChatResult<{ uploads: ChatUpload[] }>> {
  return run("Couldn't upload. Try again.", async (actor) => ({ uploads: await prepareChatUpload(actor, conversationId, files) }));
}

export async function discardChatUploadsAction(ids: string[]): Promise<ChatResult<{ discarded: number }>> {
  return run("Couldn't remove the file. Try again.", (actor) => discardChatUploads(actor, ids));
}

export async function setNotifyAction(id: string, input: ChatNotifyInput): Promise<ChatResult<{ conversation: ChatConversation }>> {
  return run("Couldn't save. Try again.", async (actor) => ({ conversation: await setConversationNotify(actor, id, input ?? {}) }));
}

export async function markUnreadAction(id: string, messageId: string | null): Promise<ChatResult<{ lastReadAt: string; messageId: string }>> {
  return run("Couldn't mark it unread. Try again.", (actor) => markConversationUnread(actor, id, messageId));
}

export async function markAllReadAction(): Promise<ChatResult<{ conversations: number }>> {
  return run("Couldn't mark everything read. Try again.", (actor) => markAllChatRead(actor));
}

export async function deleteMessageAction(id: string): Promise<ChatResult<{ deleted: true }>> {
  return run("Couldn't delete the message. Try again.", (actor) => deleteMessage(actor, id));
}

export async function reactAction(messageId: string, emoji: string, want?: boolean): Promise<ChatResult<ChatReacted>> {
  return run("Couldn't react. Try again.", (actor) => reactToMessage(actor, messageId, emoji, { want: typeof want === "boolean" ? want : null }));
}

export async function saveMessageAction(messageId: string, saved: boolean): Promise<ChatResult<ChatSavedState>> {
  return run("Couldn't save the message. Try again.", (actor) => setMessageSaved(actor, messageId, saved === true));
}

export async function remindAboutMessageAction(messageId: string, when: ChatRemindWhen, key: string | null = null): Promise<ChatResult<{ reminder: Reminder }>> {
  return run("Couldn't set the reminder. Try again.", (actor) => remindAboutMessage(actor, messageId, when, { idempotencyKey: typeof key === "string" && isUuid(key) ? key : null }));
}

export async function listHooksAction(roomId: string): Promise<ChatResult<{ hooks: ChatHook[] }>> {
  return run("Couldn't load webhooks. Try again.", async (actor) => ({ hooks: await listHooks(actor, roomId) }));
}

export async function createHookAction(roomId: string, name: string): Promise<ChatResult<ChatHookSecret>> {
  return run("Couldn't add the webhook. Try again.", (actor) => createHook(actor, roomId, name));
}

export async function setHookPausedAction(hookId: string, paused: boolean): Promise<ChatResult<{ hook: ChatHook }>> {
  return run(paused ? "Couldn't pause the webhook. Try again." : "Couldn't resume the webhook. Try again.", async (actor) => ({ hook: await setHookPaused(actor, hookId, paused === true) }));
}

export async function rotateHookSecretAction(hookId: string): Promise<ChatResult<ChatHookSecret>> {
  return run("Couldn't rotate the secret. Try again.", (actor) => rotateHookSecret(actor, hookId));
}

export async function deleteHookAction(hookId: string): Promise<ChatResult<{ deleted: true }>> {
  return run("Couldn't delete the webhook. Try again.", (actor) => deleteHook(actor, hookId));
}
