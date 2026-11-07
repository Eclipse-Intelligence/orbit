import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { findStaleRelationships } from "@/lib/crm/relationships";
import { integerParam } from "@/lib/crm/validation";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const params = new URL(request.url).searchParams;
    const days = integerParam(params, "days") ?? 21;
    const limit = integerParam(params, "limit") ?? 50;
    return Response.json({ data: await findStaleRelationships(actor, days, limit) });
  });
}
