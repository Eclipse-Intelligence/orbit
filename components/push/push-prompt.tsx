"use client";

import { useEffect, useState } from "react";
import Button from "@/components/_ui/button";
import { enablePush, pushState, type PushState } from "@/components/push/push-client";
import BellIcon from "@/public/assets/images/mail/bell.svg";
import CloseIcon from "@/public/assets/images/mail/close.svg";

const DISMISSED = "orbit-push-prompt";

export default function PushPrompt() {
  const [state, setState] = useState<PushState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED) === "1";
    } catch {}
    if (dismissed) return;
    void pushState().then((value) => live && setState(value));
    return () => {
      live = false;
    };
  }, []);

  if (state !== "off" && state !== "install") return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {}
    setState(null);
  }

  return (
    <div className="animate-rise-in bg-surface-field flex flex-col gap-1 rounded-lg py-1 pr-1 pl-3">
      <div className="flex min-h-8 items-center gap-2">
        <BellIcon aria-hidden className="text-primary-foreground size-3.5 shrink-0" />
        <p className="ui-style min-w-0 flex-1 leading-[1.3]">
          {state === "install" ? "For notifications, use Share › Add to Home Screen" : "Notify me about important email"}
        </p>
        {state === "off" && (
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              void enablePush()
                .then(() => pushState().then(setState))
                .catch((problem: Error) => setError(problem.message))
            }
          >
            Turn on
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="Dismiss notification prompt" title="Dismiss" onClick={dismiss}>
          <CloseIcon aria-hidden className="size-2.5" />
        </Button>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger pb-1">
          {error}
        </p>
      )}
    </div>
  );
}
