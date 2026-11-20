import { getUserActor } from "@/lib/auth/user";
import { searchParam, type ChatRouteContext } from "@/lib/chat/http";
import { chatFileLink } from "@/lib/crm/chat-attachments";
import { CrmError } from "@/lib/crm/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: ChatRouteContext) {
  const { id } = await context.params;
  try {
    const actor = await getUserActor();
    if (!actor) return Response.json({ error: "Your session ended. Sign in again." }, { status: 401 });
    const location = await chatFileLink(actor, id, { download: searchParam(request, "download") === "1" });
    return new Response(null, { status: 302, headers: { location, "cache-control": "private, max-age=50", "referrer-policy": "no-referrer" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Chat file request failed", error);
    return Response.json({ error: "Couldn't open the file. Try again." }, { status: 500 });
  }
}
