import { withApi } from "@/lib/api/http";
import { NO_STORE, requireCompanion } from "@/lib/companion/http";
import { checkCompanionJob } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const auth = await requireCompanion(request);
    const { id } = await context.params;
    await checkCompanionJob(auth, id);
    return Response.json({ ok: true }, { headers: NO_STORE });
  });
}
