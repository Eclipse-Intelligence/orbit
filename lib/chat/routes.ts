import { EMPTY_SEARCH, readSearchQuery, writeSearchQuery } from "@/lib/chat/search";
import type { ChatSearchQuery } from "@/lib/chat/types";

export const CHAT_PATH = "/chat";
export const CHAT_THREADS_PATH = "/chat/threads";
export const CHAT_UNREADS_PATH = "/chat/unreads";
export const CHAT_SAVED_PATH = "/chat/saved";
export const CHAT_SCHEDULED_PATH = "/chat/scheduled";
export const CHAT_SEARCH_PATH = "/chat/search";

export type ChatView = { kind: "home" } | { kind: "threads" } | { kind: "unreads" } | { kind: "saved" } | { kind: "scheduled" } | { kind: "search"; query: ChatSearchQuery } | { kind: "room"; id: string };

export type ChatLocation = { view: ChatView; thread: string | null; message: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChatId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

function decoded(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function chatHistoryState(pushed: boolean) {
  return { chatPushed: pushed };
}

function idParam(params: URLSearchParams, name: string) {
  const value = params.get(name);
  return isChatId(value) ? value.toLowerCase() : null;
}

export function chatSegments(segments: string[]): ChatView | null {
  if (segments.length === 0) return { kind: "home" };
  if (segments.length !== 1) return null;
  const [segment] = segments;
  if (segment === "threads") return { kind: "threads" };
  if (segment === "unreads") return { kind: "unreads" };
  if (segment === "saved") return { kind: "saved" };
  if (segment === "scheduled") return { kind: "scheduled" };
  if (segment === "search") return { kind: "search", query: EMPTY_SEARCH };
  return isChatId(segment) ? { kind: "room", id: segment.toLowerCase() } : null;
}

export function parseChatLocation(pathname: string, search: URLSearchParams | string = ""): ChatLocation | null {
  if (pathname !== CHAT_PATH && !pathname.startsWith(`${CHAT_PATH}/`)) return null;
  const segments = pathname
    .slice(CHAT_PATH.length)
    .split("/")
    .filter(Boolean)
    .map(decoded);
  const parsed = chatSegments(segments);
  if (!parsed) return null;
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const view: ChatView = parsed.kind === "search" ? { kind: "search", query: readSearchQuery(params) } : parsed;
  const thread = view.kind === "home" || view.kind === "search" || view.kind === "scheduled" ? null : idParam(params, "thread");
  const message = view.kind === "room" || thread ? idParam(params, "message") : null;
  return { view, thread, message };
}

export function chatLocationHref(location: { view: ChatView; thread?: string | null; message?: string | null }) {
  const { view } = location;
  const path =
    view.kind === "home"
      ? CHAT_PATH
      : view.kind === "threads"
        ? CHAT_THREADS_PATH
        : view.kind === "unreads"
          ? CHAT_UNREADS_PATH
          : view.kind === "saved"
            ? CHAT_SAVED_PATH
            : view.kind === "scheduled"
              ? CHAT_SCHEDULED_PATH
              : view.kind === "search"
                ? CHAT_SEARCH_PATH
                : `${CHAT_PATH}/${view.id}`;
  const params = view.kind === "search" ? writeSearchQuery(view.query) : new URLSearchParams();
  if (location.thread && view.kind !== "home" && view.kind !== "search" && view.kind !== "scheduled") {
    params.set("thread", location.thread);
    if (location.message) params.set("message", location.message);
  } else if (location.message && view.kind === "room") params.set("message", location.message);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function roomHref(conversationId: string) {
  return chatLocationHref({ view: { kind: "room", id: conversationId } });
}

export function messageHref(conversationId: string, message: { id: string; parentId: string | null }) {
  return message.parentId
    ? chatLocationHref({ view: { kind: "room", id: conversationId }, thread: message.parentId, message: message.id })
    : chatLocationHref({ view: { kind: "room", id: conversationId }, message: message.id });
}

export function sameView(left: ChatView, right: ChatView) {
  if (left.kind !== right.kind) return false;
  return left.kind !== "room" || (right.kind === "room" && left.id === right.id);
}
