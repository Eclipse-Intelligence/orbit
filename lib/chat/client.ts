import type { ChatPage, ChatPerson, ChatRoom, ChatSidebar, ChatThread, ChatThreads } from "@/lib/chat/types";
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
  thread: (rootId: string, options: { before?: string | null; after?: string | null } = {}) =>
    request<ChatThread>(`/api/chat/threads/${rootId}${query(options)}`, "Couldn't load the thread. Try again."),
  threads: (cursor?: string | null) => request<ChatThreads>(`/api/chat/threads${query({ cursor })}`, "Couldn't load threads. Try again."),
  people: (workspaceId?: string | null) =>
    request<{ people: (ChatPerson & { email: string | null })[] }>(`/api/chat/people${query({ workspace: workspaceId })}`, "Couldn't load people. Try again."),
  markRead: (id: string, upTo: string | null) => markUpTo<{ lastReadAt: string }>(`/api/chat/${id}/read`, "Couldn't mark it read. Try again.", upTo),
  markThreadRead: (rootId: string, upTo: string | null) =>
    markUpTo<{ lastReadAt: string | null }>(`/api/chat/threads/${rootId}/read`, "Couldn't mark the thread read. Try again.", upTo),
};

export function newClientKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function draftKey(conversationId: string, parentId: string | null) {
  return parentId ? `${DRAFT_PREFIX}thread:${parentId}` : `${DRAFT_PREFIX}${conversationId}`;
}

export function readDraft(key: string): ChatDraft {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as ChatDraft | null;
    if (stored && typeof stored.text === "string" && Array.isArray(stored.mentions)) return stored;
  } catch {}
  return { text: "", mentions: [] };
}

export function writeDraft(key: string, draft: ChatDraft) {
  try {
    if (draft.text.trim()) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {}
}
