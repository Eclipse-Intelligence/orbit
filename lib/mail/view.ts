import type { LaterOption } from "@/lib/mail/later";
import type { MailAddress, MailRole } from "@/lib/mail/types";

const MAIL_ROLES = ["inbox", "snoozed", "sent", "drafts", "archive", "trash", "junk"] as const;
export type MailViewRole = (typeof MAIL_ROLES)[number];
export const MAIL_SPLITS = ["important", "other", "news", "calendar"] as const;
export type MailSplit = (typeof MAIL_SPLITS)[number];
export const SPLIT_LABELS: Record<MailSplit, string> = { important: "Important", other: "Other", news: "News", calendar: "Calendar" };

export type MailView = { role: MailViewRole; split?: MailSplit | null } | { folderId: string };

export type ThreadSummary = {
  key: string;
  sourceId: string;
  account: string;
  latestId: string;
  subject: string | null;
  snippet: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  count: number;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  draft: boolean;
  latestAt: string | null;
  reads: { count: number; last: string | null } | null;
  reminder: { kind: "snooze" | "follow_up"; at: string } | null;
  snoozedUntil: string | null;
  split: MailSplit | null;
  prepared: boolean;
  followUpAt?: string | null;
};

export type PreparedReply = { id: string; kind: "reply" | "nudge"; messageId: string; body: string; times: string[] | null };

export type FollowUpReminder = {
  id: string;
  at: string;
  automatic: boolean;
  action?: "remind" | "send";
  body?: string | null;
  to?: MailAddress[];
};

export type FollowUpReplied = { name: string; messageId: string };

export type DeferredFollowUp = { id: string; messageId: string; at: string; taskId: string | null; options: LaterOption[] };

export type ThreadMessage = {
  id: string;
  folderRole: MailRole;
  folder: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  at: string | null;
  isRead: boolean;
  isDraft: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  snippet: string | null;
  html: string | null;
  rich: boolean;
  text: string | null;
  webLink: string | null;
  opens: { at: string; agent: string | null }[] | null;
};

export type ThreadPerson = {
  email: string;
  name: string | null;
  contactId: string | null;
  title: string | null;
  companyId: string | null;
  companyName: string | null;
  dealId: string | null;
  dealName: string | null;
  dealStage: string | null;
  elsewhere?: WorkspaceChoiceRef[];
};

export type WorkspaceChoiceRef = { id: string; name: string };

export type ThreadFiling = {
  active: WorkspaceChoiceRef;
  workspaces: WorkspaceChoiceRef[];
  filedIn: string[];
  chosen: boolean;
  domain: string | null;
  rule: string[] | null;
};

export type SubscriptionStatus = "subscribed" | "kept" | "unsubscribed" | "ignored" | "research" | "blocked";

export const SUBSCRIPTION_LABELS: Record<SubscriptionStatus, string> = {
  subscribed: "Subscribed",
  kept: "Subscribed",
  unsubscribed: "Unsubscribed",
  ignored: "Ignored your unsubscribe",
  research: "Research",
  blocked: "Blocked",
};

export type ExistingMailChoice = "archive" | "trash" | "leave";

export type UnsubscribeMethod = "one_click" | "mailto" | "page" | "none";

export type UnsubscribeOutcome = "unsubscribed" | "requested" | "needs_you" | "failed" | "none";

export const OUTCOME_LABELS: Record<UnsubscribeOutcome, string> = {
  unsubscribed: "Unsubscribed",
  requested: "Requested",
  needs_you: "Needs you",
  failed: "Didn't work",
  none: "No unsubscribe link",
};

export type SenderProtection = { kind: "contact" | "company"; id: string; name: string; href: string; reason: string };

export type ThreadSubscription = { sender: string; status: SubscriptionStatus; ignoredAt: string | null; unsubscribedAt: string | null; coldPitch: boolean };

export type SubscriptionSender = {
  sender: string;
  name: string | null;
  emails: number;
  opened: number;
  lastAt: string | null;
  status: SubscriptionStatus;
  unsubscribedAt: string | null;
  method: UnsubscribeMethod | null;
  ignoredAt: string | null;
  coldPitch: boolean;
  protection: SenderProtection | null;
  suggest: boolean;
};

export type UnsubscribePreview = {
  sender: string;
  name: string | null;
  method: UnsubscribeMethod;
  target: string | null;
  pageUrl: string | null;
  mailto: string | null;
  account: string;
  protection: SenderProtection | null;
  status: SubscriptionStatus;
  existing: { inbox: number; total: number };
};

export type UnsubscribeResult = {
  sender: string;
  method: UnsubscribeMethod;
  outcome: UnsubscribeOutcome;
  url: string | null;
  detail: string | null;
  moveError: string | null;
  moved: number;
  remaining: number;
  status: SubscriptionStatus;
};

export type ThreadDetail = {
  key: string;
  account: string;
  subject: string | null;
  people: ThreadPerson[];
  messages: ThreadMessage[];
  drafts: MailDraft[];
  prepared: PreparedReply | null;
  followUp: FollowUpReminder | null;
  followUpReplied?: FollowUpReplied | null;
  deferral?: DeferredFollowUp | null;
  subscription?: ThreadSubscription | null;
  filing?: ThreadFiling | null;
};

export type ComposeAccount = { id: string; email: string; signature: string | null; sourceId?: string; identityId?: string; default?: boolean };

export type DraftMode = "new" | "reply" | "reply_all" | "forward";

export type ComposeIntent = "reply" | "prepared";

export function threadHref(key: string, compose?: ComposeIntent) {
  return `/mail?thread=${encodeURIComponent(key)}${compose ? `&compose=${compose}` : ""}`;
}

export type DraftFile = { id: string; name: string; size: number; contentType: string };

export type MailDraft = {
  id: string;
  sourceId: string;
  mode: DraftMode;
  messageId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  savedAt: string;
  sendAt: string | null;
  sendError: string | null;
  identityId?: string | null;
  attachments?: DraftFile[];
  remindHours?: number | null;
  followUpDays?: number | null;
  followUpBody?: string | null;
};

function mine(address: MailAddress | null | undefined, own: Set<string>) {
  return Boolean(address && own.has(address.address.toLowerCase()));
}

function unique(list: MailAddress[]) {
  const seen = new Set<string>();
  return list.filter((item) => {
    const key = item.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function replyDefaults(
  mode: DraftMode,
  message: { from: MailAddress | null; to: MailAddress[]; cc: MailAddress[] },
  subject: string | null,
  ownAddresses: string[],
) {
  const own = new Set(ownAddresses.map((item) => item.toLowerCase()));
  const base = (subject ?? "").trim();
  if (mode === "forward" || mode === "new") {
    return { to: [] as MailAddress[], cc: [] as MailAddress[], subject: /^(fw|fwd):/i.test(base) ? base : `FW: ${base}` };
  }
  const fromMe = mine(message.from, own);
  const others = (list: MailAddress[]) => list.filter((item) => !mine(item, own));
  const to = fromMe ? unique(message.to) : unique([message.from!, ...(mode === "reply_all" ? others(message.to) : [])]);
  const cc = mode === "reply_all" ? unique(others(message.cc)).filter((item) => !to.some((entry) => entry.address === item.address)) : [];
  return { to, cc, subject: /^re:/i.test(base) ? base : `RE: ${base}` };
}

export type MailNav = {
  accounts: { id: string; email: string; unread: number; connected: boolean }[];
  folders: { id: string; sourceId: string; name: string; role: MailRole; unread: number }[];
  unread: number;
  snoozed: number;
  scheduled: number;
  splits: { sourceId: string; split: MailSplit; total: number; unread: number }[];
};

export type ThreadCursor = { at: string; key: string };

export function readMailView(value: string | null | undefined): MailView {
  if (value?.startsWith("folder:")) return { folderId: value.slice(7) };
  if (value?.startsWith("inbox:")) {
    const split = MAIL_SPLITS.find((item) => item === value.slice(6));
    return { role: "inbox", split: split ?? null };
  }
  const role = MAIL_ROLES.find((item) => item === value);
  return { role: role ?? "inbox" };
}

export function mailViewParam(view: MailView) {
  if ("folderId" in view) return `folder:${view.folderId}`;
  return view.role === "inbox" && view.split ? `inbox:${view.split}` : view.role;
}

export function readThreadCursor(value: string | null | undefined): ThreadCursor | null {
  if (!value) return null;
  const split = value.indexOf("~");
  if (split <= 0) return null;
  const at = value.slice(0, split);
  if (Number.isNaN(Date.parse(at))) return null;
  return { at, key: value.slice(split + 1) };
}
