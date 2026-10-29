import type { ParticipantKind } from "@/lib/docs/client-types";

export type LiveTransportKind = "supabase" | "relay";

export type LiveEvent = "hello" | "state" | "update" | "awareness" | "saved" | "pull" | "title" | "writing";

export type LiveUser = { id: string; name: string; kind: ParticipantKind };

type LiveCursor = { anchor: unknown; head: unknown };

export type LiveAwareness = {
  user: LiveUser;
  cursor?: LiveCursor | null;
  from?: unknown;
  writing?: boolean;
  saver?: boolean;
};

export type HelloMessage = { c: number; sv: string };
export type StateMessage = { to: number; u: string };
export type UpdateMessage = { u?: string; a?: string; c?: number; s?: number; server?: boolean };
export type AwarenessMessage = { a: string };
export type SavedMessage = { sv: string; r: number; seqs?: Record<string, number> };
export type TitleMessage = { t: string };
export type WritingMessage = { pageId: string; user: LiveUser; writing: boolean; revision?: number };

export const LIVE_MESSAGE_MAX = 180_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function docTopic(pageId: string) {
  return `doc:${pageId}`;
}

export function workspaceTopic(workspaceId: string) {
  return `docs-workspace:${workspaceId}`;
}

export function personTopic(userId: string) {
  return `docs-person:${userId}`;
}

export type TopicTarget = { kind: "doc" | "workspace" | "person"; id: string };

export function parseTopic(topic: string): TopicTarget | null {
  const [prefix, id, ...rest] = topic.split(":");
  if (rest.length > 0 || !id || !UUID.test(id)) return null;
  if (prefix === "doc") return { kind: "doc", id: id.toLowerCase() };
  if (prefix === "docs-workspace") return { kind: "workspace", id: id.toLowerCase() };
  if (prefix === "docs-person") return { kind: "person", id: id.toLowerCase() };
  return null;
}
