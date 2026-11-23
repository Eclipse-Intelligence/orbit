import type { MailAddress } from "@/lib/mail/types";
import type { ComposeAccount, DraftMode } from "@/lib/mail/view";

export const SAVE_DELAY_MS = 1500;
export const SAVE_MAX_WAIT_MS = 5000;
const KEEPALIVE_LIMIT_BYTES = 60_000;

export type DraftFields = {
  mode: DraftMode;
  messageId: string | null;
  sourceId: string;
  identityId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  signature: boolean;
  replaces: string | null;
  attachments: string[];
  remindHours: number | null;
  followUpDays: number | null;
  followUpBody: string | null;
};

function people(list: MailAddress[]) {
  return list.map((item) => [item.address, item.name ?? null]);
}

export function draftSignature(fields: DraftFields) {
  return JSON.stringify([
    fields.mode,
    fields.messageId,
    fields.sourceId,
    fields.identityId,
    people(fields.to),
    people(fields.cc),
    people(fields.bcc),
    fields.subject,
    fields.body,
    fields.signature,
    fields.replaces,
    fields.attachments,
    fields.remindHours,
    fields.followUpDays,
    fields.followUpBody,
  ]);
}

export function hasUnsaved(fields: DraftFields, saved: string | null) {
  return saved === null || draftSignature(fields) !== saved;
}

export function saveDelay(now: number, since: number, delay = SAVE_DELAY_MS, maxWait = SAVE_MAX_WAIT_MS) {
  return Math.min(delay, Math.max(0, since + maxWait - now));
}

export function fitsKeepalive(text: string) {
  return new TextEncoder().encode(text).length < KEEPALIVE_LIMIT_BYTES;
}

export function heldIsStale(held: { at: number; draft: { id: string } }, serverSavedAt: string | null | undefined) {
  if (!held.draft.id || typeof serverSavedAt !== "string") return false;
  const saved = Date.parse(serverSavedAt);
  return Number.isFinite(saved) && saved >= held.at;
}

export function sameAccounts(left: ComposeAccount[], right: ComposeAccount[]) {
  return left.length === right.length && left.every((item, index) => JSON.stringify(item) === JSON.stringify(right[index]));
}
