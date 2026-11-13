"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import RemoveAccountButton from "@/components/crm/remove-account-button";
import { SettingsCard } from "@/components/crm/settings-ui";
import {
  addCalendarFeedAction,
  disconnectCalendarAccountAction,
  setCalendarForCrmAction,
  setCalendarVisibleAction,
  syncCalendarsAction,
} from "@/app/(crm)/calendar/actions";
import { formatWhen } from "@/lib/companies";
import type { CalendarEntry, CalendarGroup } from "@/lib/crm/calendars";
import { GENERIC_ERROR } from "@/lib/utils";
import LockIcon from "@/public/assets/images/mail/lock.svg";
import AlertIcon from "@/public/assets/images/companies/sidebar/alert-triangle.svg";

const CONNECT_ACCOUNT = "/api/microsoft/connect?purpose=calendar_account";

type Overrides = Record<string, Partial<Pick<CalendarEntry, "isVisible" | "useForCrm">>>;

function reconnectHref(group: CalendarGroup) {
  if (group.kind === "primary") return `/api/microsoft/connect?hint=${encodeURIComponent(group.email ?? "")}`;
  if (group.canSend) return `/api/microsoft/connect?purpose=send_account&hint=${encodeURIComponent(group.email ?? "")}`;
  return `${CONNECT_ACCOUNT}&hint=${encodeURIComponent(group.email ?? "")}`;
}

function needsReconnect(group: CalendarGroup) {
  if (group.provider !== "microsoft") return false;
  return !group.connected || group.scopeMissing || /connect it again|reconnect/i.test(group.lastError ?? "");
}

function sourceLine(group: CalendarGroup) {
  if (group.kind === "primary") return group.taskBlocks === "orbit" ? "Main account · Read only" : "Main account";
  if (group.provider === "ics") return "Calendar link · read-only";
  if (group.canSend) return group.canInvite ? "Calendar, mail and invites" : "Calendar and mail";
  return "Calendar only";
}

function allowSendingHref(group: CalendarGroup) {
  return `/api/microsoft/connect?purpose=send_account&hint=${encodeURIComponent(group.email ?? "")}`;
}

function groupName(group: CalendarGroup) {
  return group.displayName ? `${group.displayName} · ${group.label}` : group.label;
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
  const [adding, setAdding] = useState(false);
  const [feedUrl, setFeedUrl] = useState("");
  const [feedName, setFeedName] = useState("");
  const [feedError, setFeedError] = useState<string | null>(null);
  const primary = groups.find((group) => group.kind === "primary") ?? null;

  async function toggle(calendar: CalendarEntry, field: "isVisible" | "useForCrm", value: boolean) {
    setError(null);
    setMessage(null);
    setOverrides((current) => ({ ...current, [calendar.id]: { ...current[calendar.id], [field]: value } }));
    const result =
      field === "isVisible"
        ? await setCalendarVisibleAction(calendar.id, value).catch(() => ({ error: GENERIC_ERROR }))
        : await setCalendarForCrmAction(calendar.id, value).catch(() => ({ error: GENERIC_ERROR }));
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
    const result = await disconnectCalendarAccountAction(group.id).catch(() => ({ error: GENERIC_ERROR }));
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMessage(`Removed ${groupName(group)}.`);
    router.refresh();
  }

  async function addFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !feedUrl.trim()) return;
    setPending("feed");
    setFeedError(null);
    setError(null);
    setMessage(null);
    const result = await addCalendarFeedAction(feedUrl, feedName).catch(() => ({ error: GENERIC_ERROR, message: undefined }));
    setPending(null);
    if (result.error) {
      setFeedError(result.error);
      return;
    }
    setFeedUrl("");
    setFeedName("");
    setAdding(false);
    setMessage(result.message ?? "Calendar added.");
    router.refresh();
  }

  async function syncNow() {
    if (pending) return;
    setPending("sync");
    setError(null);
    setMessage(null);
    const result = await syncCalendarsAction().catch(() => ({ error: GENERIC_ERROR, message: undefined }));
    setPending(null);
    if (result.error) setError(result.error);
    else setMessage(result.message ?? "Calendars synced.");
    router.refresh();
  }

  return (
    <SettingsCard
      id="calendars"
      title="Your calendars"
      description="Only calendars marked Use for CRM feed Meetings and People you’ve met."
    >
      {connectedEmail && (
        <p role="status" className="caption-style text-soft">
          Connected {connectedEmail}.
        </p>
      )}
      {connectError && (
        <p role="alert" className="caption-style text-danger">
          {connectError}
        </p>
      )}
      {!primary && configured && (
        <p className="caption-style text-subtle">
          Connect Microsoft in{" "}
          <Button variant="link" size="none" href="/settings/email">
            Settings › Email
          </Button>{" "}
          for your main calendar.
        </p>
      )}
      {groups.map((group) => (
        <section
          key={`${group.kind}-${group.id}`}
          aria-label={groupName(group)}
          className="border-border flex flex-col gap-3 rounded-lg border p-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[14px] leading-5 [overflow-wrap:anywhere]" title={groupName(group)}>
                {groupName(group)}
              </span>
              <span className="caption-style text-subtle">
                {sourceLine(group)} · {statusLine(group)}
              </span>
              {group.lastError && !group.scopeMissing && (
                <span className="caption-style text-danger">{group.lastError}</span>
              )}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              {configured && needsReconnect(group) && (
                <a href={reconnectHref(group)} aria-label={`Reconnect ${group.email ?? groupName(group)}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  Reconnect
                </a>
              )}
              {configured && group.kind === "account" && group.provider === "microsoft" && group.connected && !group.canSend && (
                <a
                  href={allowSendingHref(group)}
                  className={buttonVariants({ variant: "secondary", size: "sm" })}
                  title={`Let Orbit read and send email for ${group.email ?? "this account"}`}
                >
                  Add mail
                </a>
              )}
              {configured && group.kind === "account" && group.provider === "microsoft" && group.connected && group.canSend && !group.canInvite && (
                <a
                  href={allowSendingHref(group)}
                  className={buttonVariants({ variant: "secondary", size: "sm" })}
                  title={`Let Orbit send meeting invites from ${group.email ?? "this account"}`}
                >
                  Allow invites
                </a>
              )}
              {group.kind === "account" && group.provider === "microsoft" && (
                <RemoveAccountButton
                  accountId={group.id}
                  email={group.email ?? groupName(group)}
                  removes={group.removes}
                  disabled={pending !== null}
                  onDone={(result) => {
                    setError(result.error ?? null);
                    setMessage(result.message ?? null);
                  }}
                />
              )}
              {group.kind === "account" && group.provider === "ics" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  aria-label={`Remove ${groupName(group)}`}
                  onClick={() => disconnect(group)}
                >
                  {pending === group.id ? "Removing…" : "Remove"}
                </Button>
              )}
            </span>
          </div>
          {group.taskBlocks === "outlook" && (
            <p className="caption-style text-soft flex items-center gap-2">
              <LockIcon aria-hidden className="text-violet size-3 shrink-0" />
              Task blocks go to your Outlook calendar as Busy, Private.
            </p>
          )}
          {group.taskBlocks === "orbit" && (
            <div role="status" className="bg-warning/10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2">
              <AlertIcon aria-hidden className="text-warning size-3.5 shrink-0" />
              <span className="caption-style text-warning min-w-0 flex-1">Task blocks show in Orbit only.</span>
              {configured && (
                <a href={reconnectHref(group)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  Reconnect to put task blocks in Outlook
                </a>
              )}
            </div>
          )}
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
      {adding && (
        <form onSubmit={addFeed} className="border-border flex flex-col gap-3 rounded-lg border p-3">
          <label className="flex flex-col gap-2" htmlFor="calendar-feed-url">
            <span className="caption-style text-subtle">Secret iCal link</span>
            <Input
              id="calendar-feed-url"
              value={feedUrl}
              onChange={(event) => setFeedUrl(event.target.value)}
              placeholder="https://… or webcal://…"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={feedError ? true : undefined}
              aria-describedby="calendar-feed-help"
            />
          </label>
          <label className="flex flex-col gap-2" htmlFor="calendar-feed-name">
            <span className="caption-style text-subtle">Name (optional)</span>
            <Input
              id="calendar-feed-name"
              value={feedName}
              onChange={(event) => setFeedName(event.target.value)}
              placeholder="Uses the calendar's own name"
              maxLength={200}
              autoComplete="off"
            />
          </label>
          <ul id="calendar-feed-help" className="caption-style text-subtle flex list-disc flex-col gap-1 pl-4">
            <li>
              Google Calendar: Settings › Settings for my calendars › your calendar › Integrate calendar › Secret
              address in iCal format.
            </li>
            <li>iCloud: icloud.com/calendar › the calendar&apos;s info button › Public Calendar › Copy.</li>
            <li>
              Read-only. Google&apos;s link can lag a few hours.
            </li>
          </ul>
          {feedError && (
            <p role="alert" className="caption-style text-danger">
              {feedError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" type="submit" disabled={pending !== null || !feedUrl.trim()}>
              {pending === "feed" ? "Adding…" : "Add calendar"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending === "feed"}
              onClick={() => {
                setAdding(false);
                setFeedError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {configured && (
          <a href={CONNECT_ACCOUNT} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Add Microsoft account
          </a>
        )}
        {!adding && (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Add calendar by link
          </Button>
        )}
        {groups.length > 0 && (
          <Button variant="ghost" size="sm" disabled={pending !== null} onClick={syncNow}>
            {pending === "sync" ? "Syncing…" : "Sync now"}
          </Button>
        )}
        <p role="status" className="caption-style text-subtle">
          {message}
        </p>
      </div>
    </SettingsCard>
  );
}
