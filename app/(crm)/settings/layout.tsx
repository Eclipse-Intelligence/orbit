import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import SettingsShell from "@/components/crm/settings-shell";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const workspaces = await getWorkspaceChoices();
  return (
    <SettingsShell
      workspace={{ id: user.workspaceId, name: user.workspaceName }}
      multi={workspaces.length > 1}
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
    >
      {children}
    </SettingsShell>
  );
}
