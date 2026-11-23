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

export type HoldReason = "reconnect" | "page";

export type HeldOpening = "none" | "kept" | "save" | "reconnect";

export function heldOpening(held: { key?: string | null; reason?: HoldReason | null }, draftId: string | null | undefined): HeldOpening {
  if (!held.key) return "none";
  if (held.reason === "reconnect") return "reconnect";
  return draftId ? "kept" : "save";
}

export function openingSignature(fields: DraftFields, opened: { unsaved?: boolean }) {
  return opened.unsaved ? null : draftSignature(fields);
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

export type StoredDraftContent = {
  sourceId: string;
  identityId: string | null;
  subject: string;
  body: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  remindHours: number | null;
  followUpDays: number | null;
  followUpBody: string | null;
  attachments: string[];
};

type HeldContent = {
  sourceId: string;
  identityId?: string | null;
  subject: string;
  body: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  remindHours?: number | null;
  followUpDays?: number | null;
  followUpBody?: string | null;
  attachments?: { id: string }[];
};

function addresses(list: MailAddress[]) {
  return [...new Set(list.map((item) => item.address.trim().toLowerCase()))].sort().join(",");
}

function contentKey(content: {
  sourceId: string;
  identityId: string | null;
  subject: string;
  body: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  remindHours: number | null;
  followUpDays: number | null;
  followUpBody: string | null;
  attachments: string[];
}) {
  return JSON.stringify([
    content.sourceId,
    content.identityId,
    content.subject.replace(/\s+/g, " ").trim(),
    content.body.replace(/\r\n/g, "\n"),
    addresses(content.to),
    addresses(content.cc),
    addresses(content.bcc),
    content.followUpDays ? null : (content.remindHours ?? null),
    content.followUpDays ?? null,
    content.followUpDays ? (content.followUpBody ?? null) : null,
    [...content.attachments].sort(),
  ]);
}

export function heldIsSaved(held: HeldContent, stored: StoredDraftContent | null | undefined) {
  if (!stored) return false;
  return (
    contentKey({
      sourceId: held.sourceId,
      identityId: held.identityId ?? null,
      subject: held.subject,
      body: held.body,
      to: held.to,
      cc: held.cc,
      bcc: held.bcc,
      remindHours: held.remindHours ?? null,
      followUpDays: held.followUpDays ?? null,
      followUpBody: held.followUpBody ?? null,
      attachments: (held.attachments ?? []).map((file) => file.id),
    }) === contentKey(stored)
  );
}

export function sameAccounts(left: ComposeAccount[], right: ComposeAccount[]) {
  return left.length === right.length && left.every((item, index) => JSON.stringify(item) === JSON.stringify(right[index]));
}
