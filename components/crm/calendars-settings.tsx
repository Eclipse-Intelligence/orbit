"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import {
  disconnectCalendarAccountAction,
  setCalendarForCrmAction,
  setCalendarVisibleAction,
  syncCalendarsAction,
} from "@/app/(crm)/calendar/actions";
import { formatWhen } from "@/lib/companies";
import type { CalendarEntry, CalendarGroup } from "@/lib/crm/calendars";

const CONNECT_ACCOUNT = "/api/microsoft/connect?purpose=calendar_account";

type Overrides = Record<string, Partial<Pick<CalendarEntry, "isVisible" | "useForCrm">>>;

function reconnectHref(group: CalendarGroup) {
  if (group.kind === "primary") return "/api/microsoft/connect";
  return `${CONNECT_ACCOUNT}&hint=${encodeURIComponent(group.email)}`;
}

function needsReconnect(group: CalendarGroup) {
  return !group.connected || group.scopeMissing || /connect it again|reconnect/i.test(group.lastError ?? "");
}

function statusLine(group: CalendarGroup) {
  if (!group.connected) return "Disconnected";
  if (group.scopeMissing) return "Microsoft hasn't allowed calendar access yet";
  return group.lastSyncedAt ? `Last synced ${formatWhen(group.lastSyncedAt)}` : "Not synced yet";
}

export default function CalendarsSettings({
  groups,
  configured,
  connectedEmail,
  connectError,
}: {
  groups: CalendarGroup[];
  configured: boolean;
  connectedEmail: string | null;
  connectError: string | null;
}) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Overrides>({});
  const [source, setSource] = useState(groups);
  if (source !== groups) {
    setSource(groups);
    setOverrides({});
  }
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const primary = groups.find((group) => group.kind === "primary") ?? null;

  async function toggle(calendar: CalendarEntry, field: "isVisible" | "useForCrm", value: boolean) {
    setError(null);
    setMessage(null);
    setOverrides((current) => ({ ...current, [calendar.id]: { ...current[calendar.id], [field]: value } }));
    const result =
      field === "isVisible"
        ? await setCalendarVisibleAction(calendar.id, value)
        : await setCalendarForCrmAction(calendar.id, value);
    if (result.error) {
      setError(result.error);
      setOverrides((current) => ({ ...current, [calendar.id]: { ...current[calendar.id], [field]: !value } }));
      return;
    }
    router.refresh();
  }

  async function disconnect(group: CalendarGroup) {
    if (pending) return;
    setPending(group.id);
    setError(null);
    setMessage(null);
    const result = await disconnectCalendarAccountAction(group.id);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMessage(`Disconnected ${group.email}.`);
    router.refresh();
  }

  async function syncNow() {
    if (pending) return;
    setPending("sync");
    setError(null);
    setMessage(null);
    const result = await syncCalendarsAction();
    setPending(null);
    if (result.error) setError(result.error);
    else setMessage(result.message ?? "Calendars synced.");
    router.refresh();
  }

  return (
    <div id="calendars" className="flex max-w-[640px] scroll-mt-4 flex-col gap-3">
      <h2>Calendars</h2>
      <p className="caption-style text-subtle">
        Show any calendar on the Calendar page. Meetings cards and People you&apos;ve met only use calendars marked Use for
        CRM.
      </p>
      {connectedEmail && (
        <p role="status" className="caption-style text-soft">
          Connected {connectedEmail}. Its calendars appear here in a moment.
        </p>
      )}
      {connectError && (
        <p role="alert" className="caption-style text-danger">
          {connectError}
        </p>
      )}
      {!primary && (
        <p className="caption-style text-subtle">
          Your main calendar comes from the Microsoft account connected in{" "}
          <Button variant="link" size="none" href="/inbox">
            Inbox
          </Button>
          .
        </p>
      )}
      {groups.map((group) => (
        <section
          key={`${group.kind}-${group.id}`}
          aria-label={group.email}
          className="border-border flex flex-col gap-3 rounded-xl border p-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className="truncate text-[14px] leading-5">
                {group.displayName ? `${group.displayName} · ` : ""}
                {group.email}
              </span>
              <span className="caption-style text-subtle">
                {group.kind === "primary" ? "Main account · from Inbox" : "Calendar only"} · {statusLine(group)}
              </span>
              {group.lastError && !group.scopeMissing && (
                <span className="caption-style text-danger">{group.lastError}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {configured && needsReconnect(group) && (
                <a href={reconnectHref(group)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  Reconnect
                </a>
              )}
              {group.kind === "account" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  aria-label={`Disconnect ${group.email}`}
                  onClick={() => disconnect(group)}
                >
                  {pending === group.id ? "Disconnecting…" : "Disconnect"}
                </Button>
              )}
            </span>
          </div>
          {group.calendars.length === 0 ? (
            <p className="caption-style text-subtle">No calendars synced yet.</p>
          ) : (
            <ul className="flex flex-col">
              {group.calendars.map((calendar) => {
                const visible = overrides[calendar.id]?.isVisible ?? calendar.isVisible;
                const forCrm = overrides[calendar.id]?.useForCrm ?? calendar.useForCrm;
                return (
                  <li
                    key={calendar.id}
                    className="border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t py-2.5"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: calendar.color }}
                      />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="truncate text-[14px] leading-5">
                          {calendar.name}
                          {calendar.isDefault && <span className="text-subtle"> · Default</span>}
                        </span>
                        {calendar.ownerEmail && calendar.ownerEmail !== group.email && (
                          <span className="caption-style text-subtle truncate">Shared by {calendar.ownerEmail}</span>
                        )}
                        {calendar.lastError && (
                          <span className="caption-style text-danger">{calendar.lastError}</span>
                        )}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-4">
                      <label className="caption-style flex items-center gap-2">
                        <Checkbox
                          checked={visible}
                          aria-label={`Show ${calendar.name} on the Calendar page`}
                          onCheckedChange={(checked) => toggle(calendar, "isVisible", checked === true)}
                        />
                        Show
                      </label>
                      <label className="caption-style flex items-center gap-2">
                        <Checkbox
                          checked={forCrm}
                          aria-label={`Use ${calendar.name} for CRM`}
                          onCheckedChange={(checked) => toggle(calendar, "useForCrm", checked === true)}
                        />
                        Use for CRM
                      </label>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {configured ? (
          <a href={CONNECT_ACCOUNT} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Connect another Microsoft account
          </a>
        ) : (
          <p className="caption-style text-subtle">Add the Microsoft app credentials to connect calendars.</p>
        )}
        {groups.length > 0 && configured && (
          <Button variant="ghost" size="sm" disabled={pending !== null} onClick={syncNow}>
            {pending === "sync" ? "Syncing…" : "Sync now"}
          </Button>
        )}
        <p role="status" className="caption-style text-subtle">
          {message}
        </p>
      </div>
      <p className="caption-style text-subtle">
        Accounts from other organisations or personal Microsoft accounts need Orbit&apos;s app registration to allow
        them (Entra › Supported account types).
      </p>
    </div>
  );
}
