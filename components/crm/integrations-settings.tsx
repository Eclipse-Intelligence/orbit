import Button from "@/components/_ui/button";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import { formatWhen } from "@/lib/companies";
import type { CallSyncSummary } from "@/lib/crm/calls";
import type { GranolaStatus } from "@/lib/crm/granola";
import type { LinearStatus } from "@/lib/linear";
import type { MailboxSummary } from "@/lib/crm/inbox";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";

function syncedLine(lastSyncedAt: string | null) {
  return lastSyncedAt
    ? `Last synced ${formatWhen(lastSyncedAt)}`
    : "Not synced yet";
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
  mailbox,
  calls,
  granola,
  linear,
}: {
  configured: boolean;
  mailbox: MailboxSummary | null;
  calls: CallSyncSummary | null;
  granola: GranolaStatus;
  linear: LinearStatus;
}) {
  const live = mailbox?.status === "connected";
  const mailboxError = mailbox?.lastError ?? null;

  return (
    <>
      <SettingsCard
        id="microsoft"
        title="Microsoft 365"
        description="Outlook mail is filed onto the matching contact, and you can send from a contact. The main calendar and Teams calls come from the same account."
        action={
          <Button
            variant={live ? "secondary" : "primary"}
            size="sm"
            href="/inbox"
          >
            {live
              ? "Manage in Inbox"
              : configured
                ? "Connect in Inbox"
                : "Set up in Inbox"}
          </Button>
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
                ? "The Microsoft app isn't set up on the server yet"
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
            <span className="caption-style text-danger leading-[1.4]">
              {mailboxError}
            </span>
          )}
        </div>
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
              <span className="caption-style text-danger leading-[1.4]">
                {calls.lastError}
              </span>
            )}
          </div>
        ) : (
          <Status tone="off">
            Connect Microsoft in Inbox to log Teams calls
          </Status>
        )}
        <SettingsDisclosure
          title="Permissions for calls and transcripts"
          summary="Teams call logs need application permissions with admin consent."
        >
          <p className="caption-style text-subtle leading-[1.4]">
            To log Teams calls and their transcripts, add the
            CallRecords.Read.All and CallTranscripts.Read.All application
            permissions to Orbit&apos;s Microsoft Entra app, with admin consent.
            Sync calls and transcripts from Inbox.
          </p>
        </SettingsDisclosure>
      </SettingsCard>

      <SettingsCard
        id="granola"
        title="Granola"
        description="Granola meeting notes and transcripts are filed onto the people who were in the meeting."
        action={
          granola.configured ? (
            <Button variant="secondary" size="sm" href="/inbox">
              Sync in Inbox
            </Button>
          ) : undefined
        }
      >
        {granola.configured ? (
          <div className="flex flex-col gap-1.5">
            <Status tone={granola.lastError ? "error" : "on"}>
              {`${syncedLine(granola.lastSyncedAt)}${granola.webhookEnabled ? " · Instant sync on" : " · Checked every 10 minutes"}`}
            </Status>
            {granola.lastError && (
              <span className="caption-style text-danger leading-[1.4]">
                {granola.lastError}
              </span>
            )}
          </div>
        ) : (
          <Status tone="off">
            Set GRANOLA_API_KEY in the server environment to import Granola
            meetings, then restart Orbit
          </Status>
        )}
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
