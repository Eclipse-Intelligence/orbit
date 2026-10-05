import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { upsertContact } from "@/lib/crm/contacts";
import { contactMutationSchema, parseInput, takeProvenance } from "@/lib/crm/validation";

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(contactMutationSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "upsert_contact");
    const result = await upsertContact(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}
