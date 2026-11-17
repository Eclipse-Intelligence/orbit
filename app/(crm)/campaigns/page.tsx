import { redirect } from "next/navigation";
import CampaignsScreen from "@/components/campaigns/campaigns-screen";
import { getUserActor } from "@/lib/auth/user";
import { connectionStates } from "@/lib/campaigns/connections";
import { campaignsSyncLine } from "@/lib/campaigns/format";
import { listCampaigns } from "@/lib/crm/campaigns";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [campaigns, states] = await Promise.all([listCampaigns(user), connectionStates(user)]);
  return (
    <CampaignsScreen
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName, workspaceId: user.workspaceId }}
      campaigns={campaigns}
      connected={states.map((state) => state.provider)}
      syncLine={campaignsSyncLine(states, campaigns.map((campaign) => campaign.provider))}
      canAdmin={user.role === "owner" || user.role === "admin"}
    />
  );
}
