import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { getDueActions } from "@/lib/crm/relationships";
import { TASK_VIEWS, type TaskView } from "@/lib/crm/types";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const view = new URL(request.url).searchParams.get("view") ?? "today";
    const selected = (TASK_VIEWS as readonly string[]).includes(view) ? (view as TaskView) : "today";
    return Response.json(await getDueActions(actor, selected));
  });
}
