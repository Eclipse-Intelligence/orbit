"use client";

import { useEffect } from "react";
import Button from "@/components/_ui/button";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";

export default function DocsNotice() {
  const notice = useDocsStore((state) => state.notice);
  const dismiss = useDocsStore((state) => state.dismissNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(dismiss, notice.undo ? 7000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice, dismiss]);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 md:bottom-6">
      {notice && (
        <div
          key={notice.id}
          role={notice.tone === "alert" ? "alert" : "status"}
          className={cn(
            "bg-popover border-line-strong shadow-overlay animate-rise-in pointer-events-auto flex max-w-[30rem] items-center gap-3 rounded-full border py-1.5 pr-1.5 pl-4",
            notice.tone === "alert" && "text-danger",
          )}
        >
          <span className="ui-style min-w-0 flex-1">{notice.message}</span>
          {notice.undo && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                notice.undo?.();
                dismiss();
              }}
            >
              Undo
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
