import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { ingestLead } from "@/lib/crm/leads";
import { leadSchema, parseInput, takeProvenance } from "@/lib/crm/validation";

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(leadSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "ingest_lead");
    const result = await ingestLead(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}
