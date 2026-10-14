import Button, { buttonVariants } from "@/components/_ui/button";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import PeopleMet from "@/components/crm/people-met";
import SectionHeader from "@/components/crm/section-header";
import UnfiledConversations from "@/components/crm/unfiled-conversations";
import type { Viewer } from "@/components/crm/viewer";
import {
  disconnectInboxAction,
  enableGranolaWebhookAction,
  syncCalendarAction,
  syncCallsAction,
  syncGranolaAction,
  syncInboxAction,
  syncTranscriptsAction,
} from "@/app/(crm)/inbox/actions";
import { formatWhen } from "@/lib/companies";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { CalendarStatus, MetPerson } from "@/lib/crm/calendar";
import type { CallSyncSummary } from "@/lib/crm/calls";
import type { UnfiledImport } from "@/lib/crm/conversations";
import type { GranolaStatus } from "@/lib/crm/granola";
import type { InboxMessage, MailboxSummary } from "@/lib/crm/inbox";
import type { TeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";

function syncedLine(lastSyncedAt: string | null) {
  return lastSyncedAt ? `Last synced ${formatWhen(lastSyncedAt)}` : "Not synced yet";
}

function subscriptionLine(status: TeamsTranscriptStatus) {
  if (!status.instant) return "Instant updates need SITE_URL on https";
  if (status.subscriptionId && status.subscriptionExpiresAt) {
    return `Instant updates on until ${formatWhen(status.subscriptionExpiresAt)}`;
  }
  return "Instant updates not set up yet";
}

export default function InboxScreen({
  viewer,
  configured,
  redirectUri,
  mailbox,
  messages,
  calls,
  unfiled,
  granola,
  transcripts,
  calendar,
  people,
  notice,
  info,
  connected,
}: {
  viewer: Viewer;
  configured: boolean;
  redirectUri: string;
  mailbox: MailboxSummary | null;
  messages: InboxMessage[];
  calls: CallSyncSummary | null;
  unfiled: UnfiledImport[];
  granola: GranolaStatus;
  transcripts: TeamsTranscriptStatus | null;
  calendar: CalendarStatus | null;
  people: MetPerson[];
  notice: string | null;
  info: string | null;
  connected: boolean;
}) {
  const live = mailbox?.status === "connected";

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Inbox"
        viewer={viewer}
        action={
          live ? (
            <div className="flex items-center gap-2">
              <form action={syncInboxAction}>
                <Button variant="secondary" size="sm" type="submit">
                  Sync
                </Button>
              </form>
              <form action={disconnectInboxAction}>
                <Button variant="ghost" size="sm" type="submit">
                  Disconnect
                </Button>
              </form>
            </div>
          ) : configured ? (
            <Button variant="primary" size="sm" href="/api/microsoft/connect">
              Connect Microsoft
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-2 px-4 py-4">
        {connected && (
          <p className="caption-style text-subtle" role="status">
            Microsoft is connected. New mail is filed onto the matching contact,
            and you can send from a contact.
          </p>
        )}
        {notice && (
          <p className="caption-style text-danger" role="alert">
            {notice}
          </p>
        )}
        {info && (
          <p className="caption-style text-subtle" role="status">
            {info}
          </p>
        )}
        {!notice && mailbox?.lastError && (
          <p className="caption-style text-danger" role="alert">
            {mailbox.lastError}
          </p>
        )}
        {!configured && (
          <div className="border-border bg-card flex max-w-[640px] flex-col gap-2 rounded-xl border p-4">
            <h2>Microsoft app</h2>
            <p className="caption-style text-subtle">
              Register an app in Microsoft Entra with delegated Mail.Read,
              Mail.Send, User.Read, Calendars.Read, and offline_access. To log Teams calls and
              their transcripts, also add the CallRecords.Read.All and
              CallTranscripts.Read.All application permissions with admin
              consent. Put the client id and secret in the server environment,
              then restart Orbit.
            </p>
            <p className="caption-style text-subtle">
              Redirect URI to register: {redirectUri}
            </p>
          </div>
        )}
        {configured && !live && (
          <p className="caption-style text-subtle">
            Connect the Microsoft mailbox you use for customers. Received mail
            is attached to a contact by email address, or to a company by
            domain.
          </p>
        )}
        {live && (
          <p className="caption-style text-subtle">
            {mailbox.email}
            {mailbox.lastSyncedAt
              ? ` · Last synced ${formatWhen(mailbox.lastSyncedAt)}`
              : " · Not synced yet"}
          </p>
        )}
        {live && configured && (
          <div className="border-border flex max-w-[640px] items-center gap-3 rounded-xl border p-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[14px] leading-5">Teams calls</span>
              <span className="caption-style text-subtle">
                {calls?.lastSyncedAt
                  ? `Last synced ${formatWhen(calls.lastSyncedAt)}`
                  : "Not synced yet"}
                {` · ${calls?.logged ?? 0} ${calls?.logged === 1 ? "call" : "calls"} logged`}
                {calls?.unmatched
                  ? ` · ${calls.unmatched} with no matching contact`
                  : ""}
              </span>
              {calls?.lastError && (
                <span className="caption-style text-danger" role="alert">
                  {calls.lastError}
                </span>
              )}
            </span>
            <form action={syncCallsAction}>
              <Button variant="secondary" size="sm" type="submit">
                Sync calls
              </Button>
            </form>
          </div>
        )}
        {live && configured && calendar && (
          <div className="border-border flex max-w-[640px] items-center gap-3 rounded-xl border p-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[14px] leading-5">Outlook calendar</span>
              {calendar.scopeMissing ? (
                <span className="caption-style text-subtle">
                  Reconnect Microsoft to include your calendar. Mail keeps working
                  in the meantime.
                </span>
              ) : (
                <span className="caption-style text-subtle">
                  {syncedLine(calendar.lastSyncedAt)} · Meetings from the last 30
                  days and the next 60
                </span>
              )}
              {!calendar.scopeMissing && calendar.lastError && (
                <span className="caption-style text-danger" role="alert">
                  {calendar.lastError}
                </span>
              )}
            </span>
            {calendar.scopeMissing ? (
              <a
                href="/api/microsoft/connect"
                className={buttonVariants({ variant: "primary", size: "sm" })}
              >
                Reconnect Microsoft
              </a>
            ) : (
              <form action={syncCalendarAction}>
                <Button variant="secondary" size="sm" type="submit">
                  Sync calendar
                </Button>
              </form>
            )}
          </div>
        )}
        {live && configured && transcripts && (
          <div className="border-border flex max-w-[640px] items-center gap-3 rounded-xl border p-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[14px] leading-5">Teams transcripts</span>
              <span className="caption-style text-subtle">
                {syncedLine(transcripts.lastSyncedAt)}
                {transcripts.pending
                  ? ` · ${transcripts.pending} waiting for the call log`
                  : ""}
              </span>
              <span className="caption-style text-subtle">
                {subscriptionLine(transcripts)}
              </span>
              {transcripts.lastError && (
                <span className="caption-style text-danger" role="alert">
                  {transcripts.lastError}
                </span>
              )}
            </span>
            <form action={syncTranscriptsAction}>
              <Button variant="secondary" size="sm" type="submit">
                Sync now
              </Button>
            </form>
          </div>
        )}
        <div className="border-border flex max-w-[640px] items-center gap-3 rounded-xl border p-3">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[14px] leading-5">Granola</span>
            {granola.configured ? (
              <>
                <span className="caption-style text-subtle">
                  {syncedLine(granola.lastSyncedAt)}
                  {granola.webhookEnabled
                    ? " · Instant sync on"
                    : " · Checked every 10 minutes"}
                </span>
                {granola.lastError && (
                  <span className="caption-style text-danger" role="alert">
                    {granola.lastError}
                  </span>
                )}
              </>
            ) : (
              <span className="caption-style text-subtle">
                Set GRANOLA_API_KEY in the server environment to import
                Granola meetings, then restart Orbit.
              </span>
            )}
          </span>
          {granola.configured && (
            <div className="flex items-center gap-2">
              {!granola.webhookEnabled && viewer.role !== "member" && (
                <form action={enableGranolaWebhookAction}>
                  <Button variant="ghost" size="sm" type="submit">
                    Enable instant Granola sync
                  </Button>
                </form>
              )}
              <form action={syncGranolaAction}>
                <Button variant="secondary" size="sm" type="submit">
                  Sync now
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>
      <UnfiledConversations conversations={unfiled} />
      <PeopleMet people={people} />
      {messages.length === 0 ? (
        <p className="caption-style text-subtle px-4">No mail filed yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto">
          {messages.map((message) => {
            const attached = message.contactName || message.companyName;
            const attachedHref =
              message.contactName && message.contactId
                ? contactHref(message.contactId)
                : message.companyId
                  ? companyHref(message.companyId)
                  : null;
            return (
              <li
                key={message.id}
                className="border-border flex min-h-11 items-center gap-2.5 border-b px-2.5 py-2"
              >
                <Monogram
                  name={
                    message.fromName ||
                    message.fromEmail ||
                    message.subject ||
                    "Email"
                  }
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] leading-5">
                    {message.subject || "Email"}
                  </span>
                  <span className="caption-style text-subtle truncate">
                    {message.fromName || message.fromEmail || "Unknown sender"}
                    {message.receivedAt
                      ? ` · ${formatWhen(message.receivedAt)}`
                      : ""}
                  </span>
                </span>
                {attached && attachedHref ? (
                  <EntityChip name={attached} href={attachedHref} />
                ) : (
                  <span className="caption-style text-subtle shrink-0">
                    {attached || "Not attached"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
