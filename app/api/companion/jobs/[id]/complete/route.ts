import { withApi } from "@/lib/api/http";
import { applyCompanionResult } from "@/lib/assistant/chat";
import { NO_STORE, readObject, requireCompanion } from "@/lib/companion/http";
import { finishCompanionJob, readCompanionResult } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const auth = await requireCompanion(request);
    const { id } = await context.params;
    const result = readCompanionResult(await readObject(request, 4_000_000));
    await finishCompanionJob(auth, id, (actor, conversationId) => applyCompanionResult(actor, conversationId, result));
    return Response.json({ ok: true }, { headers: NO_STORE });
  });
}
