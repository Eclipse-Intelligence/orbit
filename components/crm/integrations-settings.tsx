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
import MailMirrorStatus from "@/components/crm/mail-mirror-status";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import { formatWhen } from "@/lib/companies";
import type { CalendarStatus } from "@/lib/crm/calendar";
import type { CallSyncSummary } from "@/lib/crm/calls";
import type { GranolaStatus } from "@/lib/crm/granola";
import type { TeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import type { MailSourceStatus } from "@/lib/mail/store";
import type { LinearStatus } from "@/lib/linear";
import GranolaKey from "@/components/crm/granola-key";
import type { MailboxSummary } from "@/lib/crm/inbox";
import { ReadwiseSync, ReadwiseToken } from "@/components/crm/readwise-settings";
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

export default function IntegrationsSettings({
  configured,
  redirectUri,
  mailbox,
  calls,
  transcripts,
  calendar,
  mirror,
  canAdmin,
  notice,
  info,
  connected,
  granola,
  readwise,
  recall,
  linear,
}: {
  configured: boolean;
  redirectUri: string;
  mailbox: MailboxSummary | null;
  calls: CallSyncSummary | null;
  transcripts: TeamsTranscriptStatus | null;
  calendar: CalendarStatus | null;
  mirror: MailSourceStatus[];
  canAdmin: boolean;
  notice: string | null;
  info: string | null;
  connected: boolean;
  granola: GranolaStatus;
  readwise: ReadwiseStatus;
  recall: RecallStatus;
  linear: LinearStatus;
}) {
  const live = mailbox?.status === "connected";
  const mailboxError = mailbox?.lastError ?? null;

  return (
    <>
      {(connected || notice || info) && (
        <div className="flex flex-col gap-2">
          {connected && (
            <p role="status" className="caption-style text-soft rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]">
              Microsoft is connected. New mail is filed onto the matching contact, and you can send from a contact.
            </p>
          )}
          {notice && (
            <p role="alert" className="caption-style text-danger rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]">
              {notice}
            </p>
          )}
          {info && (
            <p role="status" className="caption-style text-soft rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]">
              {info}
            </p>
          )}
        </div>
      )}

      <SettingsCard
        id="microsoft"
        title="Microsoft 365"
        description="Outlook mail is filed onto the matching contact, and you can send from a contact. The main calendar and Teams calls come from the same account."
        action={
          configured && !live ? (
            <Button variant="primary" size="sm" href="/api/microsoft/connect">
              {mailbox ? "Reconnect Microsoft" : "Connect Microsoft"}
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-1.5">
          {live ? (
            <Status
              tone={mailboxError ? "error" : "on"}
            >{`Connected as ${mailbox.email}`}</Status>
          ) : (
            <Status tone="off">
              {!configured
                ? "Not set up on this server"
                : mailbox
                  ? `Disconnected (${mailbox.email})`
                  : "Not connected"}
            </Status>
          )}
          {live && (
            <span className="caption-style text-subtle">
              {syncedLine(mailbox.lastSyncedAt)}
            </span>
          )}
          {mailboxError && (
            <span role="alert" className="caption-style text-danger leading-[1.4]">
              {mailboxError}
            </span>
          )}
        </div>
        {live && configured && (
          <Actions>
            <SyncButton action={syncInboxAction} label="Sync now" shortcut="sync" />
            <Button variant="ghost" size="sm" href="/api/microsoft/connect">
              Reconnect
            </Button>
            <form action={disconnectInboxAction}>
              <Button variant="ghost" size="sm" type="submit">
                Disconnect
              </Button>
            </form>
          </Actions>
        )}
        {mirror.length > 0 && <MailMirrorStatus sources={mirror} />}
        {live && configured && calendar && (
          <div className="border-border flex flex-col gap-2 border-t pt-3">
            <h4 className="text-[14px] leading-5">Outlook calendar</h4>
            {calendar.scopeMissing ? (
              <Status tone="error">Reconnect Microsoft to include your calendar. Mail keeps working in the meantime.</Status>
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
                <Button variant="primary" size="sm" href="/api/microsoft/connect">
                  Reconnect Microsoft
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
          Extra Microsoft accounts and calendar links are in{" "}
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
            Connect Microsoft above to log Teams calls
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
        <ReadwiseToken connected={readwise.connected} hint={readwise.hint} />
      </SettingsCard>

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
    </>
  );
}
