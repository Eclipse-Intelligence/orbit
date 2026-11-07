import { redirect } from "next/navigation";
import { AboutYouSettings } from "@/components/crm/about-you-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { getPersonalContext } from "@/lib/crm/personal-context";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function AboutYouSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [about, workspaces] = await Promise.all([getPersonalContext(user), getWorkspaceChoices()]);
  const multi = workspaces.length > 1;
  return (
    <SettingsPage title="About you" description={multi ? `Who you are in ${user.workspaceName}.` : "Who you are and what you do."}>
      <AboutYouSettings
        about={{ jobTitle: about.jobTitle, about: about.about }}
        linkedinUrl={about.linkedinUrl}
        website={about.website}
        workspaceName={multi ? user.workspaceName : null}
      />
    </SettingsPage>
  );
}
