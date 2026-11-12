import { isUuid } from "@/lib/crm/mutate";
import { completeTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { actorForTask } from "@/lib/crm/workspaces";

const MAX_IDS = 50;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return host === (forwarded || request.headers.get("host") || new URL(request.url).host);
}

async function readIds(request: Request) {
  try {
    const body = JSON.parse(await request.text()) as { ids?: unknown };
    if (!Array.isArray(body?.ids)) return null;
    const ids = [...new Set(body.ids.filter((id): id is string => typeof id === "string" && isUuid(id)).map((id) => id.toLowerCase()))];
    return ids.length > 0 && ids.length <= MAX_IDS ? ids : null;
  } catch {
    return null;
  }
}

export async function completeTasksFromBeacon(request: Request, actor: UserActor | null) {
  if (!actor) return { status: 401, body: { error: "Your session ended. Sign in again." }, completed: [] as string[] };
  if (!sameOrigin(request)) return { status: 403, body: { error: "Couldn't mark the task done. Try again." }, completed: [] as string[] };
  const ids = await readIds(request);
  if (!ids) return { status: 400, body: { error: "Couldn't mark the task done. Try again." }, completed: [] as string[] };
  const completed: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await completeTask(await actorForTask(actor, id), id, { provenance: { operation: "complete_task", source: "web" } });
      completed.push(id);
    } catch {
      failed.push(id);
    }
  }
  return { status: 200, body: { completed, failed }, completed };
}
