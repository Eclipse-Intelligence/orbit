import { redirect } from "next/navigation";
import AccountSettings from "@/components/crm/account-settings";
import MeetingLinkSettings from "@/components/crm/meeting-link-settings";
import MyEmailsSettings from "@/components/crm/my-emails-settings";
import SettingsHashRedirect from "@/components/crm/settings-hash-redirect";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { getMeetingLink } from "@/lib/crm/invites";
import { getMyEmails } from "@/lib/crm/profile";

export const dynamic = "force-dynamic";

export default async function GeneralSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [myEmails, meetingLink] = await Promise.all([
    getMyEmails(user),
    getMeetingLink(user),
  ]);
  return (
    <SettingsPage
      title="General"
      description="Your account, the addresses Orbit treats as you, and your meeting link."
    >
      <SettingsHashRedirect />
      <AccountSettings
        name={user.fullName || user.email}
        email={user.email}
        role={user.role}
        workspaceName={user.workspaceName}
      />
      <MyEmailsSettings emails={myEmails} />
      <MeetingLinkSettings meetingLink={meetingLink} />
    </SettingsPage>
  );
}
