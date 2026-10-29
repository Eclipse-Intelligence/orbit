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
