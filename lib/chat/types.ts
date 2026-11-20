import type { ChatFormat } from "@/lib/chat/markdown";

export type ChatKind = "room" | "dm" | "group_dm" | "task" | "doc" | "mail_thread";

export const CHAT_GROUP_MAX = 8;

export function isDirect(kind: ChatKind) {
  return kind === "dm" || kind === "group_dm";
}

export function isChatKind(kind: ChatKind) {
  return kind === "room" || isDirect(kind);
}

export function groupName(names: string[]) {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function chatLabel(conversation: { kind: ChatKind; name: string }) {
  return conversation.kind === "room" ? `#${conversation.name}` : conversation.name;
}

export type ChatSubjectKind = "task" | "doc" | "mail_thread";

export type ChatSubject = { kind: ChatSubjectKind; id: string };

export type ChatPerson = { id: string; name: string };

export const CHAT_BODY_MAX = 10_000;
export const CHAT_PAGE_SIZE = 50;
export const CHAT_PAGE_MAX = 100;
export const CHAT_COUNT_CAP = 100;
export const CHAT_ROOM_NAME_MAX = 80;
export const CHAT_CLIENT_KEY_MAX = 100;
export const CHAT_HOOK_NAME_MAX = 80;
export const CHAT_REACTION_MAX = 20;
export const CHAT_TOPIC_MAX = 250;
export const CHAT_ARCHIVED = "This room is archived.";
export const CHAT_FILES_MAX = 10;
export const CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024;

export type ChatAttachment = { id: string; name: string; contentType: string; size: number; width: number | null; height: number | null };

export type ChatLinkPreview = { id: string; url: string; title: string | null; description: string | null; site: string | null; image: boolean };

export const LINK_PREVIEWS_MAX = 2;

export type ChatUpload = { id: string; name: string; contentType: string; size: number; uploadUrl: string };

export type ChatHookCard = { title: string | null; url: string | null; block: boolean };

export const EMPTY_HOOK_CARD: ChatHookCard = { title: null, url: null, block: false };

export type ChatHook = { id: string; name: string; createdBy: string | null; pausedAt: string | null; lastUsedAt: string | null; createdAt: string };

export type ChatHookSecret = { hook: ChatHook; secret: string };

export const CHAT_NOTIFY_LEVELS = ["default", "all", "mentions", "mute"] as const;

export type ChatNotify = (typeof CHAT_NOTIFY_LEVELS)[number];

export type ChatLevel = Exclude<ChatNotify, "default">;

export function chatLevel(kind: ChatKind, notify: ChatNotify): ChatLevel {
  if (notify !== "default") return notify;
  return isDirect(kind) ? "all" : "mentions";
}

export type ChatConversation = {
  id: string;
  kind: ChatKind;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  dmUser: ChatPerson | null;
  people: ChatPerson[];
  topic: string | null;
  archivedAt: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  lastReadAt: string;
  unread: number;
  mentions: number;
  notify: ChatNotify;
  muteMentions: boolean;
  starred: boolean;
};

export type ChatNotifyInput = { notify?: ChatNotify; muteMentions?: boolean; starred?: boolean };

export type ChatSidebar = {
  conversations: ChatConversation[];
  archived: { id: string; name: string; workspaceName: string | null }[];
  threads: { unread: number; mentions: number };
  unreadConversations: number;
  mentioned: boolean;
};

export type ChatReaction = { emoji: string; count: number; mine: boolean; people: ChatPerson[] };

export type ChatVia = { workflowId: string | null; name: string };

export type ChatMessageKind = "message" | "event";

export type ChatMessage = {
  id: string;
  conversationId: string;
  parentId: string | null;
  kind: ChatMessageKind;
  author: { id: string | null; name: string };
  via: ChatVia | null;
  clientKey: string | null;
  body: string;
  format: ChatFormat;
  mentions: string[];
  everyone?: boolean;
  replyCount: number;
  lastReplyAt: string | null;
  replyAuthors: ChatPerson[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  hook: ChatHookCard | null;
  attachments: ChatAttachment[];
  previews: ChatLinkPreview[];
  reactions: ChatReaction[];
  reactionsAt?: string;
};

export type ChatRoot = { id: string; replyCount: number; lastReplyAt: string | null; replyAuthors: ChatPerson[] };

export type ChatMember = { id: string; name: string; email: string | null; addedAt: string; addedBy: string | null };

export type ChatRoom = {
  conversation: ChatConversation;
  members: ChatMember[];
  createdBy: string | null;
  canArchive: boolean;
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
  conversation: { id: string; kind: ChatKind; name: string; people: ChatPerson[] };
  root: ChatMessage;
  latest: ChatMessage[];
  earlier: number;
  unread: number;
  mentions: number;
  lastReadAt: string;
};

export type ChatThreads = { threads: ChatThreadCard[]; next: string | null };

export type ChatUnreadGroup = { conversation: ChatConversation; messages: ChatMessage[]; more: number };

export type ChatUnreads = { groups: ChatUnreadGroup[] };

export type ChatSearchResult = { messages: ChatMessage[] };

export type ChatSavedItem = {
  message: ChatMessage;
  conversation: { id: string; kind: ChatKind; name: string; archived: boolean };
  subject: ChatSubject | null;
  savedAt: string;
};

export type ChatSaved = { items: ChatSavedItem[]; next: string | null };

export type ChatSavedIds = { ids: string[] };

export type ChatSavedState = { messageId: string; saved: boolean };

export const CHAT_REMIND_WHEN = ["hour", "tomorrow", "none"] as const;

export type ChatRemindWhen = (typeof CHAT_REMIND_WHEN)[number];
export const CHAT_SEARCH_MIN = 3;
export const CHAT_SEARCH_PAGE = 30;
export const CHAT_SEARCH_MAX = 50;
export const CHAT_SEARCH_TEXT_MAX = 200;

export type ChatSearchQuery = {
  q: string;
  in: string | null;
  from: string | null;
  file: boolean;
  after: string | null;
  before: string | null;
};

export type ChatSearchHit = {
  id: string;
  conversationId: string;
  parentId: string | null;
  createdAt: string;
  author: { id: string | null; name: string };
  excerpt: string;
  text?: string;
  files: { id: string; name: string }[];
  conversation: { kind: ChatKind; name: string; workspaceName: string | null; archived: boolean };
  subject: { kind: ChatSubjectKind; id: string; title: string | null } | null;
  href: string;
};

export type ChatSearch = { hits: ChatSearchHit[]; next: string | null };

export type ChatPost = { message: ChatMessage; root: ChatRoot | null; duplicate: boolean };

export type ChatReacted = { conversationId: string; messageId: string; parentId: string | null; emoji: string; present: boolean; changed: boolean; reactions: ChatReaction[]; at: string };

export type ChatLiveEvent =
  | { type: "message"; conversationId: string; message: ChatMessage; root: ChatRoot | null; subject?: ChatSubject }
  | { type: "edit"; conversationId: string; message: ChatMessage }
  | { type: "delete"; conversationId: string; messageId: string; parentId: string | null; root: ChatRoot | null }
  | { type: "read"; conversationId: string; lastReadAt: string }
  | { type: "unread"; conversationId: string; messageId: string; lastReadAt: string }
  | { type: "thread-read"; conversationId: string; messageId: string; lastReadAt: string }
  | { type: "conversation"; conversationId: string }
  | { type: "removed"; conversationId: string }
  | { type: "reaction"; conversationId: string; messageId: string; parentId: string | null; reactions: ChatReaction[]; at: string }
  | { type: "previews"; conversationId: string; messageId: string; parentId: string | null; previews: ChatLinkPreview[] };

export type ChatTyping = { conversationId: string; user: ChatPerson; typing: boolean };

export type ChatDiscussion = {
  subject: ChatSubject;
  conversationId: string | null;
  count: number;
  page: ChatPage | null;
};

export type ChatNeedsShare = { people: ChatPerson[]; canAdd: boolean };

export type ChatResult<T> = ({ ok: true } & T) | { ok?: false; error: string; needsShare?: ChatNeedsShare };
