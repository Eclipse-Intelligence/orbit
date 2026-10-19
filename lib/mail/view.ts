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
  reads: { count: number; last: string | null } | null;
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
  opens: { at: string; agent: string | null }[] | null;
};

export type ThreadDetail = {
  key: string;
  account: string;
  subject: string | null;
  messages: ThreadMessage[];
  drafts: MailDraft[];
};

export type ComposeAccount = { id: string; email: string; signature: string | null };

export type DraftMode = "new" | "reply" | "reply_all" | "forward";

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
