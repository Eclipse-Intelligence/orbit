import Button from "@/components/_ui/button";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import { formatWhen } from "@/lib/companies";
import type { CallSyncSummary } from "@/lib/crm/calls";
import type { GranolaStatus } from "@/lib/crm/granola";
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
  readwise,
  recall,
  linear,
}: {
  configured: boolean;
  mailbox: MailboxSummary | null;
  calls: CallSyncSummary | null;
  granola: GranolaStatus;
  readwise: ReadwiseStatus;
  recall: RecallStatus;
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
          configured ? (
            <Button variant={live ? "secondary" : "primary"} size="sm" href="/api/microsoft/connect">
              {live ? "Reconnect" : mailbox ? "Reconnect Microsoft" : "Connect Microsoft"}
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
            Connect Microsoft in Capture to log Teams calls
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
            Sync calls and transcripts from Capture.
          </p>
        </SettingsDisclosure>
      </SettingsCard>

      <SettingsCard
        id="granola"
        title="Granola"
        description="Granola meeting notes and transcripts are filed onto the people who were in the meeting."
        action={
          granola.configured ? (
            <Button variant="secondary" size="sm" href="/capture">
              Sync in Capture
            </Button>
          ) : undefined
        }
      >
        {granola.configured && (
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
