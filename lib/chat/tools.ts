import { CHAT_CLIENT_KEY_MAX, type ChatConversation, type ChatMessage } from "@/lib/chat/types";
import { checkChatPost, getConversation, listChatPeople, listConversations, listMessages, listThread, openDm, ownPostWithKey, postMessage } from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";

export type ChatTargetInput = { conversationId?: string | null; person?: string | null; threadId?: string | null };

export type ChatReadInput = { conversationId?: string | null; threadId?: string | null; before?: string | null; after?: string | null; fromUnread?: boolean; limit?: number };

type PostOptions = { charge?: () => Promise<void> };

const NO_TEAMMATE = () => new CrmError("not_found", "Couldn't find that teammate.", 404, { field: "person" });

const NOT_CHAT = () => new CrmError("not_found", "Conversation not found. Task and doc discussions aren't reachable here.", 404, { field: "conversationId" });

function chatOnly<T extends { kind: string }>(conversation: T) {
  if (conversation.kind !== "room" && conversation.kind !== "dm") throw NOT_CHAT();
  return conversation;
}

const KEY_USED = () => new CrmError("conflict", "That message key was already used for another message.", 409, { field: "clientKey" });

function given(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function chatConversation(conversation: ChatConversation) {
  return {
    id: conversation.id,
    kind: conversation.kind,
    name: conversation.kind === "room" ? `#${conversation.name}` : conversation.name,
    workspace: conversation.workspaceName,
    person: conversation.dmUser,
    unread: conversation.unread,
    mentions: conversation.mentions,
    lastMessageAt: conversation.lastMessageAt,
  };
}

export function chatMessage(message: ChatMessage) {
  return {
    id: message.id,
    threadId: message.parentId,
    author: { id: message.author.id, name: message.author.name },
    ...(message.via ? { via: { workflowId: message.via.workflowId, name: message.via.name } } : {}),
    ...(message.hook ? { fromWebhook: true, webhook: { title: message.hook.title, url: message.hook.url, formatted: message.hook.block } } : {}),
    text: message.deletedAt ? null : message.body,
    deleted: Boolean(message.deletedAt),
    mentions: message.mentions,
    replies: message.replyCount,
    lastReplyAt: message.lastReplyAt,
    edited: Boolean(message.editedAt),
    at: message.createdAt,
  };
}

export async function chatPersonId(actor: UserActor, person: string) {
  const wanted = person.trim().toLowerCase();
  const found = (await listChatPeople(actor)).find((item) => item.id === wanted || item.email?.toLowerCase() === wanted);
  if (!found) throw NO_TEAMMATE();
  return found.id;
}

export async function listChat(actor: UserActor, options: { people?: boolean } = {}) {
  const sidebar = await listConversations(actor);
  const people = options.people ? (await listChatPeople(actor)).map((item) => ({ id: item.id, name: item.name, email: item.email })) : null;
  return {
    conversations: sidebar.conversations.map(chatConversation),
    threads: sidebar.threads,
    ...(people ? { people } : {}),
  };
}

export async function readChat(actor: UserActor, input: ChatReadInput) {
  if (given(input.conversationId) === given(input.threadId)) {
    throw new CrmError("invalid_input", "Pass a conversation id or a thread id, not both.", 400, { field: "conversationId" });
  }
  if (given(input.before) && given(input.after)) throw new CrmError("invalid_input", "Pass before or after, not both.", 400, { field: "before" });
  if (given(input.threadId)) {
    if (input.fromUnread) throw new CrmError("invalid_input", "from_unread works only with a conversation id.", 400, { field: "fromUnread" });
    const thread = await listThread(actor, input.threadId, { before: input.before, after: input.after, limit: input.limit });
    chatOnly(thread.conversation);
    return {
      conversation: chatConversation(thread.conversation),
      root: chatMessage(thread.root),
      replies: thread.replies.map(chatMessage),
      hasOlder: thread.hasOlder,
      hasNewer: thread.hasNewer,
      following: thread.following,
    };
  }
  const conversation = chatOnly(await getConversation(actor, input.conversationId!));
  const around = !input.before && !input.after && input.fromUnread ? "unread" : null;
  const page = await listMessages(actor, conversation.id, { before: input.before, after: input.after, around, limit: input.limit });
  return {
    conversation: chatConversation(conversation),
    messages: page.messages.map(chatMessage),
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
    firstUnreadId: page.firstUnreadId,
  };
}

export function chatTargetCount(input: ChatTargetInput) {
  return [input.conversationId, input.person, input.threadId].filter(given).length;
}

function cleanKey(key: unknown) {
  if (key === undefined || key === null) return null;
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) throw new CrmError("invalid_input", "Give idempotency_key some text, or leave it out.", 400, { field: "idempotency_key" });
  if (trimmed.length > CHAT_CLIENT_KEY_MAX) throw new CrmError("invalid_input", "Keep idempotency_key to 100 characters.", 400, { field: "idempotency_key" });
  return trimmed;
}

async function dmTarget(actor: UserActor, person: string, key: string | null, options: PostOptions) {
  const personId = await chatPersonId(actor, person);
  const earlier = key ? await ownPostWithKey(actor, key) : null;
  if (earlier) {
    const conversation = await getConversation(actor, earlier.conversationId).catch(() => null);
    if (earlier.parentId || !conversation || conversation.dmUser?.id !== personId) throw KEY_USED();
    return { conversationId: conversation.id, charge: options.charge };
  }
  await options.charge?.();
  const dm = await openDm(actor, personId);
  return { conversationId: dm.id, charge: undefined };
}

async function chatTarget(actor: UserActor, input: ChatTargetInput, key: string | null, options: PostOptions) {
  if (chatTargetCount(input) !== 1) throw new CrmError("invalid_input", "Pass one of a conversation id, a person or a thread id.", 400, { field: "conversationId" });
  if (given(input.threadId)) {
    const thread = await listThread(actor, input.threadId, { limit: 1 });
    chatOnly(thread.conversation);
    return { conversationId: thread.root.conversationId, parentId: thread.root.id, charge: options.charge };
  }
  if (given(input.person)) return { ...(await dmTarget(actor, input.person, key, options)), parentId: null };
  const conversation = chatOnly(await getConversation(actor, input.conversationId!));
  return { conversationId: conversation.id, parentId: null, charge: options.charge };
}

export async function postChat(actor: UserActor, input: ChatTargetInput & { text: unknown; key?: unknown }, options: PostOptions = {}) {
  const body = checkChatPost(input.text);
  const key = cleanKey(input.key);
  const target = await chatTarget(actor, input, key, options);
  const posted = await postMessage(actor, { conversationId: target.conversationId, parentId: target.parentId, body, clientKey: key ?? undefined }, { charge: target.charge });
  return { posted: !posted.duplicate, duplicate: posted.duplicate, conversationId: posted.message.conversationId, message: chatMessage(posted.message) };
}
