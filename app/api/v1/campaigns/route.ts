import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { campaignChannel, listCampaigns } from "@/lib/crm/campaigns";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const channel = campaignChannel(new URL(request.url).searchParams.get("channel")?.trim());
    return Response.json({ campaigns: await listCampaigns(actor, { channel }) });
  });
}
