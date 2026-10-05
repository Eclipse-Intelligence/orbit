import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { bulkIngestLeads } from "@/lib/crm/leads";
import { bulkLeadSchema, parseInput, takeProvenance } from "@/lib/crm/validation";

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(bulkLeadSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "bulk_ingest_leads");
    const result = await bulkIngestLeads(actor, write.leads, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}
