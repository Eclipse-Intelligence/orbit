"use client";

import { useContext, useEffect, useRef } from "react";
import { DocsContext } from "@/components/docs/use-docs";
import { emitShareEvent, onShareEvent } from "@/components/mail/share-client";
import type { MailShareLiveEvent } from "@/lib/mail/share-types";

export function useMailShareEvents(handler: (event: MailShareLiveEvent) => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => onShareEvent((event) => latest.current(event)), []);
}

export default function MailShareLive() {
  const seed = useContext(DocsContext)?.seed ?? null;
  const live = seed?.live ?? null;
  const userId = seed?.viewer.id ?? null;

  useEffect(() => {
    if (!live || !userId) return;
    let stopped = false;
    let stop: (() => void) | null = null;
    void import("@/lib/docs/live/client")
      .then((module) => module.watchMailShares(live, userId, emitShareEvent, () => undefined))
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
