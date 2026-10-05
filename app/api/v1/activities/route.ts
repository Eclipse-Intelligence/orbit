import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { createActivity, listActivities } from "@/lib/crm/activities";
import {
  activityMutationSchema,
  activityQueryFromSearchParams,
  parseInput,
  takeProvenance,
} from "@/lib/crm/validation";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const url = new URL(request.url);
    return Response.json(await listActivities(actor, activityQueryFromSearchParams(url.searchParams)));
  });
}

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(activityMutationSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "create_activity");
    const result = await createActivity(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}
