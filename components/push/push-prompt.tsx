"use client";

import { useEffect, useState } from "react";
import Button from "@/components/_ui/button";
import { enablePush, pushState, type PushState } from "@/components/push/push-client";
import BellIcon from "@/public/assets/images/mail/bell.svg";

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
    <div className="animate-rise-in flex flex-col gap-2 rounded-xl bg-white/[0.04] px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <BellIcon aria-hidden className="text-primary-foreground size-3.5 shrink-0" />
        <p className="min-w-0 flex-1 text-[13px] leading-5">
          {state === "install"
            ? "For mail notifications, add Orbit to your Home Screen (Share, then Add to Home Screen) and open it from there."
            : "Get a notification when important email arrives."}
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
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
          <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </Button>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
