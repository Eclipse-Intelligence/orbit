import type { DraftNews } from "@/lib/task-field-errors";

export type DraftField = "title" | "text";
export type DraftChange = DraftNews & { id: string; field: DraftField; from: object };
type Draft = { title?: string; text?: string };

export function taskDrafts() {
  const drafts = new Map<string, Draft>();
  const watchers = new Set<(change: DraftChange) => void>();
  const tell = (change: DraftChange) => {
    for (const watcher of watchers) if (change.from !== watcher) watcher(change);
  };
  return {
    get(id: string): Draft | undefined {
      const draft = drafts.get(id);
      return draft ? { ...draft } : undefined;
    },
    keep(from: object, id: string, field: DraftField, value: string, saved: string) {
      drafts.set(id, { ...drafts.get(id), [field]: value });
      tell({ id, field, from, kept: true, draft: value, saved });
    },
    drop(from: object, id: string, field: DraftField, saved: string) {
      const draft = drafts.get(id);
      const value = draft?.[field];
      if (!draft || value === undefined) return;
      delete draft[field];
      if (draft.title === undefined && draft.text === undefined) drafts.delete(id);
      tell({ id, field, from, kept: false, draft: value, saved });
    },
    watch(watcher: (change: DraftChange) => void): () => void {
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
  };
}

export function draftAfterSave(saved: boolean, declined: boolean): "drop" | "keep" {
  return saved || declined ? "drop" : "keep";
}

export function draftCommit(field: DraftField, typed: string, saved: string) {
  const next = typed.trim();
  if (field === "title" && !next) return { save: false, value: saved };
  return next === saved ? { save: false, value: next } : { save: true, value: next };
}
