"use client";

import { useEffect, useState } from "react";
import Button from "@/components/_ui/button";
import { useDocsStore, type Notice } from "@/stores/docs-store";
import { cn } from "@/lib/utils";

const NOTICE_MS = 4000;
const UNDO_MS = 15000;

function Toast({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(onDismiss, notice.undo ? UNDO_MS : NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss, held]);

  return (
    <div
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
      }}
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
            onDismiss();
          }}
        >
          Undo
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

export default function DocsNotice() {
  const notice = useDocsStore((state) => state.notice);
  const dismiss = useDocsStore((state) => state.dismissNotice);
  const alert = notice?.tone === "alert" ? notice : null;
  const status = notice && notice.tone !== "alert" ? notice : null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center px-4">
      <div role="status" className="flex justify-center">
        {status && <Toast key={status.id} notice={status} onDismiss={dismiss} />}
      </div>
      <div role="alert" className="flex justify-center">
        {alert && <Toast key={alert.id} notice={alert} onDismiss={dismiss} />}
      </div>
    </div>
  );
}
