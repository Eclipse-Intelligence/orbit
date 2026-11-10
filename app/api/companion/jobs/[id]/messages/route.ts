import { withApi } from "@/lib/api/http";
import { companionSteers } from "@/lib/assistant/chat";
import { NO_STORE, requireCompanionJob } from "@/lib/companion/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const { id } = await context.params;
    const auth = await requireCompanionJob(request, id);
    const messages = await companionSteers(auth, id);
    return Response.json({ messages }, { headers: NO_STORE });
  });
}
