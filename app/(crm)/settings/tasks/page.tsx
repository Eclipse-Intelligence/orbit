import { redirect } from "next/navigation";
import { SettingsPage } from "@/components/crm/settings-ui";
import TaskPrepareSettings from "@/components/crm/task-prepare-settings";
import { getUserActor } from "@/lib/auth/user";
import { taskPrepareSettings } from "@/lib/crm/task-prepare";

export const dynamic = "force-dynamic";

export default async function TaskSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const settings = await taskPrepareSettings(user).catch(() => ({ prepareEachMorning: true }));
  return (
    <SettingsPage title="Tasks">
      <TaskPrepareSettings initial={settings} />
    </SettingsPage>
  );
}
