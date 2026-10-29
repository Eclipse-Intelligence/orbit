import type { Presence } from "@/lib/docs/client-types";

type Listener = (list: Presence[] | null) => void;
type Entry = { list: Presence[] | null; listeners: Set<Listener> };

const presence = new Map<string, Entry>();

function entry(pageId: string) {
  let found = presence.get(pageId);
  if (!found) {
    found = { list: null, listeners: new Set() };
    presence.set(pageId, found);
  }
  return found;
}

export function publishPresence(pageId: string, list: Presence[] | null) {
  const found = entry(pageId);
  found.list = list;
  for (const listener of found.listeners) listener(list);
  if (list === null && found.listeners.size === 0) presence.delete(pageId);
}

export function watchLivePresence(pageId: string, listener: Listener) {
  const found = entry(pageId);
  found.listeners.add(listener);
  if (found.list) listener(found.list);
  return () => {
    found.listeners.delete(listener);
    if (found.listeners.size === 0 && found.list === null) presence.delete(pageId);
  };
}

const WRITING_TRUST_MS = 60_000;
const DONE_TRUST_MS = 5_000;

const trusted = new Map<string, number>();
const trustListeners = new Set<(pageId: string) => void>();

function trustKey(pageId: string, userId: string) {
  return `${pageId.toLowerCase()}|${userId}`;
}

export function trustWriter(pageId: string, userId: string, writing: boolean, now = Date.now()) {
  for (const [key, until] of trusted) if (until <= now) trusted.delete(key);
  trusted.set(trustKey(pageId, userId), now + (writing ? WRITING_TRUST_MS : DONE_TRUST_MS));
  for (const listener of trustListeners) listener(pageId);
}

export function onTrustChange(listener: (pageId: string) => void) {
  trustListeners.add(listener);
  return () => {
    trustListeners.delete(listener);
  };
}

export function trustedUser<User extends { id: string; kind: string }>(pageId: string, user: User, now = Date.now()): User {
  if (user.kind === "person") return user;
  const until = trusted.get(trustKey(pageId, user.id));
  return until !== undefined && until > now ? user : { ...user, kind: "person" };
}

export function clearTrust() {
  trusted.clear();
}
