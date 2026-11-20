import type { ChatAttachment, ChatPage, ChatPerson, ChatRoom, ChatSaved, ChatSavedIds, ChatSearch, ChatSearchQuery, ChatSearchResult, ChatSidebar, ChatThread, ChatThreads, ChatUnreads } from "@/lib/chat/types";
import type { Mention } from "@/lib/mentions";

const TIMEOUT_MS = 15_000;
const DRAFT_PREFIX = "chat-draft:";

export type ChatDraft = { text: string; mentions: Mention[] };

async function request<T>(url: string, fallback: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  } catch {
    throw new Error(fallback);
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || fallback);
  return body;
}

function query(params: Record<string, string | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

function markUpTo<T>(url: string, fallback: string, upTo: string | null) {
  return request<T>(url, fallback, upTo ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ upTo }) } : { method: "POST" });
}

export const chatApi = {
  sidebar: () => request<ChatSidebar>("/api/chat", "Couldn't load Chat. Try again."),
  room: (id: string) => request<ChatRoom>(`/api/chat/${id}`, "Couldn't load the conversation. Try again."),
  messages: (id: string, options: { before?: string | null; after?: string | null; around?: string | null } = {}) =>
    request<ChatPage>(`/api/chat/${id}/messages${query(options)}`, "Couldn't load messages. Try again."),
  thread: (rootId: string, options: { before?: string | null; after?: string | null; around?: string | null } = {}) =>
    request<ChatThread>(`/api/chat/threads/${rootId}${query(options)}`, "Couldn't load the thread. Try again."),
  unreads: () => request<ChatUnreads>("/api/chat/unreads", "Couldn't load unread messages. Try again."),
  threads: (cursor?: string | null) => request<ChatThreads>(`/api/chat/threads${query({ cursor })}`, "Couldn't load threads. Try again."),
  saved: (cursor?: string | null) => request<ChatSaved>(`/api/chat/saved${query({ cursor })}`, "Couldn't load saved messages. Try again."),
  savedIds: () => request<ChatSavedIds>("/api/chat/saved/ids", "Couldn't load saved messages. Try again."),
  people: (workspaceId?: string | null) =>
    request<{ people: (ChatPerson & { email: string | null })[] }>(`/api/chat/people${query({ workspace: workspaceId })}`, "Couldn't load people. Try again."),
  search: (wanted: ChatSearchQuery, cursor?: string | null) =>
    request<ChatSearch>(
      `/api/chat/search${query({ q: wanted.q, in: wanted.in, from: wanted.from, file: wanted.file ? "1" : null, after: wanted.after, before: wanted.before, cursor })}`,
      "Couldn't search. Try again.",
    ),
  find: (id: string, text: string) => request<ChatSearchResult>(`/api/chat/${id}/search${query({ q: text })}`, "Couldn't search. Try again."),
  markRead: (id: string, upTo: string | null) => markUpTo<{ lastReadAt: string }>(`/api/chat/${id}/read`, "Couldn't mark it read. Try again.", upTo),
  markThreadRead: (rootId: string, upTo: string | null) =>
    markUpTo<{ lastReadAt: string | null }>(`/api/chat/threads/${rootId}/read`, "Couldn't mark the thread read. Try again.", upTo),
};

export function newClientKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function draftKey(userId: string, conversationId: string, parentId: string | null) {
  const room = `${DRAFT_PREFIX}${userId}:${conversationId}`;
  return parentId ? `${room}:${parentId}` : room;
}

export function clearDrafts(userId: string, conversationId: string) {
  const room = draftKey(userId, conversationId, null);
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
      (key): key is string => key !== null && (key === room || key.startsWith(`${room}:`)),
    );
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
}

export function readDraft(key: string): ChatDraft {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as ChatDraft | null;
    if (stored && typeof stored.text === "string" && Array.isArray(stored.mentions)) return stored;
  } catch {}
  return { text: "", mentions: [] };
}

export type FormatScope = "room" | "thread";

const FORMAT_BAR_PREFIX = "chat-format-bar:";
const FORMAT_BAR_EVENT = "orbit-chat-format-bar";

export function formatBarDefault(scope: FormatScope) {
  return scope === "room";
}

export function readFormatBar(userId: string, scope: FormatScope) {
  try {
    const stored = localStorage.getItem(`${FORMAT_BAR_PREFIX}${userId}:${scope}`);
    if (stored === "on") return true;
    if (stored === "off") return false;
  } catch {}
  return formatBarDefault(scope);
}

export function writeFormatBar(userId: string, scope: FormatScope, shown: boolean) {
  try {
    localStorage.setItem(`${FORMAT_BAR_PREFIX}${userId}:${scope}`, shown ? "on" : "off");
  } catch {}
  window.dispatchEvent(new Event(FORMAT_BAR_EVENT));
}

export function subscribeFormatBar(listener: () => void) {
  window.addEventListener(FORMAT_BAR_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(FORMAT_BAR_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

const RECENT_EMOJI_PREFIX = "chat-emoji-recent:";
const SKIN_TONE_PREFIX = "chat-emoji-tone:";
const EMOJI_PREFS_EVENT = "orbit-chat-emoji";
const RECENT_EMOJI_KEPT = 18;
export const QUICK_REACTIONS = 5;

export const DEFAULT_RECENT_EMOJI = ["✅️", "\u{1F440}", "\u{1F44D}️", "\u{1F389}", "\u{1F602}", "❤️", "\u{1F64F}", "\u{1F680}", "\u{1F525}"];

export function readRecentEmojiText(userId: string) {
  try {
    return localStorage.getItem(`${RECENT_EMOJI_PREFIX}${userId}`) ?? "";
  } catch {
    return "";
  }
}

export function recentEmoji(text: string) {
  let stored: unknown = null;
  try {
    stored = text ? JSON.parse(text) : null;
  } catch {}
  const mine = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64) : [];
  return [...new Set([...mine, ...DEFAULT_RECENT_EMOJI])].slice(0, RECENT_EMOJI_KEPT);
}

export function pushRecentEmoji(userId: string, emoji: string) {
  const recent = recentEmoji(readRecentEmojiText(userId));
  if (recent.slice(0, QUICK_REACTIONS).includes(emoji)) return;
  const current = recent.filter((item) => item !== emoji);
  try {
    localStorage.setItem(`${RECENT_EMOJI_PREFIX}${userId}`, JSON.stringify([emoji, ...current].slice(0, RECENT_EMOJI_KEPT)));
  } catch {}
  window.dispatchEvent(new Event(EMOJI_PREFS_EVENT));
}

export function readSkinTone(userId: string) {
  try {
    const value = Number(localStorage.getItem(`${SKIN_TONE_PREFIX}${userId}`));
    if (Number.isInteger(value) && value >= 0 && value <= 5) return value;
  } catch {}
  return 0;
}

export function writeSkinTone(userId: string, tone: number) {
  try {
    localStorage.setItem(`${SKIN_TONE_PREFIX}${userId}`, String(tone));
  } catch {}
  window.dispatchEvent(new Event(EMOJI_PREFS_EVENT));
}

export function subscribeEmojiPrefs(listener: () => void) {
  window.addEventListener(EMOJI_PREFS_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EMOJI_PREFS_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function writeDraft(key: string, draft: ChatDraft) {
  try {
    if (draft.text.trim()) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {}
}

const queuedFiles = new Map<string, ChatAttachment[]>();
const handedOff = new Set<string>();

export function writeQueuedFiles(key: string, files: ChatAttachment[]) {
  if (files.length > 0) queuedFiles.set(key, files);
  else queuedFiles.delete(key);
}

export function takeQueuedFiles(key: string) {
  const files = queuedFiles.get(key) ?? [];
  queuedFiles.delete(key);
  for (const file of files) handedOff.add(file.id);
  return files;
}

export function releaseHandedOff(id: string) {
  return handedOff.delete(id);
}
