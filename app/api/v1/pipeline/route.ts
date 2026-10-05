import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { listPipeline } from "@/lib/crm/opportunities";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    return Response.json({ pipeline: await listPipeline(actor) });
  });
}
