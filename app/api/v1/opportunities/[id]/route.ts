import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import {
  archiveOpportunity,
  getOpportunity,
  updateOpportunity,
} from "@/lib/crm/opportunities";
import {
  opportunityMutationSchema,
  parseInput,
  takeProvenance,
} from "@/lib/crm/validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    return Response.json({ opportunity: await getOpportunity(actor, id) });
  });
}

export async function PATCH(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const parsed = parseInput(opportunityMutationSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "update_opportunity");
    const result = await updateOpportunity(actor, id, write, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}

export async function DELETE(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const result = await archiveOpportunity(actor, id, {
      idempotencyKey: idempotencyKey(request),
      provenance: { operation: "archive_opportunity" },
    });
    return Response.json(result.body, { status: result.status });
  });
}
