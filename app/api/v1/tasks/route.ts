import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { createTask, listTasks } from "@/lib/crm/tasks";
import {
  parseInput,
  takeProvenance,
  taskMutationSchema,
  taskQueryFromSearchParams,
} from "@/lib/crm/validation";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const url = new URL(request.url);
    return Response.json(await listTasks(actor, taskQueryFromSearchParams(url.searchParams)));
  });
}

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(taskMutationSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "create_task");
    const result = await createTask(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}
