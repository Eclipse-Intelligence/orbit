import { redirect } from "next/navigation";
import CampaignsScreen from "@/components/campaigns/campaigns-screen";
import { getUserActor } from "@/lib/auth/user";
import { connectedProviders } from "@/lib/campaigns/connections";
import { listCampaigns } from "@/lib/crm/campaigns";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [campaigns, providers] = await Promise.all([listCampaigns(user), connectedProviders(user)]);
  return (
    <CampaignsScreen
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName, workspaceId: user.workspaceId }}
      campaigns={campaigns}
      connected={providers.length > 0}
      canAdmin={user.role === "owner" || user.role === "admin"}
    />
  );
}
