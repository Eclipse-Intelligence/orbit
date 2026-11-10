import { needsReconnecting, type ReconnectTarget } from "@/lib/mail/mailboxes";
import type { MailNav } from "@/lib/mail/view";

export type ReconnectFlag = { sourceId: string | null; email: string | null; href: string | null };

export type ReconnectSnapshot = { flags: ReconnectFlag[]; hosts: number };

export type ReconnectAccount = { key: string; email: string; href: string | null };

let snapshot: ReconnectSnapshot = { flags: [], hosts: 0 };
const listeners = new Set<() => void>();

function publish(next: ReconnectSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeReconnects(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readReconnects() {
  return snapshot;
}

export const NO_RECONNECTS: ReconnectSnapshot = { flags: [], hosts: 0 };

export function clearReconnects() {
  publish({ ...snapshot, flags: [] });
}

export function addReconnectHost() {
  publish({ ...snapshot, hosts: snapshot.hosts + 1 });
  return () => publish({ ...snapshot, hosts: Math.max(0, snapshot.hosts - 1) });
}

export function reconnectOf(error: unknown): ReconnectTarget | null {
  if (!error || typeof error !== "object" || !("reconnect" in error)) return null;
  const value = (error as { reconnect?: unknown }).reconnect;
  if (!value || typeof value !== "object") return null;
  const target = value as Partial<ReconnectTarget>;
  return {
    sourceId: typeof target.sourceId === "string" ? target.sourceId : null,
    email: typeof target.email === "string" ? target.email : null,
    href: typeof target.href === "string" ? target.href : null,
  };
}

export function sameAccount(left: ReconnectFlag, right: ReconnectFlag) {
  return Boolean((left.sourceId && left.sourceId === right.sourceId) || (left.email && left.email.toLowerCase() === right.email?.toLowerCase()));
}

export function flagReconnect(error: unknown, fallback: { sourceId?: string | null; email?: string | null } = {}) {
  const target = reconnectOf(error);
  if (!target) return false;
  const flag: ReconnectFlag = { sourceId: target.sourceId ?? fallback.sourceId ?? null, email: target.email ?? fallback.email ?? null, href: target.href };
  if (!flag.sourceId && !flag.email) return true;
  const existing = snapshot.flags.find((item) => sameAccount(item, flag));
  if (existing && (existing.href || !flag.href)) return true;
  publish({ ...snapshot, flags: [...snapshot.flags.filter((item) => item !== existing), flag] });
  return true;
}

export function flagSyncProblems(problems: string[], accounts: MailNav["accounts"]) {
  const others: string[] = [];
  for (const problem of problems) {
    const account = needsReconnecting(problem) ? accounts.find((item) => problem.includes(item.email)) : null;
    if (account) flagReconnect({ reconnect: { sourceId: account.id, email: account.email, href: account.reconnectHref ?? null } });
    else others.push(problem);
  }
  return others;
}

export function reconnectAccounts(accounts: MailNav["accounts"], flags: ReconnectFlag[]): ReconnectAccount[] {
  const listed: ReconnectAccount[] = [];
  for (const account of accounts) {
    const flagged = flags.find((flag) => sameAccount(flag, { sourceId: account.id, email: account.email, href: null }));
    if (account.needsReconnect || !account.connected || flagged) {
      listed.push({ key: account.id, email: account.email, href: account.reconnectHref ?? flagged?.href ?? null });
    }
  }
  for (const flag of flags) {
    if (!flag.email || listed.some((item) => sameAccount({ sourceId: item.key, email: item.email, href: null }, flag))) continue;
    listed.push({ key: flag.sourceId ?? flag.email, email: flag.email, href: flag.href });
  }
  return listed;
}
