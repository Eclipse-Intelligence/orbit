import { redirect } from "next/navigation";
import TeamSettings from "@/components/crm/team-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { getMailbox } from "@/lib/crm/inbox";
import { getTeam } from "@/lib/crm/team";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [team, mailbox, workspaces] = await Promise.all([getTeam(user), getMailbox(user), getWorkspaceChoices()]);
  const connected = mailbox?.status === "connected";
  return (
    <SettingsPage title="Team">
      <TeamSettings
        team={team}
        workspaceName={user.workspaceName}
        otherWorkspaces={workspaces.filter((item) => item.id !== user.workspaceId).map((item) => item.name)}
        mailboxEmail={connected ? (mailbox?.email ?? null) : null}
        viewerId={user.userId}
        viewerRole={user.role}
        mailboxConnected={connected}
      />
    </SettingsPage>
  );
}
