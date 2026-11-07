import { redirect } from "next/navigation";
import { MemoriesCard } from "@/components/crm/learning-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { listMemories } from "@/lib/learning/memories";

export const dynamic = "force-dynamic";

export default async function MemorySettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [personal, workspaces] = await Promise.all([
    listMemories(user, { scope: "personal", limit: 200, allWorkspaces: true }),
    getWorkspaceChoices(),
  ]);
  return (
    <SettingsPage title="Memory" description="What Orbit has learned about you: your preferences, corrections and how you work.">
      <MemoriesCard
        id="memory"
        heading="Notes about you"
        scopes={["personal"]}
        memories={{ personal }}
        workspaceName={user.workspaceName}
        manyWorkspaces={workspaces.length > 1}
      />
    </SettingsPage>
  );
}
