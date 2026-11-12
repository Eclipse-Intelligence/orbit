"use client";

import { useContext, useEffect, useRef } from "react";
import { DocsContext } from "@/components/docs/use-docs";
import { emitShareEvent, emitShareRejoin, onShareEvent, onShareRejoin } from "@/components/mail/share-client";
import type { MailShareLiveEvent } from "@/lib/mail/share-types";

export function useMailShareEvents(handler: (event: MailShareLiveEvent) => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => onShareEvent((event) => latest.current(event)), []);
}

export function useShareResync(handler: () => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const stop = onShareRejoin(run);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      stop();
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, []);
}

export default function MailShareLive() {
  const seed = useContext(DocsContext)?.seed ?? null;
  const live = seed?.live ?? null;
  const userId = seed?.viewer.id ?? null;

  useEffect(() => {
    if (!live || !userId) return;
    let stopped = false;
    let stop: (() => void) | null = null;
    let joined = false;
    void import("@/lib/docs/live/client")
      .then((module) =>
        module.watchMailShares(live, userId, emitShareEvent, (now) => {
          if (now && !joined) emitShareRejoin();
          joined = now;
        }),
      )
      .then((close) => {
        if (stopped) close();
        else stop = close;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      stop?.();
    };
  }, [live, userId]);

  return null;
}
