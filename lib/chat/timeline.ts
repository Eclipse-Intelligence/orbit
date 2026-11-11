import type { ChatConversation, ChatMessage, ChatPage, ChatPerson, ChatRoom, ChatRoot, ChatSidebar, ChatThread, ChatThreadCard } from "@/lib/chat/types";

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
  stale: boolean;
  after: string | null;
  gone: string[];
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
  | { type: "incoming"; message: ChatMessage; root: ChatRoot | null; unsynced?: boolean }
  | { type: "edited"; message: ChatMessage }
  | { type: "deleted"; conversationId: string; messageId: string; parentId: string | null; root: ChatRoot | null }
  | { type: "pending"; message: ChatMessage }
  | { type: "failed"; clientKey: string; error: string }
  | { type: "retrying"; clientKey: string }
  | { type: "discard"; message: ChatMessage }
  | { type: "read"; conversationId: string; lastReadAt: string }
  | { type: "thread-read"; rootId: string; lastReadAt: string }
  | { type: "forget"; conversationId: string };

export const EMPTY_CHAT: ChatState = { rooms: {}, roomErrors: {}, timelines: {}, threads: {}, failed: {} };

export function emptyTimeline(status: Timeline["status"] = "loading"): Timeline {
  return { messages: [], hasOlder: false, hasNewer: false, firstUnreadId: null, lastReadAt: null, status, error: null, stale: false, after: null, gone: [] };
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

function newerRoot(current: { lastReplyAt: string | null }, update: ChatRoot, force: boolean) {
  return force || !current.lastReplyAt || !update.lastReplyAt || update.lastReplyAt >= current.lastReplyAt;
}

export function applyRoot(list: ChatMessage[], root: ChatRoot, force = false) {
  let changed = false;
  const next = list.map((message) => {
    if (message.id !== root.id || !newerRoot(message, root, force)) return message;
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

const GONE_KEPT = 50;

function withoutGone(messages: ChatMessage[], gone: string[]) {
  return gone.reduce((list, id) => removeRoot(list, id), messages);
}

function withPage(current: Timeline | undefined, page: { messages: ChatMessage[]; hasOlder: boolean; hasNewer: boolean }, mode: PageMode): Timeline {
  const base = current ?? emptyTimeline();
  const landed = new Set(page.messages.map((message) => message.clientKey).filter((key): key is string => Boolean(key)));
  const unsent = (message: ChatMessage) => isLocal(message) && !(message.clientKey && landed.has(message.clientKey));
  if (mode === "replace") {
    return {
      ...base,
      messages: withoutGone(mergeMessages(page.messages, base.messages.filter(unsent)), base.gone),
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      status: "ready",
      error: null,
      after: null,
    };
  }
  const kept = base.messages.filter((message) => !isLocal(message) || unsent(message));
  const known = new Set(base.messages.map((message) => message.id));
  const caughtUp = mode === "newer" && !page.hasNewer && page.messages.every((message) => known.has(message.id));
  return {
    ...base,
    messages: withoutGone(mergeMessages(kept, page.messages), base.gone),
    hasOlder: mode === "older" ? page.hasOlder : base.hasOlder,
    hasNewer: mode === "newer" ? page.hasNewer : base.hasNewer,
    stale: caughtUp ? false : base.stale,
    after: mode === "newer" ? null : base.after,
    status: "ready",
    error: null,
  };
}

export function needsCatchUp(timeline: Timeline | undefined) {
  return Boolean(timeline && timeline.status === "ready" && timeline.stale && !timeline.hasNewer);
}

export function newerCursor(timeline: Timeline | undefined) {
  if (!timeline) return null;
  return timeline.after ?? newestServerId(timeline.messages);
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

function rootFields(root: ChatMessage | null, update: ChatRoot | null, force = false) {
  if (!root || !update || root.id !== update.id || !newerRoot(root, update, force)) return root;
  return { ...root, replyCount: update.replyCount, lastReplyAt: update.lastReplyAt, replyAuthors: update.replyAuthors };
}

function hasLocalKey(timeline: Timeline, key: string | null) {
  return Boolean(key) && timeline.messages.some((item) => isLocal(item) && item.clientKey === key);
}

function markStale(timeline: Timeline) {
  return timeline.stale ? timeline : { ...timeline, stale: true };
}

export function acceptIncoming(timeline: Timeline, message: ChatMessage, unsynced = false): Timeline {
  if (timeline.gone.includes(message.id)) return timeline;
  if (timeline.messages.some((item) => item.id === message.id)) return { ...timeline, messages: replaceMessage(timeline.messages, message) };
  if (hasLocalKey(timeline, message.clientKey)) {
    if (timeline.hasNewer) return markStale(timeline);
    const messages = upsertMessage(timeline.messages, message);
    if (!unsynced) return { ...timeline, messages };
    return { ...timeline, messages, stale: true, after: timeline.after ?? newestServerId(timeline.messages) };
  }
  if (timeline.status === "ready" && !timeline.hasNewer) return { ...timeline, messages: upsertMessage(timeline.messages, message) };
  return markStale(timeline);
}

function forgetMessage(timeline: Timeline, id: string) {
  return { ...timeline, gone: [...timeline.gone.filter((item) => item !== id), id].slice(-GONE_KEPT) };
}

export function hasLocal(state: ChatState, clientKey: string) {
  return (
    Object.values(state.timelines).some((timeline) => hasLocalKey(timeline, clientKey)) ||
    Object.values(state.threads).some((thread) => hasLocalKey(thread.timeline, clientKey))
  );
}

function incoming(state: ChatState, message: ChatMessage, root: ChatRoot | null, unsynced: boolean) {
  let next = withoutFailure(state, message.clientKey);
  if (message.parentId) {
    next = updateThread(next, message.parentId, (thread) => ({ ...thread, root: rootFields(thread.root, root), timeline: acceptIncoming(thread.timeline, message, unsynced) }));
    if (root) next = updateTimeline(next, message.conversationId, (timeline) => ({ ...timeline, messages: applyRoot(timeline.messages, root) }));
    return next;
  }
  return updateTimeline(next, message.conversationId, (timeline) => acceptIncoming(timeline, message, unsynced));
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
      return {
        ...state,
        timelines: { ...state.timelines, [action.conversationId]: current ? { ...current, status: current.status === "error" ? "loading" : current.status, error: null, stale: false } : emptyTimeline() },
      };
    }
    case "page": {
      const current = state.timelines[action.conversationId];
      const timeline = withPage(current, action.page, action.mode);
      const firstUnreadId = action.mode === "replace" || !current ? action.page.firstUnreadId : action.mode === "newer" ? null : timeline.firstUnreadId;
      return { ...state, timelines: { ...state.timelines, [action.conversationId]: { ...timeline, firstUnreadId, lastReadAt: action.page.lastReadAt } } };
    }
    case "page-error": {
      const current = state.timelines[action.conversationId] ?? emptyTimeline();
      const status = current.messages.some((message) => !isLocal(message)) ? "ready" : "error";
      return { ...state, timelines: { ...state.timelines, [action.conversationId]: { ...current, status, error: action.error } } };
    }
    case "thread-loading": {
      const current = state.threads[action.rootId];
      const thread: ThreadState = current
        ? { ...current, timeline: { ...current.timeline, status: current.timeline.status === "error" || !current.root ? "loading" : current.timeline.status, error: null, stale: false } }
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
      return incoming(state, action.message, action.root, action.unsynced === true);
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
        next = updateThread(next, message.id, (thread) =>
          thread.root ? { ...thread, root: { ...message, replyCount: thread.root.replyCount, replyAuthors: thread.root.replyAuthors, lastReplyAt: thread.root.lastReplyAt } } : thread,
        );
      }
      return next;
    }
    case "deleted": {
      const { conversationId, messageId, parentId, root } = action;
      if (parentId) {
        let next = updateThread(state, parentId, (thread) => ({
          ...thread,
          root: rootFields(thread.root, root, true),
          timeline: forgetMessage({ ...thread.timeline, messages: thread.timeline.messages.filter((message) => message.id !== messageId) }, messageId),
        }));
        if (root) next = updateTimeline(next, conversationId, (timeline) => ({ ...timeline, messages: applyRoot(timeline.messages, root, true) }));
        return next;
      }
      const next = updateTimeline(state, conversationId, (timeline) => forgetMessage({ ...timeline, messages: removeRoot(timeline.messages, messageId) }, messageId));
      return updateThread(next, messageId, (thread) => (thread.root ? { ...thread, root: { ...thread.root, body: "", mentions: [], deletedAt: thread.root.deletedAt ?? new Date().toISOString() } } : thread));
    }
    case "pending": {
      const { message } = action;
      const next = withoutFailure(state, message.clientKey);
      if (message.parentId) {
        const thread = next.threads[message.parentId] ?? { conversation: null, root: null, following: true, timeline: emptyTimeline("ready") };
        return { ...next, threads: { ...next.threads, [message.parentId]: { ...thread, timeline: { ...thread.timeline, messages: upsertMessage(thread.timeline.messages, message) } } } };
      }
      const timeline = next.timelines[message.conversationId] ?? emptyTimeline("ready");
      return { ...next, timelines: { ...next.timelines, [message.conversationId]: { ...timeline, messages: upsertMessage(timeline.messages, message) } } };
    }
    case "failed":
      if (!hasLocal(state, action.clientKey)) return state;
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
      return updateTimeline(state, action.conversationId, (timeline) => {
        const lastReadAt = timeline.lastReadAt && timeline.lastReadAt > action.lastReadAt ? timeline.lastReadAt : action.lastReadAt;
        return lastReadAt === timeline.lastReadAt && !timeline.firstUnreadId ? timeline : { ...timeline, lastReadAt, firstUnreadId: null };
      });
    case "thread-read":
      return updateThread(state, action.rootId, (thread) =>
        thread.timeline.lastReadAt && thread.timeline.lastReadAt >= action.lastReadAt ? thread : { ...thread, following: true, timeline: { ...thread.timeline, lastReadAt: action.lastReadAt } },
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

export function appendCards(current: ChatThreadCard[], incoming: ChatThreadCard[]) {
  const seen = new Set(current.map((card) => card.root.id));
  return [...current, ...incoming.filter((card) => !seen.has(card.root.id))];
}

export function refreshCards(current: ChatThreadCard[], fresh: ChatThreadCard[]) {
  const updated = new Set(fresh.map((card) => card.root.id));
  return [...fresh, ...current.filter((card) => !updated.has(card.root.id))];
}

export function sidebarBadge(sidebar: ChatSidebar | null) {
  if (!sidebar) return { count: 0, mentioned: false };
  const count = sidebar.unreadConversations > 0 ? sidebar.unreadConversations : sidebar.threads.unread;
  return { count, mentioned: count > 0 && sidebar.mentioned };
}
