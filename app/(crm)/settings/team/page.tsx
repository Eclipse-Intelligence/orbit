import { redirect } from "next/navigation";
import TeamSettings from "@/components/crm/team-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { getMailbox } from "@/lib/crm/inbox";
import { getTeam } from "@/lib/crm/team";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [team, mailbox] = await Promise.all([getTeam(user), getMailbox(user)]);
  return (
    <SettingsPage title="Team" description="Who's in this workspace, what they can do, and inviting someone new.">
      <TeamSettings
        team={team}
        viewerId={user.userId}
        viewerRole={user.role}
        mailboxConnected={mailbox?.status === "connected"}
      />
    </SettingsPage>
  );
}
