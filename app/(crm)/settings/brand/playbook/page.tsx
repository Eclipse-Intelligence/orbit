import { redirect } from "next/navigation";
import PlaybookSettings from "@/components/crm/playbook-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { getBrand } from "@/lib/crm/brand";

export const dynamic = "force-dynamic";

export default async function PlaybookSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const brand = await getBrand(user);
  return (
    <SettingsPage
      title="Cold email playbook"
      description={`How the assistant researches prospects and writes first emails in ${user.workspaceName}, and what it may say about what you sell.`}
    >
      <PlaybookSettings brand={brand} canEdit={user.role === "owner" || user.role === "admin"} />
    </SettingsPage>
  );
}
