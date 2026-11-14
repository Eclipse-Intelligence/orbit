import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { listTasks } from "@/lib/crm/tasks";
import { createTaskFromApi } from "@/lib/crm/task-series";
import {
  parseInput,
  takeProvenance,
  taskCreateSchema,
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
    const parsed = parseInput(taskCreateSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "create_task");
    const result = await createTaskFromApi(actor, write, {
      idempotencyKey: idempotencyKey(request),
      provenance,
    });
    return Response.json(result.body, { status: result.status });
  });
}
