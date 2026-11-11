import { chatResponse, upToBody, type ChatRouteContext } from "@/lib/chat/http";
import { markConversationRead } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: ChatRouteContext) {
  const [{ id }, upTo] = await Promise.all([context.params, upToBody(request)]);
  return chatResponse("Couldn't mark it read. Try again.", (actor) => markConversationRead(actor, id, upTo));
}
