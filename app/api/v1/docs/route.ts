import { requireAgent } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { createDocFromBody, listDocsFromQuery } from "@/lib/docs/rest";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    return Response.json(await listDocsFromQuery(actor, new URL(request.url).searchParams));
  });
}

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    return Response.json(await createDocFromBody(actor, await readJson(request)), { status: 201 });
  });
}
