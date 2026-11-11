"use client";

import type { MailShareControl, MailShareLiveEvent, SharedThread, SharedThreadSummary } from "@/lib/mail/share-types";

const OFFLINE = "You're offline. Try again.";

export class ShareRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(url: string, fallback: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" }).catch(() => null);
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

const controls = new Map<string, MailShareControl>();

export function cachedShareControl(threadKey: string) {
  return controls.get(threadKey) ?? null;
}

export function storeShareControl(threadKey: string, control: MailShareControl) {
  controls.set(threadKey, control);
}

export function fetchShareControl(threadKey: string) {
  return getJson<MailShareControl>(`/api/mail/share?thread=${encodeURIComponent(threadKey)}`, "Couldn't load who can see this thread. Try again.").then((control) => {
    controls.set(threadKey, control);
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
