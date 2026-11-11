import { chatResponse, upToBody, type ChatRouteContext } from "@/lib/chat/http";
import { markThreadRead } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: ChatRouteContext) {
  const { id } = await context.params;
  return chatResponse("Couldn't mark the thread read. Try again.", async (actor) => markThreadRead(actor, id, await upToBody(request)));
}
