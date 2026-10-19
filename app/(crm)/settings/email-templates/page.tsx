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

export const dynamic = "force-dynamic";

export default async function EmailTemplateSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [templates, contacts, senders, readStatuses] = await Promise.all([
    listEmailTemplates(user),
    listContacts(user, { limit: 20 }),
    listSenders(user),
    readStatusesOn(user),
  ]);
  return (
    <EmailTemplatesSettings
      templates={templates}
      recipients={contacts.data.map(contactRecipient)}
      extra={
        <>
          <SignaturesSettings senders={senders} />
          <ReadStatusSettings initial={readStatuses} />
        </>
      }
    />
  );
}
