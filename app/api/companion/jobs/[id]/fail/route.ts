import { withApi } from "@/lib/api/http";
import { NO_STORE, readObject, requireCompanion } from "@/lib/companion/http";
import { failCompanionJob } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const auth = await requireCompanion(request);
    const { id } = await context.params;
    const body = await readObject(request, 20_000);
    await failCompanionJob(auth, id, body.error);
    return Response.json({ ok: true }, { headers: NO_STORE });
  });
}
