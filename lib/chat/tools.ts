import type { ChatConversation, ChatMessage } from "@/lib/chat/types";
import { getConversation, listChatPeople, listConversations, listMessages, listThread, openDm, ownPostWithKey, postMessage } from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";

export type ChatTargetInput = { conversationId?: string | null; person?: string | null; threadId?: string | null };

export type ChatReadInput = { conversationId?: string | null; threadId?: string | null; before?: string | null; after?: string | null; fromUnread?: boolean; limit?: number };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    ...(message.hook ? { fromWebhook: true, webhook: { title: message.hook.title, url: message.hook.url, formatted: message.hook.block } } : {}),
    id: message.id,
    threadId: message.parentId,
    author: message.via ? `${message.author.name} via ${message.via.name}` : message.author.name,
    authorId: message.author.id,
    ...(message.via ? { via: { workflowId: message.via.workflowId, name: message.via.name } } : {}),
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
  if (!EMAIL.test(wanted)) return wanted;
  const found = (await listChatPeople(actor)).find((item) => item.email?.toLowerCase() === wanted);
  if (!found) throw new CrmError("not_found", "No teammate with that address shares a workspace with you.", 404, { field: "person" });
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
  if (given(input.threadId)) {
    const thread = await listThread(actor, input.threadId, { before: input.before, after: input.after, limit: input.limit });
    return {
      conversation: chatConversation(thread.conversation),
      root: chatMessage(thread.root),
      replies: thread.replies.map(chatMessage),
      hasOlder: thread.hasOlder,
      hasNewer: thread.hasNewer,
      following: thread.following,
    };
  }
  const conversation = await getConversation(actor, input.conversationId!);
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

const KEY_USED = () => new CrmError("conflict", "That message key was already used for another message.", 409, { field: "clientKey" });

type PostOptions = { charge?: () => Promise<void> };

async function dmTarget(actor: UserActor, person: string, key: string | null, options: PostOptions) {
  const personId = await chatPersonId(actor, person);
  const earlier = key ? await ownPostWithKey(actor, key) : null;
  if (earlier) {
    const conversation = await getConversation(actor, earlier.conversationId).catch(() => null);
    if (earlier.parentId || conversation?.dmUser?.id !== personId) throw KEY_USED();
    return { conversationId: conversation.id, charge: undefined };
  }
  await options.charge?.();
  const dm = await openDm(actor, personId);
  return { conversationId: dm.id, charge: undefined };
}

async function chatTarget(actor: UserActor, input: ChatTargetInput & { key?: string | null }, options: PostOptions) {
  if (chatTargetCount(input) !== 1) throw new CrmError("invalid_input", "Pass one of a conversation id, a person or a thread id.", 400, { field: "conversationId" });
  if (given(input.threadId)) {
    const thread = await listThread(actor, input.threadId, { limit: 1 });
    return { conversationId: thread.root.conversationId, parentId: thread.root.id, charge: options.charge };
  }
  if (given(input.person)) return { ...(await dmTarget(actor, input.person, given(input.key) ? input.key : null, options)), parentId: null };
  return { conversationId: input.conversationId!, parentId: null, charge: options.charge };
}

export async function postChat(actor: UserActor, input: ChatTargetInput & { text: unknown; key?: string | null }, options: PostOptions = {}) {
  const target = await chatTarget(actor, input, options);
  const posted = await postMessage(
    actor,
    { conversationId: target.conversationId, parentId: target.parentId, body: input.text, clientKey: input.key ?? undefined },
    { charge: target.charge },
  );
  return { posted: !posted.duplicate, duplicate: posted.duplicate, conversationId: posted.message.conversationId, message: chatMessage(posted.message) };
}
