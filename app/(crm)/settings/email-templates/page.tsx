import { redirect } from "next/navigation";
import { contactRecipient } from "@/lib/crm/personalise";
import EmailTemplatesSettings from "@/components/crm/email-templates-settings";
import SignaturesSettings from "@/components/crm/signatures-settings";
import ReadStatusSettings from "@/components/mail/read-status-settings";
import { listSenders } from "@/lib/crm/inbox";
import { getUserActor } from "@/lib/auth/user";
import { listContacts } from "@/lib/crm/contacts";
import { listEmailTemplates } from "@/lib/crm/email-templates";
import { readStatusesOn } from "@/lib/mail/tracking";
import SendingAddressesSettings from "@/components/mail/sending-addresses-settings";
import { composeAccounts } from "@/lib/mail/compose";
import { listIdentities } from "@/lib/mail/identities";

export const dynamic = "force-dynamic";

export default async function EmailTemplateSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [templates, contacts, senders, readStatuses, identities, accounts] = await Promise.all([
    listEmailTemplates(user),
    listContacts(user, { limit: 20 }),
    listSenders(user),
    readStatusesOn(user),
    listIdentities(user).catch(() => []),
    composeAccounts(user).catch(() => []),
  ]);
  const sources = accounts.filter((account) => !account.identityId).map((account) => ({ id: account.id, email: account.email }));
  const allSenders = [
    ...senders,
    ...accounts
      .filter((account) => account.identityId)
      .map((account) => ({ id: account.id, email: account.email, label: account.email, primary: false, signature: account.signature })),
  ];
  return (
    <EmailTemplatesSettings
      templates={templates}
      recipients={contacts.data.map(contactRecipient)}
      extra={
        <>
          <SendingAddressesSettings
            identities={identities}
            sources={sources}
            suggestedSource={null}
          />
          <SignaturesSettings senders={allSenders} />
          <ReadStatusSettings initial={readStatuses} />
        </>
      }
    />
  );
}
