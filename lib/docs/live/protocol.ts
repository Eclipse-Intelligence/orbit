import type { ParticipantKind } from "@/lib/docs/client-types";

export type LiveTransportKind = "supabase" | "relay";

export type LiveEvent = "hello" | "state" | "update" | "awareness" | "saved" | "pull" | "title" | "writing" | "alert" | "chat" | "typing" | "mail_share" | "kick" | "synced";

export type LiveUser = { id: string; name: string; kind: ParticipantKind };

type LiveCursor = { anchor: unknown; head: unknown };

export type LiveAwareness = {
  user: LiveUser;
  cursor?: LiveCursor | null;
  from?: unknown;
  writing?: boolean;
  saver?: boolean;
};

export type HelloMessage = { c: number; sv: string; g?: number };
export type StateMessage = { to: number; u: string; g?: number };
export type UpdateMessage = { u?: string; a?: string; c?: number; s?: number; g?: number; server?: boolean };
export type AwarenessMessage = { a: string };
export type SavedMessage = { sv: string; r: number; g?: number };
export type TitleMessage = { t: string };
export type WritingMessage = { pageId: string; user: LiveUser; writing: boolean; revision?: number };
export type AlertMessage = { source: string };
export type SyncedKind = "mail" | "calendar" | "campaigns";
export type SyncedMessage = { kind: SyncedKind; origin?: string };

export const LIVE_MESSAGE_MAX = 180_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_KEY = /^[0-9a-f]{32}$/i;

export function docTopic(pageId: string, key?: string | null) {
  const topic = `doc:${pageId.toLowerCase()}`;
  return key ? `${topic}:${key.toLowerCase()}` : topic;
}

export function workspaceTopic(workspaceId: string) {
  return `docs-workspace:${workspaceId.toLowerCase()}`;
}

export function personTopic(userId: string) {
  return `docs-person:${userId.toLowerCase()}`;
}

export function chatTopic(conversationId: string) {
  return `chat:${conversationId.toLowerCase()}`;
}

export function draftTopic(shareId: string) {
  return `draft:${shareId.toLowerCase()}`;
}

export type TopicTarget = { kind: "doc" | "workspace" | "person" | "chat" | "draft"; id: string; key?: string };

export function parseTopic(topic: string): TopicTarget | null {
  const [prefix, id, ...rest] = topic.split(":");
  if (!id || !UUID.test(id)) return null;
  if (prefix === "doc") {
    if (rest.length === 0) return { kind: "doc", id: id.toLowerCase() };
    if (rest.length === 1 && LIVE_KEY.test(rest[0])) return { kind: "doc", id: id.toLowerCase(), key: rest[0].toLowerCase() };
    return null;
  }
  if (rest.length > 0) return null;
  if (prefix === "docs-workspace") return { kind: "workspace", id: id.toLowerCase() };
  if (prefix === "docs-person") return { kind: "person", id: id.toLowerCase() };
  if (prefix === "chat") return { kind: "chat", id: id.toLowerCase() };
  if (prefix === "draft") return { kind: "draft", id: id.toLowerCase() };
  return null;
}

export function canonicalTopic(topic: string) {
  const target = parseTopic(topic);
  if (!target) return null;
  if (target.kind === "doc") return docTopic(target.id, target.key);
  if (target.kind === "chat") return chatTopic(target.id);
  if (target.kind === "draft") return draftTopic(target.id);
  return target.kind === "workspace" ? workspaceTopic(target.id) : personTopic(target.id);
}
