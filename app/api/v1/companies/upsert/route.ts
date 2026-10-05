import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { upsertCompany } from "@/lib/crm/companies";
import {
  companyMutationSchema,
  parseInput,
  splitProvenance,
} from "@/lib/crm/validation";

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await authenticateAgent(request);
    await consumeRateLimit(actor);
    const parsed = parseInput(companyMutationSchema, await readJson(request));
    const { write, provenance } = splitProvenance(parsed);
    const result = await upsertCompany(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance: {
        operation: "upsert_company",
        source: provenance?.source,
        sourceUrl: provenance?.sourceUrl,
      },
    });
    return Response.json(result.body, { status: result.status });
  });
}
