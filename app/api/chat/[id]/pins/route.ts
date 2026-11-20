import { chatResponse, type ChatRouteContext } from "@/lib/chat/http";
import { getPins } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: ChatRouteContext) {
  const { id } = await context.params;
  return chatResponse("Couldn't load the pinned messages. Try again.", (actor) => getPins(actor, id));
}
