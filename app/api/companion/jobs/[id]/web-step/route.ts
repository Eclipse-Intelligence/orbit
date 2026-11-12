import { withApi } from "@/lib/api/http";
import { NO_STORE, readObject, requireCompanionJob } from "@/lib/companion/http";
import { addCompanionWebStep } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const { id } = await context.params;
    const auth = await requireCompanionJob(request, id);
    await addCompanionWebStep(auth, id, await readObject(request, 2_000));
    return Response.json({ ok: true }, { headers: NO_STORE });
  });
}
