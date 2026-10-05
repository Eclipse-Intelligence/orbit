import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { archiveWebhook } from "@/lib/crm/webhooks";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    await archiveWebhook(actor, id);
    return Response.json({ archived: true });
  });
}
