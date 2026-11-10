import { continueAfterCompanionLater } from "@/lib/agent-mail/jobs";
import { withApi } from "@/lib/api/http";
import { applyCompanionResult, continueSteersLater } from "@/lib/assistant/chat";
import { NO_STORE, readObject, requireCompanionJob } from "@/lib/companion/http";
import { finishCompanionJob, readCompanionResult } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const { id } = await context.params;
    const auth = await requireCompanionJob(request, id);
    const result = readCompanionResult(await readObject(request, 4_000_000));
    const conversationId = await finishCompanionJob(auth, id, (actor, conversationId, switches) => applyCompanionResult(actor, conversationId, result, switches));
    continueAfterCompanionLater(auth.actor, id);
    continueSteersLater(auth.actor, conversationId);
    return Response.json({ ok: true }, { headers: NO_STORE });
  });
}
