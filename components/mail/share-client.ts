"use client";

import type { MailShareControl, MailShareLiveEvent, MailSharePeople, SharedThread, SharedThreadSummary } from "@/lib/mail/share-types";

const OFFLINE = "You're offline. Try again.";

export class ShareRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(url: string, fallback: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal }).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    return null;
  });
  if (!response) throw new ShareRequestError(OFFLINE, 0);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ShareRequestError(body.error || fallback, response.status);
  return body;
}

export function fetchSharedList() {
  return getJson<{ threads: SharedThreadSummary[] }>("/api/mail/shared", "Couldn't load shared threads. Try again.").then((body) => body.threads ?? []);
}

export function fetchSharedThread(shareId: string) {
  return getJson<SharedThread>(`/api/mail/shared/${encodeURIComponent(shareId)}`, "Couldn't load the thread. Try again.");
}

const known = new Map<string, MailSharePeople>();
const asking = new Map<string, { request: Promise<MailSharePeople>; controller: AbortController; waiting: number }>();
const SHARE_FAILED = "Couldn't load who can see this thread. Try again.";

export function cachedSharePeople(threadKey: string) {
  return known.get(threadKey) ?? null;
}

export function storeSharePeople(threadKey: string, people: MailSharePeople) {
  known.set(threadKey, { shareId: people.shareId, people: people.people });
}

export function fetchSharePeople(threadKey: string, signal?: AbortSignal) {
  let entry = asking.get(threadKey);
  if (!entry) {
    const controller = new AbortController();
    const request = getJson<MailSharePeople>(`/api/mail/share?thread=${encodeURIComponent(threadKey)}&people=1`, SHARE_FAILED, controller.signal)
      .then((people) => {
        storeSharePeople(threadKey, people);
        return people;
      })
      .finally(() => {
        if (asking.get(threadKey)?.request === request) asking.delete(threadKey);
      });
    entry = { request, controller, waiting: 0 };
    asking.set(threadKey, entry);
  }
  const current = entry;
  current.waiting += 1;
  signal?.addEventListener("abort", () => {
    current.waiting -= 1;
    if (current.waiting <= 0) {
      current.controller.abort();
      if (asking.get(threadKey) === current) asking.delete(threadKey);
    }
  });
  return current.request;
}

export function fetchShareControl(threadKey: string) {
  return getJson<MailShareControl>(`/api/mail/share?thread=${encodeURIComponent(threadKey)}`, SHARE_FAILED).then((control) => {
    storeSharePeople(threadKey, control);
    return control;
  });
}

type ShareListener = (event: MailShareLiveEvent) => void;

const listeners = new Set<ShareListener>();

export function emitShareEvent(event: MailShareLiveEvent) {
  for (const listener of listeners) listener(event);
}

export function onShareEvent(listener: ShareListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
