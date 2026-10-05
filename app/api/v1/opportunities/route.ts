import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { createOpportunity, listOpportunities } from "@/lib/crm/opportunities";
import {
  opportunityMutationSchema,
  opportunityQueryFromSearchParams,
  parseInput,
  takeProvenance,
} from "@/lib/crm/validation";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const url = new URL(request.url);
    return Response.json(
      await listOpportunities(actor, opportunityQueryFromSearchParams(url.searchParams)),
    );
  });
}

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(opportunityMutationSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "create_opportunity");
    const result = await createOpportunity(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}
