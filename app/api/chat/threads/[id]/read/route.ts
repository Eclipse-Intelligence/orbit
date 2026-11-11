import { chatResponse, upToBody, type ChatRouteContext } from "@/lib/chat/http";
import { markThreadRead } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: ChatRouteContext) {
  const [{ id }, upTo] = await Promise.all([context.params, upToBody(request)]);
  return chatResponse("Couldn't mark the thread read. Try again.", (actor) => markThreadRead(actor, id, upTo));
}
