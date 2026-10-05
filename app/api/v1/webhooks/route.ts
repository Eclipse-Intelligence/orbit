import { requireAgent } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { createWebhook, listWebhooks } from "@/lib/crm/webhooks";
import { parseInput, webhookSchema } from "@/lib/crm/validation";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    return Response.json({ data: await listWebhooks(actor) });
  });
}

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(webhookSchema, await readJson(request));
    const result = await createWebhook(actor, parsed);
    return Response.json(result, { status: 201 });
  });
}
