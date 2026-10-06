import Button from "@/components/_ui/button";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import {
  disconnectInboxAction,
  syncInboxAction,
} from "@/app/(crm)/inbox/actions";
import { formatWhen } from "@/lib/companies";
import type { InboxMessage, MailboxSummary } from "@/lib/crm/inbox";

export default function InboxScreen({
  viewer,
  configured,
  redirectUri,
  mailbox,
  messages,
  notice,
  connected,
}: {
  viewer: Viewer;
  configured: boolean;
  redirectUri: string;
  mailbox: MailboxSummary | null;
  messages: InboxMessage[];
  notice: string | null;
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
              Mail.Send, User.Read, and offline_access. Put the client id and
              secret in the server environment, then restart Orbit.
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
      </div>
      {messages.length === 0 ? (
        <p className="caption-style text-subtle px-4">No mail filed yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto">
          {messages.map((message) => {
            const attached = message.contactName || message.companyName;
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
                {attached && message.companyId ? (
                  <EntityChip
                    name={attached}
                    href={`/?record=${message.companyId}`}
                  />
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
