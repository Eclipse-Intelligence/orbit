import { requireAgent, requireCaller } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { CrmError } from "@/lib/crm/errors";
import { closeTaskFromOffer } from "@/lib/crm/task-done";
import { completeTask } from "@/lib/crm/tasks";

type Context = { params: Promise<{ id: string }> };

function activityIdOf(body: unknown) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new CrmError("invalid_input", "Request body must be a JSON object.", 400);
  const value = (body as Record<string, unknown>).activityId;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CrmError("invalid_input", "activityId must be an activity id from looksDone.", 400, { field: "activityId" });
  return value;
}

export async function POST(request: Request, context: Context) {
  return withApi(async () => {
    const { id } = await context.params;
    const activityId = activityIdOf(await readJson(request));
    if (activityId !== null) {
      const actor = await requireCaller(request);
      const closed = await closeTaskFromOffer(actor, id, { activityId, idempotencyKey: idempotencyKey(request) });
      return Response.json({ task: closed.task, activityId: closed.activityId });
    }
    const actor = await requireAgent(request);
    const result = await completeTask(actor, id, {
      idempotencyKey: idempotencyKey(request),
      provenance: { operation: "complete_task" },
    });
    return Response.json(result.body, { status: result.status });
  });
}
