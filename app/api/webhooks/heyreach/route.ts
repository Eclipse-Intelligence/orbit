import { handleCampaignWebhook } from "@/lib/campaigns/webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleCampaignWebhook(request, "heyreach");
}
