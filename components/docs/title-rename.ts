import { useCallback, useEffect, useRef } from "react";
import { renameDocAction } from "@/app/(crm)/docs/actions";
import { commitNow, useDocsStore } from "@/stores/docs-store";

export const RENAME_SETTLE_MS = 800;
export const TITLE_FORBIDDEN = /[#[\]|]/g;
export const TITLE_RULE = "A title can't contain #, [, ] or |, because links use them.";
const IDLE_WAIT_MS = 10_000;
const IDLE_POLL_MS = 150;

function saved(id: string) {
  const store = useDocsStore.getState();
  return store.saves[id]?.status === "saved" && !store.conflicts[id];
}

async function whenSaved(id: string) {
  const started = Date.now();
  while (!saved(id) && Date.now() - started < IDLE_WAIT_MS) {
    const status = useDocsStore.getState().saves[id]?.status;
    if (status === "error" || status === "conflict" || status === "offline") return false;
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
  return saved(id);
}

async function renameNow(id: string, title: string) {
  await commitNow(id);
  if (!(await whenSaved(id))) return false;
  const result = await renameDocAction(id, title).catch(() => null);
  if (!result || result.error !== undefined) return false;
  if (result.data.linksUpdated > 0) void useDocsStore.getState().refreshTitles();
  return true;
}

export function useTitleRename(id: string, initial: string, enabled: boolean) {
  const renamed = useRef(initial.trim());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(initial);

  const settle = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = latest.current.replace(/\s+/g, " ").trim();
    if (!enabled || !next || next === renamed.current) return;
    const previous = renamed.current;
    renamed.current = next;
    void renameNow(id, next).then((done) => {
      if (!done && renamed.current === next) renamed.current = previous;
    });
  }, [id, enabled]);

  const typed = useCallback(
    (value: string) => {
      latest.current = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(settle, RENAME_SETTLE_MS);
    },
    [settle],
  );

  useEffect(
    () => () => {
      if (timer.current) settle();
    },
    [settle],
  );

  return { typed, settle };
}
