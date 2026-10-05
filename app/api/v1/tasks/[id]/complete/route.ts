import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, withApi } from "@/lib/api/http";
import { completeTask } from "@/lib/crm/tasks";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const result = await completeTask(actor, id, {
      idempotencyKey: idempotencyKey(request),
      provenance: { operation: "complete_task" },
    });
    return Response.json(result.body, { status: result.status });
  });
}
