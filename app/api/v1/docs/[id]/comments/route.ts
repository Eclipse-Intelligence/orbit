import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { listCommentsFromRest } from "@/lib/docs/rest";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    return Response.json(await listCommentsFromRest(actor, id));
  });
}
