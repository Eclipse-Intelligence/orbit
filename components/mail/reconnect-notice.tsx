"use client";

import { useEffect, useSyncExternalStore } from "react";
import Button from "@/components/_ui/button";
import {
  addReconnectHost,
  NO_RECONNECTS,
  readReconnects,
  reconnectAccounts,
  sameAccount,
  subscribeReconnects,
} from "@/components/mail/reconnect-store";
import type { MailNav } from "@/lib/mail/view";
import { cn } from "@/lib/utils";

export { flagReconnect, flagSyncProblems, reconnectOf } from "@/components/mail/reconnect-store";

function useReconnects() {
  return useSyncExternalStore(subscribeReconnects, readReconnects, () => NO_RECONNECTS);
}

function NoticeRow({ email, href }: { email: string; href: string | null }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-xl border border-[var(--tag-amber-border)] bg-[var(--tag-amber-bg)] py-2 pr-2 pl-3 text-[13px] leading-5 text-[var(--tag-amber-text)]"
    >
      <span className="min-w-0 break-words">{email} needs reconnecting</span>
      <Button variant="secondary" size="sm" href={href ?? "/settings/email"} className="shrink-0" aria-label={`Reconnect ${email}`}>
        Reconnect
      </Button>
    </div>
  );
}

export default function ReconnectNotices({ accounts, className }: { accounts: MailNav["accounts"]; className?: string }) {
  useEffect(() => addReconnectHost(), []);
  const { flags } = useReconnects();
  const listed = reconnectAccounts(accounts, flags);
  if (listed.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {listed.map((item) => (
        <NoticeRow key={item.key} email={item.email} href={item.href} />
      ))}
    </div>
  );
}

export function ComposerReconnect({ sourceId, email }: { sourceId: string; email: string | null }) {
  const { flags, hosts } = useReconnects();
  const flag = flags.find((item) => sameAccount(item, { sourceId, email, href: null }));
  if (!flag || hosts > 0) return null;
  return <NoticeRow email={flag.email ?? email ?? "This account"} href={flag.href} />;
}
