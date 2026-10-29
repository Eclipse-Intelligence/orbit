"use client";

import { useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { searchMentionsAction } from "@/app/(crm)/search";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { DocsContext, useDocsNavigate } from "@/components/docs/use-docs";
import type { DocsNav, DocsSeed } from "@/lib/docs/client-types";
import { connectDocs } from "@/lib/docs/connection";
import { dailyHref, pageHref } from "@/lib/docs/routes";
import { commitAll, retryOfflineSaves, useDocsStore } from "@/stores/docs-store";

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
  const value = useMemo(() => ({ seed, nav }), [seed, nav]);
  const focus = useDocsStore((state) => state.focus);

  useLayoutEffect(() => {
    connectDocs(seed, {
      recordSearch: async (query) =>
        (await searchMentionsAction(query)).map((option) => ({ kind: option.kind, id: option.id, name: option.name, detail: option.detail ?? null })),
    });
    useDocsStore.getState().init(seed, nav);
  }, [seed, nav]);

  useEffect(() => {
    if (focus) document.documentElement.dataset.docsFocus = "";
    else delete document.documentElement.dataset.docsFocus;
  }, [focus]);

  useEffect(() => {
    const flush = () => commitAll(true);
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
    </DocsContext.Provider>
  );
}
