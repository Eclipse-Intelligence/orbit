import type { ChatConversation, ChatMessage, ChatPage, ChatPerson, ChatRoom, ChatRoot, ChatSidebar, ChatThread } from "@/lib/chat/types";

export const LOCAL_PREFIX = "local:";
const GROUP_GAP_MS = 5 * 60_000;

export type Timeline = {
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  firstUnreadId: string | null;
  lastReadAt: string | null;
  status: "loading" | "ready" | "error";
  error: string | null;
};

export type ThreadState = {
  conversation: ChatConversation | null;
  root: ChatMessage | null;
  following: boolean;
  timeline: Timeline;
};

export type ChatState = {
  rooms: Record<string, ChatRoom>;
  roomErrors: Record<string, string>;
  timelines: Record<string, Timeline>;
  threads: Record<string, ThreadState>;
  failed: Record<string, string>;
};

export type PageMode = "replace" | "older" | "newer";

export type ChatAction =
  | { type: "room"; room: ChatRoom }
  | { type: "room-error"; conversationId: string; error: string }
  | { type: "loading"; conversationId: string }
  | { type: "page"; conversationId: string; page: ChatPage; mode: PageMode }
  | { type: "page-error"; conversationId: string; error: string }
  | { type: "thread-loading"; rootId: string }
  | { type: "thread"; thread: ChatThread; mode: PageMode }
  | { type: "thread-error"; rootId: string; error: string }
  | { type: "incoming"; message: ChatMessage; root: ChatRoot | null }
  | { type: "edited"; message: ChatMessage }
  | { type: "deleted"; conversationId: string; messageId: string; parentId: string | null; root: ChatRoot | null }
  | { type: "pending"; message: ChatMessage }
  | { type: "failed"; clientKey: string; error: string }
  | { type: "retrying"; clientKey: string }
  | { type: "discard"; message: ChatMessage }
  | { type: "read"; conversationId: string; lastReadAt: string }
  | { type: "forget"; conversationId: string };

export const EMPTY_CHAT: ChatState = { rooms: {}, roomErrors: {}, timelines: {}, threads: {}, failed: {} };

export function emptyTimeline(status: Timeline["status"] = "loading"): Timeline {
  return { messages: [], hasOlder: false, hasNewer: false, firstUnreadId: null, lastReadAt: null, status, error: null };
}

export function localId(clientKey: string) {
  return `${LOCAL_PREFIX}${clientKey}`;
}

export function isLocal(message: { id: string }) {
  return message.id.startsWith(LOCAL_PREFIX);
}

export function localMessage(input: { clientKey: string; conversationId: string; parentId: string | null; author: ChatPerson; body: string; mentions: string[]; at: string }): ChatMessage {
  return {
    id: localId(input.clientKey),
    conversationId: input.conversationId,
    parentId: input.parentId,
    author: { id: input.author.id, name: input.author.name },
    clientKey: input.clientKey,
    body: input.body,
    mentions: input.mentions,
    replyCount: 0,
    lastReplyAt: null,
    replyAuthors: [],
    editedAt: null,
    deletedAt: null,
    createdAt: input.at,
  };
}

function compare(left: ChatMessage, right: ChatMessage) {
  const leftLocal = isLocal(left);
  const rightLocal = isLocal(right);
  if (leftLocal !== rightLocal) return leftLocal ? 1 : -1;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (leftLocal) return 0;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function upsertMessage(list: ChatMessage[], message: ChatMessage) {
  const key = message.clientKey;
  const rest = list.filter((item) => item.id !== message.id && !(key && isLocal(item) && item.clientKey === key));
  if (isLocal(message)) return [...rest, message];
  const index = rest.findIndex((item) => compare(message, item) < 0);
  if (index < 0) return [...rest, message];
  return [...rest.slice(0, index), message, ...rest.slice(index)];
}

export function mergeMessages(list: ChatMessage[], incoming: ChatMessage[]) {
  return incoming.reduce(upsertMessage, list);
}

export function applyRoot(list: ChatMessage[], root: ChatRoot) {
  let changed = false;
  const next = list.map((message) => {
    if (message.id !== root.id) return message;
    changed = true;
    return { ...message, replyCount: root.replyCount, lastReplyAt: root.lastReplyAt, replyAuthors: root.replyAuthors };
  });
  return changed ? next : list;
}

export function replaceMessage(list: ChatMessage[], message: ChatMessage) {
  let changed = false;
  const next = list.map((item) => {
    if (item.id !== message.id) return item;
    changed = true;
    return message;
  });
  return changed ? next : list;
}

export function removeRoot(list: ChatMessage[], id: string) {
  const target = list.find((message) => message.id === id);
  if (!target) return list;
  if (target.replyCount > 0) {
    return list.map((message) => (message.id === id ? { ...message, body: "", mentions: [], deletedAt: message.deletedAt ?? new Date().toISOString() } : message));
  }
  return list.filter((message) => message.id !== id);
}

function withPage(current: Timeline | undefined, page: { messages: ChatMessage[]; hasOlder: boolean; hasNewer: boolean }, mode: PageMode): Timeline {
  const base = current ?? emptyTimeline();
  const locals = base.messages.filter(isLocal);
  if (mode === "replace") {
    return { ...base, messages: mergeMessages(page.messages, locals), hasOlder: page.hasOlder, hasNewer: page.hasNewer, status: "ready", error: null };
  }
  return {
    ...base,
    messages: mergeMessages(base.messages, page.messages),
    hasOlder: mode === "older" ? page.hasOlder : base.hasOlder,
    hasNewer: mode === "newer" ? page.hasNewer : base.hasNewer,
    status: "ready",
    error: null,
  };
}

function updateTimeline(state: ChatState, conversationId: string, update: (timeline: Timeline) => Timeline) {
  const timeline = state.timelines[conversationId];
  if (!timeline) return state;
  const next = update(timeline);
  return next === timeline ? state : { ...state, timelines: { ...state.timelines, [conversationId]: next } };
}

function updateThread(state: ChatState, rootId: string, update: (thread: ThreadState) => ThreadState) {
  const thread = state.threads[rootId];
  if (!thread) return state;
  const next = update(thread);
  return next === thread ? state : { ...state, threads: { ...state.threads, [rootId]: next } };
}

function withoutFailure(state: ChatState, clientKey: string | null) {
  if (!clientKey || !(clientKey in state.failed)) return state;
  const failed = { ...state.failed };
  delete failed[clientKey];
  return { ...state, failed };
}

function rootFields(root: ChatMessage | null, update: ChatRoot | null) {
  if (!root || !update || root.id !== update.id) return root;
  return { ...root, replyCount: update.replyCount, lastReplyAt: update.lastReplyAt, replyAuthors: update.replyAuthors };
}

function hasMessage(timeline: Timeline, message: ChatMessage) {
  return timeline.messages.some((item) => item.id === message.id || (message.clientKey !== null && item.clientKey === message.clientKey));
}

function incoming(state: ChatState, message: ChatMessage, root: ChatRoot | null) {
  let next = withoutFailure(state, message.clientKey);
  if (message.parentId) {
    next = updateThread(next, message.parentId, (thread) => {
      const timeline = thread.timeline;
      const accept = timeline.status === "ready" && (!timeline.hasNewer || hasMessage(timeline, message));
      return {
        ...thread,
        root: rootFields(thread.root, root),
        timeline: accept ? { ...timeline, messages: upsertMessage(timeline.messages, message) } : timeline,
      };
    });
    if (root) next = updateTimeline(next, message.conversationId, (timeline) => ({ ...timeline, messages: applyRoot(timeline.messages, root) }));
    return next;
  }
  return updateTimeline(next, message.conversationId, (timeline) => {
    if (timeline.status !== "ready") return timeline;
    if (timeline.hasNewer && !hasMessage(timeline, message)) return timeline;
    return { ...timeline, messages: upsertMessage(timeline.messages, message) };
  });
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "room": {
      const roomErrors = { ...state.roomErrors };
      delete roomErrors[action.room.conversation.id];
      return { ...state, rooms: { ...state.rooms, [action.room.conversation.id]: action.room }, roomErrors };
    }
    case "room-error":
      return { ...state, roomErrors: { ...state.roomErrors, [action.conversationId]: action.error } };
    case "loading": {
      const current = state.timelines[action.conversationId];
      return { ...state, timelines: { ...state.timelines, [action.conversationId]: current ? { ...current, status: current.status === "error" ? "loading" : current.status, error: null } : emptyTimeline() } };
    }
    case "page": {
      const current = state.timelines[action.conversationId];
      const timeline = withPage(current, action.page, action.mode);
      const fresh = action.mode === "replace" || !current;
      return {
        ...state,
        timelines: {
          ...state.timelines,
          [action.conversationId]: {
            ...timeline,
            firstUnreadId: fresh ? action.page.firstUnreadId : timeline.firstUnreadId,
            lastReadAt: action.page.lastReadAt,
          },
        },
      };
    }
    case "page-error": {
      const current = state.timelines[action.conversationId] ?? emptyTimeline();
      const status = current.messages.length > 0 ? "ready" : "error";
      return { ...state, timelines: { ...state.timelines, [action.conversationId]: { ...current, status, error: action.error } } };
    }
    case "thread-loading": {
      const current = state.threads[action.rootId];
      const thread: ThreadState = current
        ? { ...current, timeline: { ...current.timeline, status: current.timeline.status === "error" ? "loading" : current.timeline.status, error: null } }
        : { conversation: null, root: null, following: false, timeline: emptyTimeline() };
      return { ...state, threads: { ...state.threads, [action.rootId]: thread } };
    }
    case "thread": {
      const { thread, mode } = action;
      const current = state.threads[thread.root.id];
      const timeline = withPage(current?.timeline, { messages: thread.replies, hasOlder: thread.hasOlder, hasNewer: thread.hasNewer }, mode);
      return {
        ...state,
        threads: {
          ...state.threads,
          [thread.root.id]: { conversation: thread.conversation, root: thread.root, following: thread.following, timeline: { ...timeline, lastReadAt: thread.lastReadAt } },
        },
      };
    }
    case "thread-error": {
      const current = state.threads[action.rootId] ?? { conversation: null, root: null, following: false, timeline: emptyTimeline() };
      const status = current.root ? "ready" : "error";
      return { ...state, threads: { ...state.threads, [action.rootId]: { ...current, timeline: { ...current.timeline, status, error: action.error } } } };
    }
    case "incoming":
      return incoming(state, action.message, action.root);
    case "edited": {
      const { message } = action;
      let next = updateTimeline(state, message.conversationId, (timeline) => {
        const messages = replaceMessage(timeline.messages, message);
        return messages === timeline.messages ? timeline : { ...timeline, messages };
      });
      if (message.parentId) {
        next = updateThread(next, message.parentId, (thread) => {
          const messages = replaceMessage(thread.timeline.messages, message);
          return messages === thread.timeline.messages ? thread : { ...thread, timeline: { ...thread.timeline, messages } };
        });
      } else {
        next = updateThread(next, message.id, (thread) => (thread.root ? { ...thread, root: { ...message, replyCount: thread.root.replyCount, replyAuthors: thread.root.replyAuthors, lastReplyAt: thread.root.lastReplyAt } } : thread));
      }
      return next;
    }
    case "deleted": {
      const { conversationId, messageId, parentId, root } = action;
      if (parentId) {
        let next = updateThread(state, parentId, (thread) => ({
          ...thread,
          root: rootFields(thread.root, root),
          timeline: { ...thread.timeline, messages: thread.timeline.messages.filter((message) => message.id !== messageId) },
        }));
        if (root) next = updateTimeline(next, conversationId, (timeline) => ({ ...timeline, messages: applyRoot(timeline.messages, root) }));
        return next;
      }
      const next = updateTimeline(state, conversationId, (timeline) => {
        const messages = removeRoot(timeline.messages, messageId);
        return messages === timeline.messages ? timeline : { ...timeline, messages };
      });
      return updateThread(next, messageId, (thread) => (thread.root ? { ...thread, root: { ...thread.root, body: "", mentions: [], deletedAt: thread.root.deletedAt ?? new Date().toISOString() } } : thread));
    }
    case "pending": {
      const { message } = action;
      const next = withoutFailure(state, message.clientKey);
      if (message.parentId) {
        return updateThread(next, message.parentId, (thread) => ({ ...thread, timeline: { ...thread.timeline, messages: upsertMessage(thread.timeline.messages, message) } }));
      }
      const timeline = next.timelines[message.conversationId] ?? emptyTimeline("ready");
      return { ...next, timelines: { ...next.timelines, [message.conversationId]: { ...timeline, messages: upsertMessage(timeline.messages, message) } } };
    }
    case "failed":
      return { ...state, failed: { ...state.failed, [action.clientKey]: action.error } };
    case "retrying":
      return withoutFailure(state, action.clientKey);
    case "discard": {
      const { message } = action;
      const next = withoutFailure(state, message.clientKey);
      const drop = (messages: ChatMessage[]) => messages.filter((item) => item.id !== message.id);
      if (message.parentId) return updateThread(next, message.parentId, (thread) => ({ ...thread, timeline: { ...thread.timeline, messages: drop(thread.timeline.messages) } }));
      return updateTimeline(next, message.conversationId, (timeline) => ({ ...timeline, messages: drop(timeline.messages) }));
    }
    case "read":
      return updateTimeline(state, action.conversationId, (timeline) =>
        timeline.lastReadAt && timeline.lastReadAt >= action.lastReadAt ? timeline : { ...timeline, lastReadAt: action.lastReadAt },
      );
    case "forget": {
      const rooms = { ...state.rooms };
      const timelines = { ...state.timelines };
      delete rooms[action.conversationId];
      delete timelines[action.conversationId];
      const threads = Object.fromEntries(Object.entries(state.threads).filter(([, thread]) => thread.root?.conversationId !== action.conversationId));
      return { ...state, rooms, timelines, threads };
    }
  }
}

export function newestServerId(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isLocal(messages[index])) return messages[index].id;
  }
  return null;
}

export function oldestServerId(messages: ChatMessage[]) {
  return messages.find((message) => !isLocal(message))?.id ?? null;
}

export function startsGroup(previous: ChatMessage | null, message: ChatMessage, sameDay: boolean) {
  if (!previous || !sameDay) return true;
  if (previous.author.id !== message.author.id || !message.author.id) return true;
  if (previous.deletedAt || previous.replyCount > 0) return true;
  return Date.parse(message.createdAt) - Date.parse(previous.createdAt) > GROUP_GAP_MS;
}

export function lastOwnMessage(messages: ChatMessage[], viewerId: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.author.id === viewerId && !message.deletedAt && !isLocal(message)) return message;
  }
  return null;
}

export function typingLine(names: string[]) {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

export function sidebarRead(sidebar: ChatSidebar, conversationId: string): ChatSidebar {
  const target = sidebar.conversations.find((conversation) => conversation.id === conversationId);
  if (!target || (target.unread === 0 && target.mentions === 0)) return sidebar;
  const conversations = sidebar.conversations.map((conversation) => (conversation.id === conversationId ? { ...conversation, unread: 0, mentions: 0 } : conversation));
  return {
    ...sidebar,
    conversations,
    unreadConversations: conversations.filter((conversation) => conversation.unread > 0).length,
    mentioned: sidebar.threads.mentions > 0 || conversations.some((conversation) => conversation.mentions > 0 || (conversation.kind === "dm" && conversation.unread > 0)),
  };
}

export function sidebarBadge(sidebar: ChatSidebar | null) {
  if (!sidebar) return { count: 0, mentioned: false };
  const count = sidebar.unreadConversations > 0 ? sidebar.unreadConversations : sidebar.threads.unread;
  return { count, mentioned: count > 0 && sidebar.mentioned };
}
