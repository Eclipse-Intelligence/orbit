import { redirect } from "next/navigation";
import CampaignsScreen from "@/components/campaigns/campaigns-screen";
import { getUserActor } from "@/lib/auth/user";
import { connectionStates } from "@/lib/campaigns/connections";
import { syncLine } from "@/lib/campaigns/format";
import { PROVIDER_NAMES, type CampaignProviderId } from "@/lib/campaigns/types";
import { listCampaigns } from "@/lib/crm/campaigns";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [campaigns, states] = await Promise.all([listCampaigns(user), connectionStates(user)]);
  const providers = [...new Set<CampaignProviderId>([...states.map((state) => state.provider), ...campaigns.map((campaign) => campaign.provider)])];
  const lines = providers.map((provider) => {
    const state = states.find((item) => item.provider === provider);
    const text = syncLine({ connected: Boolean(state), error: state?.lastError ?? null, syncedAt: state?.lastSyncedAt ?? null });
    return providers.length > 1 ? `${PROVIDER_NAMES[provider]}: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
  });
  return (
    <CampaignsScreen
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName, workspaceId: user.workspaceId }}
      campaigns={campaigns}
      connected={states.map((state) => state.provider)}
      syncLine={lines.length > 0 ? lines.join(" · ") : null}
      canAdmin={user.role === "owner" || user.role === "admin"}
    />
  );
}
