export type ChatKind = "room" | "dm";

export type ChatPerson = { id: string; name: string };

export const CHAT_BODY_MAX = 10_000;
export const CHAT_PAGE_SIZE = 50;
export const CHAT_PAGE_MAX = 100;
export const CHAT_COUNT_CAP = 100;
export const CHAT_ROOM_NAME_MAX = 80;
export const CHAT_CLIENT_KEY_MAX = 100;
export const CHAT_HOOK_NAME_MAX = 80;

export type ChatHookCard = { title: string | null; url: string | null; block: boolean };

export type ChatHook = { id: string; name: string; createdBy: string | null; pausedAt: string | null; lastUsedAt: string | null; createdAt: string };

export type ChatHookSecret = { hook: ChatHook; secret: string };

export type ChatConversation = {
  id: string;
  kind: ChatKind;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  dmUser: ChatPerson | null;
  createdAt: string;
  lastMessageAt: string | null;
  lastReadAt: string;
  unread: number;
  mentions: number;
};

export type ChatSidebar = {
  conversations: ChatConversation[];
  threads: { unread: number; mentions: number };
  unreadConversations: number;
  mentioned: boolean;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  parentId: string | null;
  author: { id: string | null; name: string };
  clientKey: string | null;
  body: string;
  mentions: string[];
  replyCount: number;
  lastReplyAt: string | null;
  replyAuthors: ChatPerson[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  hook: ChatHookCard | null;
};

export type ChatRoot = { id: string; replyCount: number; lastReplyAt: string | null; replyAuthors: ChatPerson[] };

export type ChatMember = { id: string; name: string; email: string | null; addedAt: string; addedBy: string | null };

export type ChatRoom = {
  conversation: ChatConversation;
  members: ChatMember[];
  createdBy: string | null;
};

export type ChatPage = {
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  firstUnreadId: string | null;
  lastReadAt: string;
};

export type ChatThread = {
  conversation: ChatConversation;
  root: ChatMessage;
  replies: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  following: boolean;
  lastReadAt: string | null;
};

export type ChatThreadCard = {
  conversation: { id: string; kind: ChatKind; name: string };
  root: ChatMessage;
  latest: ChatMessage[];
  earlier: number;
  unread: number;
  mentions: number;
  lastReadAt: string;
};

export type ChatThreads = { threads: ChatThreadCard[]; next: string | null };

export type ChatSearchResult = { messages: ChatMessage[] };

export type ChatPost = { message: ChatMessage; root: ChatRoot | null; duplicate: boolean };

export type ChatLiveEvent =
  | { type: "message"; conversationId: string; message: ChatMessage; root: ChatRoot | null }
  | { type: "edit"; conversationId: string; message: ChatMessage }
  | { type: "delete"; conversationId: string; messageId: string; parentId: string | null; root: ChatRoot | null }
  | { type: "read"; conversationId: string; lastReadAt: string }
  | { type: "thread-read"; conversationId: string; messageId: string; lastReadAt: string }
  | { type: "conversation"; conversationId: string }
  | { type: "removed"; conversationId: string };

export type ChatTyping = { conversationId: string; user: ChatPerson; typing: boolean };

export type ChatResult<T> = ({ ok: true } & T) | { ok?: false; error: string };
