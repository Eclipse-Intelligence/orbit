import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { archiveContact, getContact, updateContact } from "@/lib/crm/contacts";
import { contactMutationSchema, parseInput, takeProvenance } from "@/lib/crm/validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    return Response.json({ contact: await getContact(actor, id) });
  });
}

export async function PATCH(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const parsed = parseInput(contactMutationSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "update_contact");
    const result = await updateContact(actor, id, write, {
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
    const result = await archiveContact(actor, id, {
      idempotencyKey: idempotencyKey(request),
      provenance: { operation: "archive_contact" },
    });
    return Response.json(result.body, { status: result.status });
  });
}
