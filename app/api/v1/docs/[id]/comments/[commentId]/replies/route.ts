import { requireAgent } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { replyFromBody } from "@/lib/docs/rest";

type Context = { params: Promise<{ id: string; commentId: string }> };

export async function POST(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id, commentId } = await context.params;
    return Response.json(await replyFromBody(actor, id, commentId, await readJson(request)), { status: 201 });
  });
}
