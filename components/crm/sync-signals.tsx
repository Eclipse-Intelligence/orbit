"use client";

import { useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { DocsContext } from "@/components/docs/use-docs";
import type { SyncedKind } from "@/lib/docs/live/protocol";
import { createSignalMerge } from "@/lib/signal-merge";
import { syncOrigin } from "@/lib/sync-origin";

const SETTLE_MS = 400;
const MAIL_SETTLE_MS = 2_000;
const MAIL_MAX_WAIT_MS = 5_000;

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

export function useSyncSignal(kind: SyncedKind, handler: () => void, hold?: () => boolean) {
  const latest = useRef(handler);
  const holding = useRef(hold);
  useEffect(() => {
    latest.current = handler;
    holding.current = hold;
  });
  useEffect(() => {
    const merge = createSignalMerge(
      { settleMs: kind === "mail" ? MAIL_SETTLE_MS : SETTLE_MS, maxWaitMs: kind === "mail" ? MAIL_MAX_WAIT_MS : undefined, hold: () => holding.current?.() === true },
      () => latest.current(),
    );
    const listener: Listener = (signalled) => {
      if (signalled === kind) merge.request();
    };
    listeners.add(listener);
    rejoins.add(merge.request);
    return () => {
      merge.cancel();
      listeners.delete(listener);
      rejoins.delete(merge.request);
    };
  }, [kind]);
}

export default function SyncSignals() {
  const seed = useContext(DocsContext)?.seed ?? null;
  const transport = seed?.live ?? null;
  const publishing = seed?.livePublish === true;
  const userId = seed?.viewer.id ?? null;
  const workspaceId = seed?.workspaceId ?? null;

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
          { userId, workspaceId, origin: syncOrigin() },
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
  }, [transport, userId, workspaceId, publishing]);

  return null;
}
