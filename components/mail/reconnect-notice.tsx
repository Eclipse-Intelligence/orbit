"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { buttonVariants } from "@/components/_ui/button";
import {
  addReconnectHost,
  clearReconnects,
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

function ReconnectLink({ email, href }: { email: string; href: string | null }) {
  return (
    <a
      href={href ?? "/settings/email"}
      target="_blank"
      rel="noopener"
      aria-label={`Reconnect ${email} in a new tab`}
      className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "shrink-0")}
    >
      Reconnect
    </a>
  );
}

function NoticeRow({ email, href }: { email: string; href: string | null }) {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-xl border border-[var(--tag-amber-border)] bg-[var(--tag-amber-bg)] py-2 pr-2 pl-3 text-[13px] leading-5 text-[var(--tag-amber-text)]"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]" title={email}>
        {email} needs reconnecting
      </span>
      <ReconnectLink email={email} href={href} />
    </div>
  );
}

export default function ReconnectNotices({ accounts, className, onReturn }: { accounts: MailNav["accounts"]; className?: string; onReturn?: () => void }) {
  useEffect(() => addReconnectHost(), []);
  const returned = useRef(onReturn);
  useEffect(() => {
    returned.current = onReturn;
  });
  useEffect(() => {
    let away = false;
    const changed = () => {
      if (document.visibilityState === "hidden") {
        away = true;
        return;
      }
      if (!away) return;
      away = false;
      clearReconnects();
      returned.current?.();
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
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

export function ComposerReconnect({ sourceId, email, held = false }: { sourceId: string; email: string | null; held?: boolean }) {
  const { flags, hosts } = useReconnects();
  const flag = flags.find((item) => sameAccount(item, { sourceId, email, href: null }));
  const name = flag?.email ?? email ?? "this account";
  if (held) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-[var(--tag-amber-border)] bg-[var(--tag-amber-bg)] py-2 pr-2 pl-3 text-[13px] leading-5 text-[var(--tag-amber-text)]"
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">Not saved. Reconnect {name} first.</span>
        {hosts === 0 && <ReconnectLink email={name} href={flag?.href ?? null} />}
      </div>
    );
  }
  if (!flag || hosts > 0) return null;
  return <NoticeRow email={name} href={flag.href} />;
}
