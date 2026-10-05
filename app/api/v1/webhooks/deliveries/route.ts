import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { listWebhookDeliveries } from "@/lib/crm/webhooks";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    return Response.json({ data: await listWebhookDeliveries(actor) });
  });
}
