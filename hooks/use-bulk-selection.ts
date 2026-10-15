"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type BulkSelection = {
  ids: string[];
  selectedIds: string[];
  isSelected: (id: string) => boolean;
  revealed: boolean;
  selecting: boolean;
  allSelected: boolean;
  someSelected: boolean;
  setSelecting: (selecting: boolean) => void;
  toggle: (id: string, range?: boolean) => void;
  toggleAll: () => void;
  selectAll: () => void;
  keep: (ids: string[]) => void;
  clear: () => void;
};

function typing(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function useBulkSelection(ids: string[], resetKey: string): BulkSelection {
  const [selected, setSelected] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [key, setKey] = useState(resetKey);
  const anchor = useRef<string | null>(null);
  if (key !== resetKey) {
    setKey(resetKey);
    setSelected([]);
    setSelecting(false);
  }

  const selectedIds = useMemo(() => {
    const chosen = new Set(selected);
    return ids.filter((id) => chosen.has(id));
  }, [ids, selected]);
  const chosen = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = ids.length > 0 && selectedIds.length === ids.length;
  const someSelected = selectedIds.length > 0 && !allSelected;
  const revealed = selecting || selectedIds.length > 0;

  const clear = useCallback(() => {
    anchor.current = null;
    setSelected([]);
    setSelecting(false);
  }, []);

  const toggle = useCallback(
    (id: string, range = false) => {
      const next = !chosen.has(id);
      const from = range && anchor.current ? ids.indexOf(anchor.current) : -1;
      const to = ids.indexOf(id);
      const span =
        from >= 0 && to >= 0
          ? ids.slice(Math.min(from, to), Math.max(from, to) + 1)
          : [id];
      anchor.current = id;
      setSelected(() => {
        const updated = new Set(selectedIds);
        for (const item of span) {
          if (next) updated.add(item);
          else updated.delete(item);
        }
        return ids.filter((item) => updated.has(item));
      });
    },
    [chosen, ids, selectedIds],
  );

  const selectAll = useCallback(() => setSelected(ids), [ids]);

  const toggleAll = useCallback(() => {
    anchor.current = null;
    setSelected(allSelected ? [] : ids);
  }, [allSelected, ids]);

  const keep = useCallback((kept: string[]) => setSelected(kept), []);

  useEffect(() => {
    if (!revealed) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || typing(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      clear();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [revealed, clear]);

  return {
    ids,
    selectedIds,
    isSelected: (id) => chosen.has(id),
    revealed,
    selecting,
    allSelected,
    someSelected,
    setSelecting,
    toggle,
    toggleAll,
    selectAll,
    keep,
    clear,
  };
}
