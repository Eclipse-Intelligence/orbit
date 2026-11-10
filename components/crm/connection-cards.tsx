import type { ReactNode } from "react";
import Button from "@/components/_ui/button";
import {
  disconnectInboxAction,
  enableGranolaWebhookAction,
  syncCalendarAction,
  syncCallsAction,
  syncGranolaAction,
  syncInboxAction,
  syncTranscriptsAction,
} from "@/app/(crm)/capture/actions";
import MailMirrorProgress from "@/components/crm/mail-mirror-status";
import RemoveAccountButton from "@/components/crm/remove-account-button";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import { formatWhen } from "@/lib/companies";
import type { CalendarStatus } from "@/lib/crm/calendar";
import type { CallSyncSummary } from "@/lib/crm/calls";
import type { GranolaStatus } from "@/lib/crm/granola";
import type { TeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import type { Mailbox } from "@/lib/mail/accounts";
import { addAccountHref } from "@/lib/mail/mailboxes";
import type { MailSourceStatus } from "@/lib/mail/store";
import type { LinearStatus } from "@/lib/linear";
import GranolaKey from "@/components/crm/granola-key";
import type { MailboxSummary } from "@/lib/crm/inbox";
import { ReadwiseSync, ReadwiseToken, ReadwiseWorkspace } from "@/components/crm/readwise-settings";
import type { ReadwiseStatus } from "@/lib/readwise/keys";
import RecallKey from "@/components/crm/recall-settings";
import type { RecallStatus } from "@/lib/recall/keys";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";

const RECALL_TAGS: Record<RecallStatus["tags"], string> = {
  names: "Tags: the assistant can use your Recall tag names.",
  ids: "Tags: Recall's API filters by tag id, not name, and Orbit can't list your tags. An assistant connected to Recall's own MCP can list ids (explore_kb, list_tags).",
  unknown: "Tags: not checked yet. Orbit checks when the assistant first filters by tag.",
};

function syncedLine(lastSyncedAt: string | null) {
  return lastSyncedAt
    ? `Last synced ${formatWhen(lastSyncedAt)}`
    : "Not synced yet";
}

function subscriptionLine(status: TeamsTranscriptStatus) {
  if (!status.instant) return "Instant updates need SITE_URL on https";
  if (status.subscriptionId && status.subscriptionExpiresAt) {
    return `Instant updates on until ${formatWhen(status.subscriptionExpiresAt)}`;
  }
  return "Instant updates not set up yet";
}

function SyncButton({
  action,
  label,
  variant = "secondary",
  shortcut,
}: {
  action: () => Promise<void>;
  label: string;
  variant?: "secondary" | "ghost";
  shortcut?: string;
}) {
  return (
    <form action={action}>
      <Button variant={variant} size="sm" type="submit" data-shortcut={shortcut} title={shortcut ? `${label} (S)` : undefined}>
        {label}
      </Button>
    </form>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function Status({
  tone,
  children,
}: {
  tone: "on" | "off" | "error";
  children: string;
}) {
  return (
    <span className="caption-style text-subtle flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "on"
            ? "bg-success"
            : tone === "error"
              ? "bg-danger"
              : "bg-faint",
        )}
      />
      {children}
    </span>
  );
}

export function SettingsNotices({
  notice,
  info,
  connected = false,
  add = null,
}: {
  notice: string | null;
  info: string | null;
  connected?: boolean;
  add?: string | null;
}) {
  if (!connected && !notice && !info) return null;
  return (
    <div className="flex flex-col gap-2">
      {connected && (
        <p role="status" className="caption-style text-soft rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]">
          Microsoft is connected. New mail is filed onto the matching contact, and you can send from a contact.
        </p>
      )}
      {notice && (
        <div role="alert" className="caption-style text-danger flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]">
          <span className="min-w-0 flex-1 basis-[16em]">{notice}</span>
          {add && (
            <Button variant="secondary" size="sm" href={addAccountHref(add)} aria-label={`Add ${add} as another account`}>
              Add as another account
            </Button>
          )}
        </div>
      )}
      {info && (
        <p role="status" className="caption-style text-soft rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]">
          {info}
        </p>
      )}
    </div>
  );
}

function mailboxStatus(mailbox: Mailbox) {
  if (!mailbox.connected) return "Disconnected";
  if (mailbox.needsReconnect) return "Needs reconnecting";
  return syncedLine(mailbox.lastSyncedAt);
}

function MailboxRow({
  mailbox,
  mirror,
  configured,
}: {
  mailbox: Mailbox;
  mirror: MailSourceStatus | null;
  configured: boolean;
}) {
  const main = mailbox.kind === "main";
  const tone = !mailbox.connected ? "off" : mailbox.needsReconnect || mailbox.problem ? "error" : "on";
  return (
    <li aria-label={mailbox.email} className="border-border flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-[14em] flex-col gap-1">
          <span className="text-[14px] leading-5 [overflow-wrap:anywhere]" title={mailbox.email}>
            {mailbox.email}
          </span>
          <Status tone={tone}>{`${main ? "Main" : "Other account"} · ${mailboxStatus(mailbox)}`}</Status>
          {main && <span className="caption-style text-subtle">Reconnect only accepts this address.</span>}
        </span>
        {configured && (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {main && mailbox.connected && !mailbox.needsReconnect && <SyncButton action={syncInboxAction} label="Sync now" shortcut="sync" />}
            <Button
              variant={mailbox.needsReconnect ? "primary" : "ghost"}
              size="sm"
              href={mailbox.reconnectHref}
              aria-label={`Reconnect ${mailbox.email}`}
            >
              Reconnect
            </Button>
            {main ? (
              mailbox.connected && (
                <form action={disconnectInboxAction}>
                  <Button variant="ghost" size="sm" type="submit" aria-label={`Disconnect ${mailbox.email}`}>
                    Disconnect
                  </Button>
                </form>
              )
            ) : (
              <RemoveAccountButton accountId={mailbox.id} email={mailbox.email} removes={mailbox.removes} />
            )}
          </span>
        )}
      </div>
      {mailbox.problem && (
        <p role="alert" className="caption-style text-danger leading-[1.4]">
          {mailbox.problem}
        </p>
      )}
      {mirror && <MailMirrorProgress source={mirror} showPaused={!mailbox.problem} />}
    </li>
  );
}

export function MicrosoftSettings({
  configured,
  redirectUri,
  mailboxes,
  calendar,
  mirror,
}: {
  configured: boolean;
  redirectUri: string;
  mailboxes: Mailbox[];
  calendar: CalendarStatus | null;
  mirror: MailSourceStatus[];
}) {
  const main = mailboxes.find((mailbox) => mailbox.kind === "main") ?? null;
  return (
    <SettingsCard
      id="microsoft"
      title="Microsoft 365"
      description="Outlook mail is filed onto the matching contact, and you can send from a contact. The main calendar and Teams calls come from the main account."
      action={
        configured && !main ? (
          <Button variant="primary" size="sm" href="/api/microsoft/connect">
            Connect Microsoft
          </Button>
        ) : undefined
      }
    >
      {!configured ? <Status tone="off">Not set up on this server</Status> : !main ? <Status tone="off">Not connected</Status> : null}
      {mailboxes.length > 0 && (
        <ul aria-label="Microsoft mailboxes" className="flex flex-col gap-3">
          {mailboxes.map((mailbox) => (
            <MailboxRow
              key={`${mailbox.kind}-${mailbox.id}`}
              mailbox={mailbox}
              configured={configured}
              mirror={mirror.find((source) => source.email.toLowerCase() === mailbox.email.toLowerCase()) ?? null}
            />
          ))}
        </ul>
      )}
      {configured && main && (
        <Actions>
          <Button variant="secondary" size="sm" href={addAccountHref()}>
            Connect another Microsoft account
          </Button>
        </Actions>
      )}
      {main?.connected && configured && calendar && (
        <div className="border-border flex flex-col gap-2 border-t pt-3">
          <h4 className="text-[14px] leading-5">Outlook calendar</h4>
          {calendar.scopeMissing ? (
            <Status tone="error">{`Reconnect ${main.email} to include your calendar. Mail keeps working in the meantime.`}</Status>
          ) : (
            <>
              <Status tone={calendar.lastError ? "error" : "on"}>{syncedLine(calendar.lastSyncedAt)}</Status>
              <span className="caption-style text-subtle">Meetings from the last 30 days and the next 60</span>
              {calendar.lastError && (
                <span role="alert" className="caption-style text-danger leading-[1.4]">
                  {calendar.lastError}
                </span>
              )}
            </>
          )}
          <Actions>
            {calendar.scopeMissing ? (
              <Button variant="primary" size="sm" href={main.reconnectHref} aria-label={`Reconnect ${main.email}`}>
                Reconnect
              </Button>
            ) : (
              <SyncButton action={syncCalendarAction} label="Sync calendar" />
            )}
          </Actions>
        </div>
      )}
      {!configured && (
        <SettingsDisclosure
          title="How to set it up"
          summary="An admin needs to register Orbit in Microsoft Entra before anyone can connect mail, calendar and Teams."
        >
          <p className="caption-style text-subtle leading-[1.4]">
            Register an app with delegated Mail.ReadWrite, Mail.Send, User.Read, Calendars.ReadWrite and offline_access. To log Teams calls and their transcripts, also add the
            CallRecords.Read.All and CallTranscripts.Read.All application permissions with admin consent. Put the client id and secret in the server environment, then restart Orbit.
          </p>
          <p className="caption-style text-subtle leading-[1.4] break-all">Redirect URI: {redirectUri}</p>
        </SettingsDisclosure>
      )}
      <p className="caption-style text-subtle leading-[1.4]">
        Calendar-only accounts and calendar links are in{" "}
        <Button
          variant="link"
          size="none"
          href={SETTINGS_PATHS.calendars}
          className="caption-style"
        >
          Calendars
        </Button>
        .
      </p>
    </SettingsCard>
  );
}

export function TeamsCallsSettings({
  configured,
  mailbox,
  calls,
  transcripts,
}: {
  configured: boolean;
  mailbox: MailboxSummary | null;
  calls: CallSyncSummary | null;
  transcripts: TeamsTranscriptStatus | null;
}) {
  const live = mailbox?.status === "connected";
  return (
    <SettingsCard
      id="teams"
      title="Teams calls"
      description="Teams phone calls are logged on the contact with the matching phone number. Start a call from a contact with Call in Teams."
    >
      {live && configured ? (
        <div className="flex flex-col gap-1.5">
          <Status tone={calls?.lastError ? "error" : "on"}>
            {`${calls?.logged ?? 0} ${calls?.logged === 1 ? "call" : "calls"} logged${
              calls?.unmatched
                ? ` · ${calls.unmatched} with no matching contact`
                : ""
            }`}
          </Status>
          <span className="caption-style text-subtle">
            {syncedLine(calls?.lastSyncedAt ?? null)}
          </span>
          {calls?.lastError && (
            <span role="alert" className="caption-style text-danger leading-[1.4]">
              {calls.lastError}
            </span>
          )}
          <Actions>
            <SyncButton action={syncCallsAction} label="Sync calls" />
          </Actions>
        </div>
      ) : (
        <Status tone="off">
          {configured ? "Connect Microsoft in Email to log Teams calls" : "Needs the Microsoft app set up on this server"}
        </Status>
      )}
      {live && configured && transcripts && (
        <div className="border-border flex flex-col gap-1.5 border-t pt-3">
          <h4 className="text-[14px] leading-5">Teams transcripts</h4>
          <Status tone={transcripts.lastError ? "error" : "on"}>
            {`${syncedLine(transcripts.lastSyncedAt)}${transcripts.pending ? ` · ${transcripts.pending} waiting for the call log` : ""}`}
          </Status>
          <span className="caption-style text-subtle">{subscriptionLine(transcripts)}</span>
          {transcripts.lastError && (
            <span role="alert" className="caption-style text-danger leading-[1.4]">
              {transcripts.lastError}
            </span>
          )}
          <Actions>
            <SyncButton action={syncTranscriptsAction} label="Sync transcripts" />
          </Actions>
        </div>
      )}
      <SettingsDisclosure
        title="Permissions for calls and transcripts"
        summary="Teams call logs need application permissions with admin consent."
      >
        <p className="caption-style text-subtle leading-[1.4]">
          To log Teams calls and their transcripts, add the
          CallRecords.Read.All and CallTranscripts.Read.All application
          permissions to Orbit&apos;s Microsoft Entra app, with admin consent.
        </p>
      </SettingsDisclosure>
    </SettingsCard>
  );
}

export function GranolaSettings({ granola, canAdmin }: { granola: GranolaStatus; canAdmin: boolean }) {
  return (
    <SettingsCard
      id="granola"
      title="Granola"
      description="Granola meeting notes and transcripts are filed onto the people who were in the meeting."
    >
      {granola.configured && (
        <div className="flex flex-col gap-1.5">
          <Status tone={granola.lastError ? "error" : "on"}>
            {`${syncedLine(granola.lastSyncedAt)}${granola.webhookEnabled ? " · Instant sync on" : " · Checked every 10 minutes"}`}
          </Status>
          {granola.lastError && (
            <span role="alert" className="caption-style text-danger leading-[1.4]">
              {granola.lastError}
            </span>
          )}
          <Actions>
            <SyncButton action={syncGranolaAction} label="Sync now" />
            {!granola.webhookEnabled && canAdmin && <SyncButton action={enableGranolaWebhookAction} label="Turn on instant sync" variant="ghost" />}
          </Actions>
        </div>
      )}
      <GranolaKey connected={granola.personal.connected} hint={granola.personal.hint} />
    </SettingsCard>
  );
}

export function ReadwiseSettings({ readwise, workspaces }: { readwise: ReadwiseStatus; workspaces: { id: string; name: string }[] }) {
  return (
    <SettingsCard
      id="readwise"
      title="Readwise Reader"
      description="Documents you tag orbit in Reader are added to Knowledge with their highlights. The assistant can read your Reader when you ask. Orbit never changes anything in Reader. If you disconnect, items already in Knowledge stay."
    >
      {readwise.connected && (
        <ReadwiseSync lastError={readwise.lastError}>
          <Status tone={readwise.lastError ? "error" : "on"}>
            {`${readwise.documents} ${readwise.documents === 1 ? "document" : "documents"} in Knowledge · ${syncedLine(readwise.lastSyncedAt)} · Checked every 10 minutes`}
          </Status>
          {readwise.lastError && (
            <span className="caption-style text-danger leading-[1.4]">
              {readwise.lastErrorAt ? `${readwise.lastError} (${formatWhen(readwise.lastErrorAt)})` : readwise.lastError}
            </span>
          )}
        </ReadwiseSync>
      )}
      {readwise.connected && readwise.workspaceId && workspaces.length > 1 && <ReadwiseWorkspace current={readwise.workspaceId} workspaces={workspaces} />}
      <ReadwiseToken connected={readwise.connected} hint={readwise.hint} />
    </SettingsCard>
  );
}

export function RecallSettings({ recall }: { recall: RecallStatus }) {
  return (
    <SettingsCard
      id="recall"
      title="Recall"
      description="The assistant can search and read your Recall when you ask. Nothing is copied into Orbit."
    >
      <RecallKey connected={recall.connected}>
        <Status tone={recall.connected ? "on" : "off"}>
          {recall.connected ? `Connected${recall.hint ? ` · key ending ${recall.hint}` : ""}` : "Not connected"}
        </Status>
      </RecallKey>
      {recall.connected && <p className="caption-style text-subtle leading-[1.4]">{RECALL_TAGS[recall.tags]}</p>}
    </SettingsCard>
  );
}

export function LinearSettings({ linear }: { linear: LinearStatus }) {
  return (
    <SettingsCard
      id="linear"
      title="Linear"
      description="The assistant can read Linear issues and, when you ask it to, create, comment on and update them. It never files issues on its own."
    >
      {linear.configured ? (
        <div className="flex flex-col gap-1.5">
          <Status tone={linear.error ? "error" : "on"}>
            {linear.team ? `Connected · Issues go to ${linear.team.name} (${linear.team.key})` : "Couldn't connect"}
          </Status>
          {linear.error && <span className="caption-style text-danger leading-[1.4]">{linear.error}</span>}
        </div>
      ) : (
        <Status tone="off">
          Set LINEAR_API_KEY (a personal API key from Linear, Settings, Security and access) in the server environment, then
          redeploy Orbit
        </Status>
      )}
    </SettingsCard>
  );
}
