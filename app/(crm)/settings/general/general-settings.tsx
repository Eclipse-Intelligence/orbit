import { redirect } from "next/navigation";
import { YouSettings } from "@/components/crm/about-you-settings";
import AccountSettings from "@/components/crm/account-settings";
import MeetingLinkSettings from "@/components/crm/meeting-link-settings";
import ShortcutSettings from "@/components/crm/shortcut-settings";
import NotificationSettings from "@/components/push/notification-settings";
import { notificationSettings } from "@/lib/mail/notify";
import { SettingsPage } from "@/components/crm/settings-ui";
import { supabaseConfigured } from "@/lib/auth/config";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { getMeetingLink } from "@/lib/crm/invites";
import { getPersonalContext } from "@/lib/crm/personal-context";

export default async function GeneralSettings() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [meetingLink, notifications, about, workspaces] = await Promise.all([
    getMeetingLink(user),
    notificationSettings(user),
    getPersonalContext(user),
    getWorkspaceChoices(),
  ]);
  return (
    <SettingsPage title="General" description="Your account and what Orbit knows about you.">
      <AccountSettings
        name={user.fullName || user.email}
        email={user.email}
        role={user.role}
        workspaceName={user.workspaceName}
        passwords={supabaseConfigured()}
      />
      <YouSettings
        you={{ linkedinUrl: about.linkedinUrl, interests: about.interests, writing: about.writing }}
        website={about.website}
        multi={workspaces.length > 1}
      />
      <NotificationSettings
        initialMail={notifications.mail}
        initialCalendarMinutes={notifications.calendarMinutes}
        initialReads={notifications.reads}
        devices={notifications.devices}
      />
      <MeetingLinkSettings meetingLink={meetingLink} />
      <ShortcutSettings />
    </SettingsPage>
  );
}
