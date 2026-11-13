import { useEffect } from "react";
import { create } from "zustand";
import type { PageFocusKind, PageInput, PageSelectionKind } from "@/lib/assistant/page-context";

type Selection = { kind: PageSelectionKind; ids: string[]; path: string };
type Focus = { kind: PageFocusKind; id: string; path: string; closedAt: number | null; pinned?: boolean };

export const FOCUS_GRACE_MS = 60_000;

type PageContextState = {
  selection: Selection | null;
  focus: Focus | null;
  select: (selection: Selection | null) => void;
  setFocus: (focus: Focus | null) => void;
};

export const usePageContextStore = create<PageContextState>((set) => ({
  selection: null,
  focus: null,
  select: (selection) => set({ selection }),
  setFocus: (focus) => set({ focus }),
}));

export function usePageSelection(kind: PageSelectionKind, ids: string[]) {
  const key = ids.join(",");
  useEffect(() => {
    const path = window.location.pathname;
    const { select } = usePageContextStore.getState();
    select(key ? { kind, ids: key.split(","), path } : null);
    return () => {
      if (usePageContextStore.getState().selection?.kind === kind) select(null);
    };
  }, [kind, key]);
}

export function focusOnPage(kind: PageFocusKind, id: string, options: { pinned?: boolean } = {}) {
  const { focus, setFocus } = usePageContextStore.getState();
  const path = window.location.pathname;
  const same = focus?.kind === kind && focus.id === id && focus.path === path;
  setFocus({ kind, id, path, closedAt: null, ...(options.pinned || (same && focus?.pinned) ? { pinned: true } : {}) });
}

const holders = new Map<string, number>();

const holderKey = (kind: PageFocusKind, id: string) => `${kind}:${id}`;

export function holdPageFocus(kind: PageFocusKind, id: string) {
  const key = holderKey(kind, id);
  holders.set(key, (holders.get(key) ?? 0) + 1);
  focusOnPage(kind, id);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (holders.get(key) ?? 1) - 1;
    if (left > 0) {
      holders.set(key, left);
      return;
    }
    holders.delete(key);
    releasePageFocus(kind, id);
  };
}

export function focusTaskForAsk(id: string, options: { closesPanel: boolean }) {
  focusOnPage("task", id, options.closesPanel ? { pinned: true } : {});
}

export function releasePageFocus(kind: PageFocusKind, id: string, options: { now?: boolean } = {}) {
  const { focus, setFocus } = usePageContextStore.getState();
  if (!focus || focus.kind !== kind || focus.id !== id || holders.has(holderKey(kind, id))) return;
  if (focus.pinned) setFocus({ ...focus, closedAt: Date.now() });
  else setFocus(options.now ? null : { ...focus, closedAt: Date.now() });
}

export function unpinPageFocus() {
  const { focus, setFocus } = usePageContextStore.getState();
  if (!focus?.pinned) return;
  setFocus({ kind: focus.kind, id: focus.id, path: focus.path, closedAt: focus.closedAt === null ? null : Date.now() });
}

export function usePageFocus(kind: PageFocusKind, id: string, active = true) {
  useEffect(() => {
    if (!active) return;
    return holdPageFocus(kind, id);
  }, [kind, id, active]);
}

export function useReleaseFocusOnUnmount(kind: PageFocusKind, id: string) {
  useEffect(() => () => releasePageFocus(kind, id, { now: true }), [kind, id]);
}

export function pageSnapshot(): PageInput {
  const path = window.location.pathname;
  const { selection, focus, setFocus } = usePageContextStore.getState();
  const fresh = focus && focus.path === path && (focus.pinned || focus.closedAt === null || Date.now() - focus.closedAt <= FOCUS_GRACE_MS);
  if (focus && !fresh) setFocus(null);
  return {
    path,
    search: window.location.search,
    selection: selection && selection.path === path ? { kind: selection.kind, ids: selection.ids } : null,
    focus: fresh ? { kind: focus.kind, id: focus.id } : null,
  };
}
