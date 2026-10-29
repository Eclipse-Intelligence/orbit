"use client";

import { useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { searchMentionsAction } from "@/app/(crm)/search";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { DocsContext, useDocsNavigate } from "@/components/docs/use-docs";
import type { DocsNav, DocsSeed } from "@/lib/docs/client-types";
import { connectDocs } from "@/lib/docs/connection";
import { dailyHref, isDocsPath, pageHref } from "@/lib/docs/routes";
import { commitAll, prepareDocs, retryOfflineSaves, useDocsStore, type VisibilityPrompt } from "@/stores/docs-store";

function visibilityText(prompt: VisibilityPrompt) {
  const what = prompt.kind === "folder" ? `${prompt.name} and every note in it` : prompt.name;
  if (prompt.after === "shared") {
    return {
      title: `Share ${prompt.name} with the workspace?`,
      description: `Moving it to ${prompt.destination} shares ${what} with everyone in the workspace. They can find, read and edit it, and so can the assistant and workspace agents.`,
      confirm: "Move and share",
    };
  }
  return {
    title: `Make ${prompt.name} private?`,
    description: `Moving it to ${prompt.destination} makes ${what} private to its owner. Teammates and workspace agents lose access, and links to it from shared notes show only the title.`,
    confirm: "Move and make private",
  };
}

function VisibilityConfirm() {
  const prompt = useDocsStore((state) => state.visibilityPrompt);
  const close = useDocsStore((state) => state.closeVisibilityPrompt);
  const text = prompt ? visibilityText(prompt) : null;
  return (
    <ConfirmDialog
      open={Boolean(prompt)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={text?.title ?? ""}
      description={text?.description ?? ""}
      confirmLabel={text?.confirm ?? "Move"}
      tone="neutral"
      onConfirm={() => {
        if (prompt) void prompt.retry();
      }}
    />
  );
}

function DocsShortcuts() {
  const navigate = useDocsNavigate();
  const createNote = useDocsStore((state) => state.createNote);
  const today = useDocsStore((state) => state.nav?.today);

  useShortcut("create-note", () => {
    void createNote().then((page) => {
      if (page) navigate(pageHref(page.id));
    });
  });
  useShortcut("docs-daily", () => {
    if (today) navigate(dailyHref(today));
  });
  useShortcut("docs-search", () => {
    const field = [...document.querySelectorAll<HTMLInputElement>("[data-docs-search]")].find((item) => item.getClientRects().length > 0);
    if (field) {
      field.focus();
      field.select();
      return;
    }
    navigate("/docs?search=1");
  });
  return null;
}

export default function DocsProvider({ seed, nav, children }: { seed: DocsSeed; nav: DocsNav; children: ReactNode }) {
  prepareDocs(seed);
  const value = useMemo(() => ({ seed, nav }), [seed, nav]);
  const focus = useDocsStore((state) => state.focus);
  const onDocs = isDocsPath(usePathname() ?? "");

  useLayoutEffect(() => {
    connectDocs({
      recordSearch: async (query) =>
        (await searchMentionsAction(query)).map((option) => ({ kind: option.kind, id: option.id, name: option.name, detail: option.detail ?? null })),
      live: seed.live ? { kind: seed.live, workspaceId: seed.workspaceId, userId: seed.viewer.id, publish: seed.livePublish === true } : null,
    });
    if (!onDocs) return;
    const store = useDocsStore.getState();
    if (store.ready) return;
    store.init(seed, store.nav ?? nav);
    void store.refreshNav();
  }, [seed, nav, onDocs]);

  useEffect(() => {
    if (onDocs || useDocsStore.getState().nav) return;
    const load = () => void useDocsStore.getState().refreshNav();
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(load, { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(load, 1500);
    return () => window.clearTimeout(timer);
  }, [onDocs]);

  useEffect(() => {
    if (focus) document.documentElement.dataset.docsFocus = "";
    else delete document.documentElement.dataset.docsFocus;
  }, [focus]);

  useEffect(() => {
    const flush = () => commitAll(true, true);
    const hidden = () => {
      if (document.visibilityState === "hidden") commitAll(true);
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("online", retryOfflineSaves);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("online", retryOfflineSaves);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  return (
    <DocsContext.Provider value={value}>
      {children}
      <DocsShortcuts />
      <VisibilityConfirm />
    </DocsContext.Provider>
  );
}
