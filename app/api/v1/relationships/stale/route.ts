import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { findStaleRelationships } from "@/lib/crm/relationships";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const params = new URL(request.url).searchParams;
    const days = Number(params.get("days") ?? "21");
    const limit = Number(params.get("limit") ?? "50");
    return Response.json({
      data: await findStaleRelationships(
        actor,
        Number.isFinite(days) ? days : 21,
        Number.isFinite(limit) ? limit : 50,
      ),
    });
  });
}
