"use client";

import { useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { DocsContext } from "@/components/docs/use-docs";
import type { SyncedKind } from "@/lib/docs/live/protocol";

const SETTLE_MS = 400;

type Listener = (kind: SyncedKind) => void;

const listeners = new Set<Listener>();
const rejoins = new Set<() => void>();
const liveListeners = new Set<() => void>();
let live = false;

function setLive(next: boolean) {
  if (live === next) return;
  live = next;
  for (const listener of liveListeners) listener();
}

function subscribeLive(listener: () => void) {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
}

export function useSyncSignalsLive() {
  return useSyncExternalStore(
    subscribeLive,
    () => live,
    () => false,
  );
}

export function useSyncSignal(kind: SyncedKind, handler: () => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    let timer = 0;
    const run = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => latest.current(), SETTLE_MS);
    };
    const listener: Listener = (signalled) => {
      if (signalled === kind) run();
    };
    listeners.add(listener);
    rejoins.add(run);
    return () => {
      window.clearTimeout(timer);
      listeners.delete(listener);
      rejoins.delete(run);
    };
  }, [kind]);
}

export default function SyncSignals() {
  const seed = useContext(DocsContext)?.seed ?? null;
  const transport = seed?.live ?? null;
  const publishing = seed?.livePublish === true;
  const userId = seed?.viewer.id ?? null;

  useEffect(() => {
    if (!transport || !userId || !publishing) {
      setLive(false);
      return;
    }
    let stopped = false;
    let stop: (() => void) | null = null;
    let joined = false;
    void import("@/lib/docs/live/client")
      .then((module) =>
        module.watchSyncSignals(
          transport,
          userId,
          (kind) => {
            for (const listener of [...listeners]) listener(kind);
          },
          (now) => {
            if (now && !joined) for (const listener of [...rejoins]) listener();
            joined = now;
            setLive(now);
          },
        ),
      )
      .then((close) => {
        if (stopped) close();
        else stop = close;
      })
      .catch(() => setLive(false));
    return () => {
      stopped = true;
      stop?.();
      setLive(false);
    };
  }, [transport, userId, publishing]);

  return null;
}
