import { withApi } from "@/lib/api/http";
import { NO_STORE, readObject, requireCompanion } from "@/lib/companion/http";
import { runCompanionTool } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const auth = await requireCompanion(request);
    const { id } = await context.params;
    const body = await readObject(request, 200_000);
    const result = await runCompanionTool(auth, id, {
      id: typeof body.id === "string" ? body.id : "",
      name: typeof body.name === "string" ? body.name : "",
      arguments: typeof body.arguments === "string" ? body.arguments : JSON.stringify(body.arguments ?? {}),
    });
    return Response.json(result, { headers: NO_STORE });
  });
}
