import { withApi } from "@/lib/api/http";
import { NO_STORE, readObject, requireCompanionJob } from "@/lib/companion/http";
import { runCompanionTool } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const { id } = await context.params;
    const auth = await requireCompanionJob(request, id);
    const body = await readObject(request, 200_000);
    const result = await runCompanionTool(auth, id, {
      id: typeof body.id === "string" ? body.id : "",
      name: typeof body.name === "string" ? body.name : "",
      arguments: typeof body.arguments === "string" ? body.arguments : JSON.stringify(body.arguments ?? {}),
    });
    return Response.json(result, { headers: NO_STORE });
  });
}
