import { requireAgent } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { deleteCommentFromRest, resolveFromBody } from "@/lib/docs/rest";

type Context = { params: Promise<{ id: string; commentId: string }> };

export async function PATCH(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id, commentId } = await context.params;
    return Response.json(await resolveFromBody(actor, id, commentId, await readJson(request)));
  });
}

export async function DELETE(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id, commentId } = await context.params;
    return Response.json(await deleteCommentFromRest(actor, id, commentId, await readJson(request)));
  });
}
