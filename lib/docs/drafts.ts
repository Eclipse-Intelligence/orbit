export type LocalDraft = {
  title: string;
  body: string;
  baseRevision: number;
  at: number;
};

const PREFIX = "orbit-docs-draft:";

let scope: string | null = null;

export function setDraftScope(value: string | null) {
  scope = value;
}

function storage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function keyFor(id: string) {
  return scope ? `${PREFIX}${scope}:${id}` : null;
}

export function readDraft(id: string): LocalDraft | null {
  const store = storage();
  const key = keyFor(id);
  if (!store || !key) return null;
  try {
    const parsed = JSON.parse(store.getItem(key) ?? "null") as LocalDraft | null;
    if (!parsed || typeof parsed.body !== "string" || typeof parsed.title !== "string" || typeof parsed.baseRevision !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft(id: string, draft: LocalDraft) {
  const store = storage();
  const key = keyFor(id);
  if (!store || !key) return false;
  try {
    store.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(id: string, saved?: { title: string; body: string }) {
  const store = storage();
  const key = keyFor(id);
  if (!store || !key) return;
  if (saved) {
    const current = readDraft(id);
    if (current && (current.body !== saved.body || current.title !== saved.title)) return;
  }
  try {
    store.removeItem(key);
  } catch {}
}

export function draftToRestore(draft: LocalDraft | null, server: { title: string; body: string; kind?: string }) {
  if (!draft) return null;
  if (draft.body === server.body && (server.kind === "daily" || draft.title === server.title)) return null;
  return draft;
}

const LIVE_PREFIX = "orbit-docs-live:";

function liveKeyFor(id: string) {
  return scope ? `${LIVE_PREFIX}${scope}:${id}` : null;
}

export function readLiveDraft(id: string): string | null {
  const store = storage();
  const key = liveKeyFor(id);
  if (!store || !key) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

export function writeLiveDraft(id: string, delta: string) {
  const store = storage();
  const key = liveKeyFor(id);
  if (!store || !key) return;
  try {
    store.setItem(key, delta);
  } catch {}
}

export function clearLiveDraft(id: string) {
  const store = storage();
  const key = liveKeyFor(id);
  if (!store || !key) return;
  try {
    store.removeItem(key);
  } catch {}
}
