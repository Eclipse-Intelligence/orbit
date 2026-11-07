import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { MicrosoftSettings, SettingsNotices } from "@/components/crm/connection-cards";
import MyEmailsSettings from "@/components/crm/my-emails-settings";
import SignaturesSettings from "@/components/crm/signatures-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import MailHelpSettings from "@/components/mail/mail-help-settings";
import MailRoutingSettings from "@/components/mail/mail-routing-settings";
import ReadStatusSettings from "@/components/mail/read-status-settings";
import SendingAddressesSettings from "@/components/mail/sending-addresses-settings";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { getCalendarStatus } from "@/lib/crm/calendar";
import { getMailbox, listSenders } from "@/lib/crm/inbox";
import { listHoldCalendars } from "@/lib/crm/invite-senders";
import { getMyEmails } from "@/lib/crm/profile";
import { composeAccounts } from "@/lib/mail/compose";
import { listIdentities } from "@/lib/mail/identities";
import { mailHelpSettings } from "@/lib/mail/prepare";
import { listAddressHomes, listDomainRules } from "@/lib/mail/routing";
import { mailSyncStatus } from "@/lib/mail/store";
import { readStatusesOn } from "@/lib/mail/tracking";
import { microsoftConfigured, microsoftRedirectUri } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const notice = typeof resolved.error === "string" ? resolved.error : null;
  const info = typeof resolved.info === "string" ? resolved.info : null;
  const connected = resolved.connected === "1";
  const [mailbox, mirror, workspaces, homes, rules, myEmails, senders, readStatuses, identities, accounts, help, holdCalendars] = await Promise.all([
    getMailbox(user),
    mailSyncStatus(user),
    getWorkspaceChoices(),
    listAddressHomes(user).catch(() => []),
    listDomainRules(user).catch(() => []),
    getMyEmails(user),
    listSenders(user),
    readStatusesOn(user),
    listIdentities(user).catch(() => []),
    composeAccounts(user).catch(() => []),
    mailHelpSettings(user).catch(() => ({ prepareReplies: true, autoRemindDays: 3, coldPitches: "off" as const })),
    listHoldCalendars(user).catch(() => []),
  ]);
  const live = mailbox?.status === "connected";
  const calendar = live ? await getCalendarStatus(user) : null;
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  const sources = accounts.filter((account) => !account.identityId).map((account) => ({ id: account.id, email: account.email }));
  const allSenders = [
    ...senders,
    ...accounts
      .filter((account) => account.identityId)
      .map((account) => ({ id: account.id, email: account.email, label: account.email, primary: false, signature: account.signature })),
  ];
  const multi = workspaces.length > 1;
  return (
    <SettingsPage title="Email" description="Your mailboxes, the addresses you send from, signatures and help with replies.">
      <SettingsNotices notice={notice} info={info} connected={connected} />
      {multi && (homes.length > 0 || rules.length > 0) && (
        <MailRoutingSettings homes={homes} rules={rules} workspaces={workspaces.map((item) => ({ id: item.id, name: item.name }))} />
      )}
      <MicrosoftSettings
        configured={microsoftConfigured()}
        redirectUri={microsoftRedirectUri(`${proto}://${host}`)}
        mailbox={mailbox}
        calendar={calendar}
        mirror={mirror}
      />
      <SendingAddressesSettings identities={identities} sources={sources} suggestedSource={null} holdCalendars={holdCalendars} />
      <MyEmailsSettings emails={myEmails} />
      <SignaturesSettings senders={allSenders} />
      <MailHelpSettings initial={help} />
      <ReadStatusSettings initial={readStatuses} />
    </SettingsPage>
  );
}
