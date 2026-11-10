import type { ComposeAccount } from "@/lib/mail/view";

export type MailboxKind = "main" | "account";

export type RemovalImpact = { emails: number; addresses: string[] };

export type ReconnectTarget = { sourceId: string | null; email: string | null; href: string | null };

export const RECONNECT_NEEDED = "reconnect_needed";

const RECONNECT_TEXT = /\breconnect\b|connect it again|signed Orbit out|rejected the mailbox connection|isn't connected to Orbit any more/i;

export function needsReconnecting(message: string | null | undefined) {
  return Boolean(message && RECONNECT_TEXT.test(message));
}

export function reconnectHref(kind: MailboxKind, email: string, back: "email" | "calendars" = "email") {
  const params = new URLSearchParams();
  if (kind === "account") params.set("purpose", "send_account");
  params.set("hint", email);
  if (kind === "account") params.set("from", back);
  return `/api/microsoft/connect?${params.toString()}`;
}

export function addAccountHref(email?: string | null) {
  const params = new URLSearchParams({ purpose: "send_account", from: "email" });
  if (email) params.set("hint", email);
  return `/api/microsoft/connect?${params.toString()}`;
}

function count(value: number) {
  return new Intl.NumberFormat("en-GB").format(value);
}

function list(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function removalText(impact: RemovalImpact | null, options: { calendars?: boolean } = {}) {
  const parts: string[] = [];
  if (impact && impact.emails > 0) parts.push(`its copy of ${count(impact.emails)} ${impact.emails === 1 ? "email" : "emails"}`);
  else if (impact) parts.push("its copy of this mailbox");
  if (options.calendars !== false) parts.push("its calendars");
  if (impact && impact.addresses.length > 0) {
    parts.push(`${impact.addresses.length === 1 ? "the sending address" : "the sending addresses"} ${list(impact.addresses)}`);
  }
  return `Orbit deletes ${list(parts)}. Nothing changes in Outlook.`;
}

export function fromFallback(accounts: ComposeAccount[], sourceId: string | null) {
  const sameSource = sourceId ? accounts.find((item) => !item.identityId && item.id === sourceId) : null;
  return sameSource ?? accounts.find((item) => item.default) ?? accounts.find((item) => !item.identityId) ?? accounts[0] ?? null;
}
