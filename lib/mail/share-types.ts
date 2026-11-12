import type { ChatNeedsShare, ChatPerson } from "@/lib/chat/types";
import type { MailAddress } from "@/lib/mail/types";

export const SHARED_PARAM = "shared";
export const SHARE_NOTES_PARAM = "discussion";
export const SHARE_PEOPLE_MAX = 50;

export type MailSharePerson = ChatPerson & { email: string | null; owner: boolean; addedAt: string };

export type SharedThreadSummary = {
  shareId: string;
  owner: ChatPerson;
  sharedAt: string;
  subject: string | null;
  snippet: string | null;
  latestAt: string | null;
  counterpart: MailAddress | null;
  count: number;
  hasAttachments: boolean;
};

export type SharedMessage = {
  id: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  at: string | null;
  hasAttachments: boolean;
  snippet: string | null;
  html: string | null;
  rich: boolean;
  text: string | null;
  truncated: boolean;
};

export type SharedDraftState = "editing" | "sending" | "scheduled" | "failed" | "sent" | "discarded" | "none";

export type SharedDraftFile = { id: string; name: string; size: number; contentType: string };

export type SharedDraft = {
  shareId: string;
  owner: ChatPerson;
  viewerIsOwner: boolean;
  state: SharedDraftState;
  mode: "new" | "reply" | "reply_all" | "forward" | null;
  from: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  body: string;
  signature: string | null;
  attachments: SharedDraftFile[];
  sendAt: string | null;
  version: number;
  savedAt: string | null;
};

export type SharedDraftSummary = { state: SharedDraftState; subject: string | null; snippet: string | null };

export type SharedThread = {
  shareId: string;
  owner: ChatPerson;
  viewerIsOwner: boolean;
  threadKey: string | null;
  subject: string | null;
  people: MailSharePerson[];
  messages: SharedMessage[];
  draft: SharedDraftSummary | null;
};

export const SHARED_DRAFT_OPEN: readonly SharedDraftState[] = ["editing", "sending", "scheduled", "failed"];

export const SHARED_DRAFT_CLOSED: readonly SharedDraftState[] = ["sent", "discarded"];

export type MailShareCandidate = ChatPerson & { email: string | null; role: "owner" | "admin" | "member" | null };

export type MailSharePeople = {
  shareId: string | null;
  people: MailSharePerson[];
};

export type MailShareControl = MailSharePeople & {
  candidates: MailShareCandidate[];
};

export type MailShareLiveEvent =
  | { type: "message"; shareId: string }
  | { type: "shared"; shareId: string }
  | { type: "people"; shareId: string }
  | { type: "removed"; shareId: string }
  | { type: "draft"; shareId: string };

export const MAIL_SHARE_EVENT_TYPES: readonly MailShareLiveEvent["type"][] = ["message", "shared", "people", "removed", "draft"];

export type NeedsShare = ChatNeedsShare;

export type MailShareResult<T> = ({ ok: true } & T) | { ok?: false; error: string };

export function sharedThreadHref(shareId: string, options: { notes?: boolean } = {}) {
  return `/mail?${SHARED_PARAM}=${shareId}${options.notes ? `&${SHARE_NOTES_PARAM}=1` : ""}`;
}
