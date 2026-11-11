import type { ChatConversation, ChatMessage } from "@/lib/chat/types";
import { getConversation, listChatPeople, listConversations, listMessages, listThread, openDm, postMessage } from "@/lib/crm/chat";
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

type HookFields = { viaHookId?: string | null; hook?: { title?: unknown; url?: unknown; block?: unknown } | null };

function hookOf(message: ChatMessage) {
  const extra = message as ChatMessage & HookFields;
  if (!extra.viaHookId && !extra.hook) return null;
  const hook = extra.hook ?? {};
  return {
    title: typeof hook.title === "string" ? hook.title : null,
    url: typeof hook.url === "string" ? hook.url : null,
    details: hook.block === undefined || hook.block === null ? null : typeof hook.block === "string" ? hook.block : JSON.stringify(hook.block),
  };
}

export function chatMessage(message: ChatMessage) {
  const hook = hookOf(message);
  return {
    ...(hook ? { fromWebhook: true, webhook: hook } : {}),
    id: message.id,
    threadId: message.parentId,
    author: message.author.name,
    authorId: message.author.id,
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

async function chatTarget(actor: UserActor, input: ChatTargetInput) {
  if (chatTargetCount(input) !== 1) throw new CrmError("invalid_input", "Pass one of a conversation id, a person or a thread id.", 400, { field: "conversationId" });
  if (given(input.threadId)) {
    const thread = await listThread(actor, input.threadId, { limit: 1 });
    return { conversationId: thread.root.conversationId, parentId: thread.root.id };
  }
  if (given(input.person)) {
    const dm = await openDm(actor, await chatPersonId(actor, input.person));
    return { conversationId: dm.id, parentId: null };
  }
  return { conversationId: input.conversationId!, parentId: null };
}

export async function postChat(actor: UserActor, input: ChatTargetInput & { text: unknown; key?: string | null }, options: { charge?: () => Promise<void> } = {}) {
  const target = await chatTarget(actor, input);
  const posted = await postMessage(actor, { conversationId: target.conversationId, parentId: target.parentId, body: input.text, clientKey: input.key ?? undefined }, options);
  return { posted: !posted.duplicate, duplicate: posted.duplicate, conversationId: posted.message.conversationId, message: chatMessage(posted.message) };
}
