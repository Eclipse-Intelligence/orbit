import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { archiveTask, getTask, updateTask } from "@/lib/crm/tasks";
import { parseInput, takeProvenance, taskMutationSchema } from "@/lib/crm/validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    return Response.json({ task: await getTask(actor, id) });
  });
}

export async function PATCH(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const parsed = parseInput(taskMutationSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "update_task");
    const result = await updateTask(actor, id, write, {
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
    const result = await archiveTask(actor, id, {
      idempotencyKey: idempotencyKey(request),
      provenance: { operation: "archive_task" },
    });
    return Response.json(result.body, { status: result.status });
  });
}
