"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import {
  addCalendarFeedAction,
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
  return `${CONNECT_ACCOUNT}&hint=${encodeURIComponent(group.email ?? "")}`;
}

function needsReconnect(group: CalendarGroup) {
  if (group.provider !== "microsoft") return false;
  return !group.connected || group.scopeMissing || /connect it again|reconnect/i.test(group.lastError ?? "");
}

function sourceLine(group: CalendarGroup) {
  if (group.kind === "primary") return "Main account · from Inbox · sends email";
  if (group.provider === "ics") return "Calendar link · read-only";
  return group.canSend ? "Calendar · sends email" : "Calendar only";
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
    setMessage(`${group.provider === "ics" ? "Removed" : "Disconnected"} ${groupName(group)}.`);
    router.refresh();
  }

  async function addFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !feedUrl.trim()) return;
    setPending("feed");
    setFeedError(null);
    setError(null);
    setMessage(null);
    const result = await addCalendarFeedAction(feedUrl, feedName);
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
    const result = await syncCalendarsAction();
    setPending(null);
    if (result.error) setError(result.error);
    else setMessage(result.message ?? "Calendars synced.");
    router.refresh();
  }

  return (
    <SettingsCard
      id="calendars"
      title="Your calendars"
      description="Show any calendar on the Calendar page. Meetings cards and People you’ve met only use calendars marked Use for CRM."
    >
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
      {!primary && configured && (
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
          aria-label={groupName(group)}
          className="border-border flex flex-col gap-3 rounded-lg border p-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className="truncate text-[14px] leading-5">{groupName(group)}</span>
              <span className="caption-style text-subtle">
                {sourceLine(group)} · {statusLine(group)}
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
              {configured && group.kind === "account" && group.provider === "microsoft" && group.connected && !group.canSend && (
                <a
                  href={allowSendingHref(group)}
                  className={buttonVariants({ variant: "secondary", size: "sm" })}
                  title={`Let Orbit send email from ${group.email ?? "this account"}`}
                >
                  Allow sending
                </a>
              )}
              {group.kind === "account" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  aria-label={`${group.provider === "ics" ? "Remove" : "Disconnect"} ${groupName(group)}`}
                  onClick={() => disconnect(group)}
                >
                  {group.provider === "ics"
                    ? pending === group.id
                      ? "Removing…"
                      : "Remove"
                    : pending === group.id
                      ? "Disconnecting…"
                      : "Disconnect"}
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
              Read-only. Google&apos;s link can lag a few hours behind. Orbit keeps the link encrypted and only shows
              its host.
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
            Connect another Microsoft account
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
      {configured && (
        <SettingsDisclosure
          title="Connecting other Microsoft accounts"
          summary="Accounts outside your organisation need the app registration to allow them."
        >
          <p className="caption-style text-subtle leading-[1.4]">
            Accounts from other organisations or personal Microsoft accounts need Orbit&apos;s app registration to allow
            them (Entra › Supported account types).
          </p>
        </SettingsDisclosure>
      )}
    </SettingsCard>
  );
}
