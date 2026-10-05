import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { createCompany, listCompanies } from "@/lib/crm/companies";
import {
  companyMutationSchema,
  companyQueryFromSearchParams,
  parseInput,
  splitProvenance,
} from "@/lib/crm/validation";

async function principal(request: Request) {
  const actor = await authenticateAgent(request);
  await consumeRateLimit(actor);
  return actor;
}

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await principal(request);
    const url = new URL(request.url);
    const result = await listCompanies(
      actor,
      companyQueryFromSearchParams(url.searchParams),
    );
    return Response.json(result);
  });
}

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await principal(request);
    const parsed = parseInput(companyMutationSchema, await readJson(request));
    const { write, provenance } = splitProvenance(parsed);
    const result = await createCompany(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance: {
        operation: "create_company",
        source: provenance?.source,
        sourceUrl: provenance?.sourceUrl,
      },
    });
    return Response.json(result.body, { status: result.status });
  });
}
