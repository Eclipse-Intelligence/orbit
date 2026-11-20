import { redirect } from "next/navigation";
import BrandSettings from "@/components/crm/brand-settings";
import BusinessDetailsSettings from "@/components/crm/business-details-settings";
import PlaybookSettings from "@/components/crm/playbook-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { getBrand } from "@/lib/crm/brand";
import { getBusinessDetails } from "@/lib/crm/business-details";
import { learnedIcp } from "@/lib/enrichment/web-checks";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function BrandSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const canEdit = user.role === "owner" || user.role === "admin";
  const [brand, learned, workspaces, business] = await Promise.all([getBrand(user), canEdit ? learnedIcp(user) : null, getWorkspaceChoices(), getBusinessDetails(user)]);
  const multi = workspaces.length > 1;
  return (
    <SettingsPage title="Brand">
      <BrandSettings brand={brand} canEdit={canEdit} learned={learned} multi={multi} />
      <BusinessDetailsSettings business={business} canEdit={canEdit} workspaceName={multi ? user.workspaceName : null} />
      <PlaybookSettings brand={brand} canEdit={canEdit} multi={multi} />
    </SettingsPage>
  );
}
