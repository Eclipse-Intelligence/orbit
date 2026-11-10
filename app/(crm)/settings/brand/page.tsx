import { redirect } from "next/navigation";
import BrandSettings from "@/components/crm/brand-settings";
import PlaybookSettings from "@/components/crm/playbook-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { getBrand } from "@/lib/crm/brand";
import { learnedIcp } from "@/lib/enrichment/web-checks";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function BrandSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const canEdit = user.role === "owner" || user.role === "admin";
  const [brand, learned, workspaces] = await Promise.all([getBrand(user), canEdit ? learnedIcp(user) : null, getWorkspaceChoices()]);
  const multi = workspaces.length > 1;
  return (
    <SettingsPage title="Brand">
      <BrandSettings brand={brand} canEdit={canEdit} learned={learned} multi={multi} />
      <PlaybookSettings brand={brand} canEdit={canEdit} multi={multi} />
    </SettingsPage>
  );
}
