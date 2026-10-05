import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { bulkUpsertCompanies } from "@/lib/crm/companies";
import { bulkCompanySchema, parseInput } from "@/lib/crm/validation";

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await authenticateAgent(request);
    await consumeRateLimit(actor);
    const parsed = parseInput(bulkCompanySchema, await readJson(request));
    const result = await bulkUpsertCompanies(actor, parsed.companies, {
      idempotencyKey: idempotencyKey(request),
      provenance: {
        operation: "bulk_upsert_companies",
        source: parsed.provenance?.source,
        sourceUrl: parsed.provenance?.sourceUrl,
      },
    });
    return Response.json(result.body, { status: result.status });
  });
}
