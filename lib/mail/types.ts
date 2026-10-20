export type MailRole = "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk" | "outbox" | "snoozed" | "other";

export type MailAddress = { name: string | null; address: string };

export type ProviderFolder = {
  providerId: string;
  parentProviderId: string | null;
  name: string;
  role: MailRole;
  total: number;
  unread: number;
};

export type ProviderMessage = {
  providerId: string;
  partial: boolean;
  internetMessageId: string | null;
  threadKey: string | null;
  subject: string | null;
  snippet: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  bodyTruncated: boolean;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  sentAt: string | null;
  receivedAt: string | null;
  isRead: boolean;
  isDraft: boolean;
  isFlagged: boolean;
  importance: string | null;
  hasAttachments: boolean;
  categories: string[];
  webLink: string | null;
};

export type DeltaPage = {
  messages: ProviderMessage[];
  removed: string[];
  nextLink: string | null;
  deltaLink: string | null;
};

export class MailSyncReset extends Error {}
