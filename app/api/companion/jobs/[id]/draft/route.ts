import { withApi } from "@/lib/api/http";
import { NO_STORE, requireCompanionJob } from "@/lib/companion/http";
import { saveCompanionDraft } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const { id } = await context.params;
    const auth = await requireCompanionJob(request, id);
    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    await saveCompanionDraft(auth, id, body.text);
    return Response.json({ ok: true }, { headers: NO_STORE });
  });
}
