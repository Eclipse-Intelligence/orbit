import { redirect } from "next/navigation";
import { MemoriesCard } from "@/components/crm/learning-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { listMemories } from "@/lib/learning/memories";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export const dynamic = "force-dynamic";

export default async function MemorySettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const workspaces = await getWorkspaceChoices();
  if (workspaces.length <= 1) redirect(`${SETTINGS_PATHS.learning}#notes`);
  const personal = await listMemories(user, { scope: "personal", limit: 200, allWorkspaces: true });
  return (
    <SettingsPage title="Memory">
      <MemoriesCard
        id="memory"
        heading="Notes about you"
        scopes={["personal"]}
        memories={{ personal }}
        workspaceName={user.workspaceName}
        manyWorkspaces
      />
    </SettingsPage>
  );
}
