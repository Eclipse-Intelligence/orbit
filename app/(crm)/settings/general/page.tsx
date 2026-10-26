import { redirect } from "next/navigation";
import AboutYouSettings from "@/components/crm/about-you-settings";
import AccountSettings from "@/components/crm/account-settings";
import MeetingLinkSettings from "@/components/crm/meeting-link-settings";
import MyEmailsSettings from "@/components/crm/my-emails-settings";
import ShortcutSettings from "@/components/crm/shortcut-settings";
import NotificationSettings from "@/components/push/notification-settings";
import { notificationSettings } from "@/lib/mail/notify";
import SettingsHashRedirect from "@/components/crm/settings-hash-redirect";
import { SettingsPage } from "@/components/crm/settings-ui";
import { supabaseConfigured } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import { getMeetingLink } from "@/lib/crm/invites";
import { getPersonalContext } from "@/lib/crm/personal-context";
import { getMyEmails } from "@/lib/crm/profile";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function GeneralSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [myEmails, meetingLink, notifications, about] = await Promise.all([
    getMyEmails(user),
    getMeetingLink(user),
    notificationSettings(user),
    getPersonalContext(user),
  ]);
  return (
    <SettingsPage
      title="General"
      description="Your account, what the assistant knows about you, the addresses Orbit treats as you, notifications, your meeting link and keyboard shortcuts."
    >
      <SettingsHashRedirect />
      <AccountSettings
        name={user.fullName || user.email}
        email={user.email}
        role={user.role}
        workspaceName={user.workspaceName}
        passwords={supabaseConfigured()}
      />
      <AboutYouSettings
        initial={{
          jobTitle: about.jobTitle,
          about: about.about,
          interests: about.interests,
          writing: about.writing,
          linkedinUrl: about.linkedinUrl,
          websiteUrl: about.websiteUrl,
        }}
      />
      <MyEmailsSettings emails={myEmails} />
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
