import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { prepareAllowed, prepareTask } from "@/lib/crm/task-prepare";
import { taskActorOrError } from "@/lib/crm/workspaces";
import { LlmError } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FAILED = "Couldn't prepare it. Try again.";

export async function POST(request: Request) {
  const user = await getUserActor();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { taskId?: unknown };
  const taskId = typeof body.taskId === "string" && isUuid(body.taskId) ? body.taskId : null;
  if (!taskId) return Response.json({ error: "Task not found." }, { status: 404 });
  const found = await taskActorOrError(user, taskId);
  if (!found.actor) return Response.json({ error: found.error }, { status: 404 });
  try {
    if (!(await prepareAllowed(found.actor))) return Response.json({ error: "Too many requests. Try again in a few minutes." }, { status: 429 });
    const preparation = await prepareTask(found.actor, taskId);
    return Response.json({ preparation }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ ...error.details, error: error.message }, { status: error.status });
    if (error instanceof LlmError) return Response.json({ error: error.message }, { status: 502 });
    console.error("Preparing a task failed", error instanceof Error ? error.message : error);
    return Response.json({ error: FAILED }, { status: 500 });
  }
}
