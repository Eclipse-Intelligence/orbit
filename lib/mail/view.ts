import type { MailAddress, MailRole } from "@/lib/mail/types";

export const MAIL_ROLES = ["inbox", "sent", "drafts", "archive", "trash"] as const;
export type MailViewRole = (typeof MAIL_ROLES)[number];
export type MailView = { role: MailViewRole } | { folderId: string };

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
};

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
};

export type ThreadDetail = { key: string; account: string; subject: string | null; messages: ThreadMessage[] };

export type MailNav = {
  accounts: { id: string; email: string; unread: number }[];
  folders: { id: string; sourceId: string; name: string; role: MailRole; unread: number }[];
  unread: number;
};

export type ThreadCursor = { at: string; key: string };

export function readMailView(value: string | null | undefined): MailView {
  if (value?.startsWith("folder:")) return { folderId: value.slice(7) };
  const role = MAIL_ROLES.find((item) => item === value);
  return { role: role ?? "inbox" };
}

export function mailViewParam(view: MailView) {
  return "folderId" in view ? `folder:${view.folderId}` : view.role;
}

export function readThreadCursor(value: string | null | undefined): ThreadCursor | null {
  if (!value) return null;
  const split = value.indexOf("~");
  if (split <= 0) return null;
  const at = value.slice(0, split);
  if (Number.isNaN(Date.parse(at))) return null;
  return { at, key: value.slice(split + 1) };
}
