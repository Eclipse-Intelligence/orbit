import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { archiveCompany, getCompany, updateCompany } from "@/lib/crm/companies";
import {
  companyMutationSchema,
  parseInput,
  splitProvenance,
} from "@/lib/crm/validation";

type Context = { params: Promise<{ id: string }> };

async function principal(request: Request) {
  const actor = await authenticateAgent(request);
  await consumeRateLimit(actor);
  return actor;
}

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await principal(request);
    const { id } = await context.params;
    const company = await getCompany(actor, id);
    return Response.json({ company });
  });
}

export async function PATCH(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await principal(request);
    const { id } = await context.params;
    const parsed = parseInput(companyMutationSchema, await readJson(request));
    const { write, provenance } = splitProvenance(parsed);
    const result = await updateCompany(actor, id, write, {
      idempotencyKey: idempotencyKey(request),
      provenance: {
        operation: "update_company",
        source: provenance?.source,
        sourceUrl: provenance?.sourceUrl,
      },
    });
    return Response.json(result.body, { status: result.status });
  });
}

export async function DELETE(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await principal(request);
    const { id } = await context.params;
    const result = await archiveCompany(actor, id, {
      idempotencyKey: idempotencyKey(request),
      provenance: { operation: "archive_company" },
    });
    return Response.json(result.body, { status: result.status });
  });
}
