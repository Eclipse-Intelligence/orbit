import { chatResponse, upToBody, type ChatRouteContext } from "@/lib/chat/http";
import { markConversationRead } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: ChatRouteContext) {
  const { id } = await context.params;
  return chatResponse("Couldn't mark it read. Try again.", async (actor) => markConversationRead(actor, id, await upToBody(request)));
}
