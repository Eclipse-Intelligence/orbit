import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { createContact, listContacts } from "@/lib/crm/contacts";
import {
  contactMutationSchema,
  contactQueryFromSearchParams,
  parseInput,
  takeProvenance,
} from "@/lib/crm/validation";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const url = new URL(request.url);
    return Response.json(await listContacts(actor, contactQueryFromSearchParams(url.searchParams)));
  });
}

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(contactMutationSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "create_contact");
    const result = await createContact(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}
