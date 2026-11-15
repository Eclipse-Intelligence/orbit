import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { detailOfTask } from "@/lib/crm/task-detail";
import { CrmError } from "@/lib/crm/errors";
import { archiveTask, getTask } from "@/lib/crm/tasks";
import { isDayKey } from "@/lib/task-repeat";
import { updateTaskFromApi } from "@/lib/crm/task-series";
import { OCCURS_ON_DAY, parseInput, takeProvenance, taskUpdateSchema } from "@/lib/crm/validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const task = await getTask(actor, id);
    return Response.json({ task, detail: await detailOfTask(actor, task) });
  });
}

export async function PATCH(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const parsed = parseInput(taskUpdateSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "update_task");
    const result = await updateTaskFromApi(actor, { taskId: id, occursOn: write.occursOn }, write, {
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
    const occursOn = new URL(request.url).searchParams.get("occursOn");
    if (occursOn !== null && !isDayKey(occursOn)) throw new CrmError("invalid_input", OCCURS_ON_DAY, 400, { field: "occursOn" });
    const result = await archiveTask(actor, id, {
      idempotencyKey: idempotencyKey(request),
      provenance: { operation: "archive_task" },
      ...(occursOn !== null ? { expect: occursOn } : {}),
    });
    return Response.json(result.body, { status: result.status });
  });
}
