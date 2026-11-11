import { redirect } from "next/navigation";
import { ProfileSettings, YouSettings } from "@/components/crm/about-you-settings";
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
  const you = { linkedinUrl: about.linkedinUrl, interests: about.interests, writing: about.writing };
  return (
    <SettingsPage title="General">
      <AccountSettings
        name={user.fullName || user.email}
        email={user.email}
        role={user.role}
        workspaceName={user.workspaceName}
        passwords={supabaseConfigured()}
      />
      {workspaces.length > 1 ? (
        <YouSettings you={you} website={about.website} />
      ) : (
        <ProfileSettings about={{ jobTitle: about.jobTitle, about: about.about }} you={you} website={about.website} />
      )}
      <NotificationSettings
        initialMail={notifications.mail}
        initialCalendarMinutes={notifications.calendarMinutes}
        initialReads={notifications.reads}
        initialTeam={notifications.team}
      />
      <MeetingLinkSettings meetingLink={meetingLink} />
      <ShortcutSettings />
    </SettingsPage>
  );
}
