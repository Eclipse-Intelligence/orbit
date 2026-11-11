import { chatResponse, limitParam, searchParam, type ChatRouteContext } from "@/lib/chat/http";
import { listThread } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: ChatRouteContext) {
  const { id } = await context.params;
  return chatResponse("Couldn't load the thread. Try again.", (actor) =>
    listThread(actor, id, { before: searchParam(request, "before"), after: searchParam(request, "after"), limit: limitParam(request) }),
  );
}
