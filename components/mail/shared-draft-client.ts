"use client";

import { ShareRequestError } from "@/components/mail/share-client";
import type { MailShareCandidate, MailSharePerson, SharedDraft } from "@/lib/mail/share-types";

const OFFLINE = "You're offline. Try again.";

async function call<T>(url: string, init: RequestInit, fallback: string, keepalive = false): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", keepalive, ...init }).catch(() => null);
  if (!response) throw new ShareRequestError(OFFLINE, 0);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ShareRequestError(body.error || fallback, response.status);
  return body;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function fetchSharedDraft(shareId: string) {
  return call<SharedDraft>(`/api/mail/shared/${encodeURIComponent(shareId)}/draft`, {}, "Couldn't load the draft. Try again.");
}

export function saveSharedDraftText(shareId: string, text: { subject?: string | null; body?: string | null }) {
  return call<{ version: number; savedAt: string }>(`/api/mail/shared/${encodeURIComponent(shareId)}/draft`, json("PUT", text), "Couldn't save the draft. Try again.");
}

export function fetchDraftCandidates() {
  return call<{ candidates: MailShareCandidate[] }>("/api/mail/drafts/share", {}, "Couldn't load people. Try again.").then((body) => body.candidates ?? []);
}

export function fetchDraftPeople(shareId: string) {
  return call<{ people: MailSharePerson[] }>(`/api/mail/drafts/share?share=${encodeURIComponent(shareId)}`, {}, "Couldn't load who is in this draft. Try again.").then((body) => body.people ?? []);
}

export function shareDraftWith(draftId: string, people: string[]) {
  return call<{ shareId: string; people: MailSharePerson[]; added: string[] }>("/api/mail/drafts/share", json("POST", { draftId, people }), "Couldn't share the draft. Try again.");
}

export function holdSharedDraft(draftId: string, sending: boolean) {
  return call<{ shared: boolean }>("/api/mail/drafts/hold", json("POST", { draftId, sending }), "Couldn't update the draft. Try again.", true).catch(() => ({ shared: false }));
}
