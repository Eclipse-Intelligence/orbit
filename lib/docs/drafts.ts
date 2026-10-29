export type LocalDraft = {
  title: string;
  body: string;
  baseRevision: number;
  at: number;
};

const PREFIX = "orbit-docs-draft:";

function storage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDraft(id: string): LocalDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const parsed = JSON.parse(store.getItem(`${PREFIX}${id}`) ?? "null") as LocalDraft | null;
    if (!parsed || typeof parsed.body !== "string" || typeof parsed.title !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft(id: string, draft: LocalDraft) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(`${PREFIX}${id}`, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(id: string, saved?: { title: string; body: string }) {
  const store = storage();
  if (!store) return;
  if (saved) {
    const current = readDraft(id);
    if (current && (current.body !== saved.body || current.title !== saved.title)) return;
  }
  try {
    store.removeItem(`${PREFIX}${id}`);
  } catch {}
}

export function draftToRestore(draft: LocalDraft | null, server: { title: string; body: string; updatedAt: string }) {
  if (!draft) return null;
  if (draft.body === server.body && draft.title === server.title) return null;
  if (draft.at < Date.parse(server.updatedAt) - 5_000) return null;
  return draft;
}
