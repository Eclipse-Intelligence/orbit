import type { ComponentType, ReactNode, SVGProps } from "react";
import MorningBrief from "@/components/crm/morning-brief";
import type { Brief } from "@/lib/learning/nightly";
import Button from "@/components/_ui/button";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import PeopleMet from "@/components/crm/people-met";
import MailMirrorStatus from "@/components/crm/mail-mirror-status";
import SectionHeader from "@/components/crm/section-header";
import type { MailSourceStatus } from "@/lib/mail/store";
import KeyboardList from "@/components/shortcuts/keyboard-list";
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
} from "@/app/(crm)/capture/actions";
import { formatWhen, relativeWhen } from "@/lib/companies";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { CalendarStatus, MetPerson } from "@/lib/crm/calendar";
import type { CallSyncSummary } from "@/lib/crm/calls";
import type { UnfiledImport } from "@/lib/crm/conversations";
import type { GranolaStatus } from "@/lib/crm/granola";
import type { InboxMessage, MailboxSummary } from "@/lib/crm/inbox";
import type { TeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import { cn } from "@/lib/utils";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import MicIcon from "@/public/assets/images/_common/mic.svg";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";
import NoteIcon from "@/public/assets/images/crm/activity/note.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";

const RECENT = 8;

type SourceState = "on" | "off" | "attention";

const STATE_LABEL: Record<SourceState, string> = { on: "On", off: "Off", attention: "Needs attention" };

function syncedLine(lastSyncedAt: string | null) {
  return lastSyncedAt ? `Synced ${formatWhen(lastSyncedAt)}` : "Not synced yet";
}

function subscriptionLine(status: TeamsTranscriptStatus) {
  if (!status.instant) return "Instant updates need SITE_URL on https";
  if (status.subscriptionId && status.subscriptionExpiresAt) {
    return `Instant updates on until ${formatWhen(status.subscriptionExpiresAt)}`;
  }
  return "Instant updates not set up yet";
}

function SourceCard({
  icon: Icon,
  title,
  state,
  detail,
  error,
  children,
  extra,
  wide,
}: {
  extra?: ReactNode;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  state: SourceState;
  detail: ReactNode;
  error?: string | null;
  children?: ReactNode;
  wide?: boolean;
}) {
  return (
    <li className={cn("bg-card border-line-strong flex flex-col gap-3 rounded-2xl border p-4", wide && "sm:col-span-2")}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-soft flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05]">
          <Icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="h4-style truncate">{title}</h3>
            <span
              className={cn(
                "caption-style flex shrink-0 items-center gap-1.5",
                state === "on" ? "text-soft" : state === "attention" ? "text-warning" : "text-subtle",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  state === "on" ? "bg-success" : state === "attention" ? "bg-warning" : "bg-white/20",
                )}
              />
              {STATE_LABEL[state]}
            </span>
          </div>
          <div className="caption-style text-subtle flex flex-col gap-1 leading-[1.4]">{detail}</div>
        </div>
      </div>
      {extra && <div className="sm:pl-11">{extra}</div>}
      {error && (
        <p role="alert" className="caption-style text-danger leading-[1.4]">
          {error}
        </p>
      )}
      {children && <div className="flex flex-wrap items-center gap-2 pl-11">{children}</div>}
    </li>
  );
}

function SyncButton({ action, label, shortcut }: { action: () => Promise<void>; label: string; shortcut?: string }) {
  return (
    <form action={action}>
      <Button variant="secondary" size="sm" type="submit" data-shortcut={shortcut} title={shortcut ? `${label} (S)` : undefined}>
        {label}
      </Button>
    </form>
  );
}

function SectionTitle({ id, children, count }: { id: string; children: ReactNode; count?: number }) {
  return (
    <h2 id={id} className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
      {children}
      {count ? <span className="text-soft tabular-nums tracking-normal">{count}</span> : null}
    </h2>
  );
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
  mirror,
  brief,
  notice,
  info,
  connected,
  now,
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
  mirror: MailSourceStatus[];
  brief: Brief | null;
  notice: string | null;
  info: string | null;
  connected: boolean;
  now: number;
}) {
  const live = mailbox?.status === "connected";
  const toFile = unfiled.length + people.length;
  const recent = messages.slice(0, RECENT);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Capture" viewer={viewer} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-8 px-4 py-5 sm:px-6 sm:py-6">
          <p className="text-soft max-w-[40em] leading-[1.5]">
            Orbit brings in your email, calls and meetings and files each one on the right person. Anything it can&apos;t place waits here for you.
          </p>

          {brief && <MorningBrief brief={brief} />}

          {(connected || notice || info || (!notice && mailbox?.lastError)) && (
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
              {!notice && mailbox?.lastError && (
                <p role="alert" className="caption-style text-danger rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]">
                  {mailbox.lastError}
                </p>
              )}
            </div>
          )}

          <section aria-labelledby="to-file-heading" className="flex flex-col gap-3">
            <SectionTitle id="to-file-heading" count={toFile}>
              To file
            </SectionTitle>
            {toFile === 0 ? (
              <p className="caption-style text-subtle leading-[1.4]">
                Nothing waiting. Every imported meeting and call is on a contact, and everyone you&apos;ve met recently is in Orbit.
              </p>
            ) : (
              <KeyboardList className="flex flex-col gap-6">
                <UnfiledConversations conversations={unfiled} />
                <PeopleMet people={people} />
              </KeyboardList>
            )}
          </section>

          <section aria-labelledby="sources-heading" className="flex flex-col gap-3">
            <SectionTitle id="sources-heading">Sources</SectionTitle>
            <ul className="grid gap-3 sm:grid-cols-2">
              {!configured ? (
                <SourceCard
                  icon={InboxIcon}
                  title="Microsoft 365"
                  state="off"
                  wide
                  detail={
                    <>
                      <span>An admin needs to register Orbit in Microsoft Entra before anyone can connect mail, calendar and Teams.</span>
                      <details className="group">
                        <summary className="text-soft hover:text-foreground cursor-pointer select-none">How to set it up</summary>
                        <div className="flex flex-col gap-2 pt-2">
                          <span>
                            Register an app with delegated Mail.ReadWrite, Mail.Send, User.Read, Calendars.ReadWrite and offline_access. To log Teams calls and their transcripts, also add the
                            CallRecords.Read.All and CallTranscripts.Read.All application permissions with admin consent. Put the client id and secret in the server environment, then restart Orbit.
                          </span>
                          <span className="break-all">Redirect URI: {redirectUri}</span>
                        </div>
                      </details>
                    </>
                  }
                />
              ) : (
                <SourceCard
                  icon={InboxIcon}
                  title="Microsoft 365 mail"
                  state={live ? (mailbox?.lastError ? "attention" : "on") : "off"}
                  wide={mirror.length > 0}
                  extra={mirror.length > 0 ? <MailMirrorStatus sources={mirror} /> : null}
                  detail={
                    live ? (
                      <>
                        <span className="text-soft truncate">{mailbox.email}</span>
                        <span>{syncedLine(mailbox.lastSyncedAt)}</span>
                      </>
                    ) : (
                      <span>Connect the Microsoft mailbox you use for customers. Mail is filed on a contact by email address, or on a company by domain.</span>
                    )
                  }
                >
                  {live ? (
                    <>
                      <SyncButton action={syncInboxAction} label="Sync now" shortcut="sync" />
                      <Button variant="ghost" size="sm" href="/api/microsoft/connect">
                        Reconnect
                      </Button>
                      <form action={disconnectInboxAction}>
                        <Button variant="ghost" size="sm" type="submit">
                          Disconnect
                        </Button>
                      </form>
                    </>
                  ) : (
                    <Button variant="primary" size="sm" href="/api/microsoft/connect">
                      Connect Microsoft
                    </Button>
                  )}
                </SourceCard>
              )}
              {live && configured && calendar && (
                <SourceCard
                  icon={CalendarIcon}
                  title="Outlook calendar"
                  state={calendar.scopeMissing || calendar.lastError ? "attention" : "on"}
                  error={!calendar.scopeMissing ? calendar.lastError : null}
                  detail={
                    calendar.scopeMissing ? (
                      <span>Reconnect Microsoft to include your calendar. Mail keeps working in the meantime.</span>
                    ) : (
                      <>
                        <span>{syncedLine(calendar.lastSyncedAt)}</span>
                        <span>Meetings from the last 30 days and the next 60</span>
                      </>
                    )
                  }
                >
                  {calendar.scopeMissing ? (
                    <Button variant="primary" size="sm" href="/api/microsoft/connect">
                      Reconnect Microsoft
                    </Button>
                  ) : (
                    <SyncButton action={syncCalendarAction} label="Sync calendar" />
                  )}
                </SourceCard>
              )}
              {live && configured && (
                <SourceCard
                  icon={PhoneIcon}
                  title="Teams calls"
                  state={calls?.lastError ? "attention" : "on"}
                  error={calls?.lastError}
                  detail={
                    <>
                      <span>{syncedLine(calls?.lastSyncedAt ?? null)}</span>
                      <span>
                        {calls?.logged ?? 0} {calls?.logged === 1 ? "call" : "calls"} logged
                        {calls?.unmatched ? `, ${calls.unmatched} with no matching contact` : ""}
                      </span>
                    </>
                  }
                >
                  <SyncButton action={syncCallsAction} label="Sync calls" />
                </SourceCard>
              )}
              {live && configured && transcripts && (
                <SourceCard
                  icon={MicIcon}
                  title="Teams transcripts"
                  state={transcripts.lastError ? "attention" : "on"}
                  error={transcripts.lastError}
                  detail={
                    <>
                      <span>
                        {syncedLine(transcripts.lastSyncedAt)}
                        {transcripts.pending ? `, ${transcripts.pending} waiting for the call log` : ""}
                      </span>
                      <span>{subscriptionLine(transcripts)}</span>
                    </>
                  }
                >
                  <SyncButton action={syncTranscriptsAction} label="Sync now" />
                </SourceCard>
              )}
              <SourceCard
                icon={NoteIcon}
                title="Granola"
                state={!granola.configured ? "off" : granola.lastError ? "attention" : "on"}
                error={granola.configured ? granola.lastError : null}
                detail={
                  granola.configured ? (
                    <>
                      <span>{syncedLine(granola.lastSyncedAt)}</span>
                      <span>{granola.webhookEnabled ? "Instant sync on" : "Checked every 10 minutes"}</span>
                    </>
                  ) : (
                    <span>Add your Granola key in Settings, under Integrations, to import your meeting notes.</span>
                  )
                }
              >
                {granola.configured ? (
                  <>
                    <SyncButton action={syncGranolaAction} label="Sync now" />
                    {!granola.webhookEnabled && viewer.role !== "member" && (
                      <form action={enableGranolaWebhookAction}>
                        <Button variant="ghost" size="sm" type="submit">
                          Turn on instant sync
                        </Button>
                      </form>
                    )}
                  </>
                ) : (
                  <Button variant="secondary" size="sm" href="/settings/integrations">
                    Open Integrations
                  </Button>
                )}
              </SourceCard>
            </ul>
          </section>

          {recent.length > 0 && (
            <section aria-labelledby="recent-heading" className="flex flex-col gap-3">
              <SectionTitle id="recent-heading">Recently filed email</SectionTitle>
              <ul className="flex flex-col">
                {recent.map((message) => {
                  const attached = message.contactName || message.companyName;
                  const attachedHref =
                    message.contactName && message.contactId
                      ? contactHref(message.contactId)
                      : message.companyId
                        ? companyHref(message.companyId)
                        : null;
                  return (
                    <li key={message.id} className="flex min-h-12 items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.03]">
                      <Monogram name={message.fromName || message.fromEmail || message.subject || "Email"} />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-[14px] leading-5">{message.subject || "Email"}</span>
                        <span className="caption-style text-subtle truncate">
                          {message.fromName || message.fromEmail || "Unknown sender"}
                          {message.receivedAt ? ` · ${relativeWhen(message.receivedAt, now)}` : ""}
                        </span>
                      </span>
                      {attached && attachedHref ? (
                        <EntityChip name={attached} href={attachedHref} />
                      ) : (
                        <span className="caption-style text-subtle shrink-0">{attached || "Not filed"}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {messages.length > RECENT && (
                <p className="caption-style text-subtle">
                  Older email is in{" "}
                  <Button variant="link" size="none" href="/mail">
                    Mail
                  </Button>{" "}
                  and on each contact.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
