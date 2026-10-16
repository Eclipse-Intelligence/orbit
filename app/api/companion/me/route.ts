import { withApi } from "@/lib/api/http";
import { NO_STORE, requireCompanion } from "@/lib/companion/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApi(async () => {
    const auth = await requireCompanion(request);
    return Response.json(
      { companionId: auth.companionId, name: auth.name, email: auth.actor.email, workspace: auth.actor.workspaceName },
      { headers: NO_STORE },
    );
  });
}
