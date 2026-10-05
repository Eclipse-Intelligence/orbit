import { requireAgent } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { recordCommunication } from "@/lib/crm/communications";
import { communicationSchema, parseInput } from "@/lib/crm/validation";

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(communicationSchema, await readJson(request));
    const result = await recordCommunication(actor, {
      kind: parsed.kind,
      title: parsed.title,
      body: parsed.body,
      occurredAt: parsed.occurredAt,
      participantEmails: parsed.participantEmails,
      companyId: parsed.companyId,
      contactId: parsed.contactId,
    });
    return Response.json(result, { status: 201 });
  });
}
