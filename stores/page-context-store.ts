import { useEffect } from "react";
import { create } from "zustand";
import type { PageFocusKind, PageInput, PageSelectionKind } from "@/lib/assistant/page-context";

type Selection = { kind: PageSelectionKind; ids: string[]; path: string };
type Focus = { kind: PageFocusKind; id: string; path: string };

type PageContextState = {
  selection: Selection | null;
  focus: Focus | null;
  select: (selection: Selection | null) => void;
  focusOn: (focus: Focus) => void;
};

export const usePageContextStore = create<PageContextState>((set) => ({
  selection: null,
  focus: null,
  select: (selection) => set({ selection }),
  focusOn: (focus) => set({ focus }),
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

export function focusOnPage(kind: PageFocusKind, id: string) {
  usePageContextStore.getState().focusOn({ kind, id, path: window.location.pathname });
}

export function usePageFocus(kind: PageFocusKind, id: string) {
  useEffect(() => focusOnPage(kind, id), [kind, id]);
}

export function pageSnapshot(): PageInput {
  const path = window.location.pathname;
  const { selection, focus } = usePageContextStore.getState();
  return {
    path,
    search: window.location.search,
    selection: selection && selection.path === path ? { kind: selection.kind, ids: selection.ids } : null,
    focus: focus && focus.path === path ? { kind: focus.kind, id: focus.id } : null,
  };
}
