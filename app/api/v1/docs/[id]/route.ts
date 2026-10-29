import { requireAgent } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { archiveDocById, patchDocFromBody, readDocFromQuery } from "@/lib/docs/rest";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    return Response.json(await readDocFromQuery(actor, id, new URL(request.url).searchParams));
  });
}

export async function PATCH(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    return Response.json(await patchDocFromBody(actor, id, await readJson(request)));
  });
}

export async function DELETE(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    return Response.json(await archiveDocById(actor, id));
  });
}
