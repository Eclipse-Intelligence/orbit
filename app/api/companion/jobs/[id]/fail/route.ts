import { continueAfterCompanionLater } from "@/lib/agent-mail/jobs";
import { withApi } from "@/lib/api/http";
import { NO_STORE, readObject, requireCompanionJob } from "@/lib/companion/http";
import { failCompanionJob } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const { id } = await context.params;
    const auth = await requireCompanionJob(request, id);
    const body = await readObject(request, 20_000);
    await failCompanionJob(auth, id, body.error);
    continueAfterCompanionLater(auth.actor, id);
    return Response.json({ ok: true }, { headers: NO_STORE });
  });
}
