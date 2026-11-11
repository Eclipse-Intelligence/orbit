import { chatResponse, limitParam, searchParam, type ChatRouteContext } from "@/lib/chat/http";
import { searchMessages } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: ChatRouteContext) {
  const { id } = await context.params;
  return chatResponse("Couldn't search. Try again.", (actor) => searchMessages(actor, id, searchParam(request, "q"), { limit: limitParam(request) }));
}
