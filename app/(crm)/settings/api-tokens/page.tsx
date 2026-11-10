import { headers } from "next/headers";
import { redirect } from "next/navigation";
import IphoneShortcutSettings from "@/components/crm/iphone-shortcut-settings";
import PersonalTokenSettings from "@/components/crm/personal-token-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { listPersonalTokens } from "@/lib/auth/personal";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

export default async function ApiTokensSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [tokens, workspaces, headerStore] = await Promise.all([listPersonalTokens(user).catch(() => []), getWorkspaceChoices(), headers()]);
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  const origin = `${headerStore.get("x-forwarded-proto") ?? "http"}://${host}`;
  const workspaceName = workspaces.length > 1 ? user.workspaceName : null;
  return (
    <SettingsPage title="API tokens">
      <PersonalTokenSettings origin={origin} initial={tokens} workspaceName={workspaceName} />
      <IphoneShortcutSettings origin={origin} workspaceName={workspaceName} />
    </SettingsPage>
  );
}
