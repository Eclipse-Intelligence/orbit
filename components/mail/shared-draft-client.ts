"use client";

import { ShareRequestError } from "@/components/mail/share-client";
import type { MailShareCandidate, MailSharePerson, SharedDraft } from "@/lib/mail/share-types";
import type { DraftTextChanges } from "@/lib/mail/shared-text";

const OFFLINE = "You're offline. Try again.";

export class DraftRequestError extends ShareRequestError {
  detail: { changed?: boolean; locked?: boolean };
  constructor(message: string, status: number, detail: { changed?: boolean; locked?: boolean }) {
    super(message, status);
    this.detail = detail;
  }
}

async function call<T>(url: string, init: RequestInit, fallback: string, keepalive = false): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", keepalive, ...init }).catch(() => null);
  if (!response) throw new DraftRequestError(OFFLINE, 0, {});
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; changed?: boolean; locked?: boolean };
  if (!response.ok) throw new DraftRequestError(body.error || fallback, response.status, { changed: body.changed, locked: body.locked });
  return body;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function fetchSharedDraft(shareId: string) {
  return call<SharedDraft>(`/api/mail/shared/${encodeURIComponent(shareId)}/draft`, {}, "Couldn't load the draft. Try again.");
}

export function saveSharedDraftText(shareId: string, changes: DraftTextChanges, base: number | null, keepalive = false) {
  return call<{ version: number; savedAt: string }>(
    `/api/mail/shared/${encodeURIComponent(shareId)}/draft`,
    json("PUT", { ...changes, base }),
    "Couldn't save the draft. Try again.",
    keepalive,
  );
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

export function holdSharedDraft(draftId: string, sending: boolean, version: number | null = null) {
  return call<{ shared: boolean }>("/api/mail/drafts/hold", json("POST", { draftId, sending, version }), "Couldn't send. Try again.", !sending);
}
