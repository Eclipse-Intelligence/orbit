import { chatResponse, limitParam, searchParam, type ChatRouteContext } from "@/lib/chat/http";
import { listMessages } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: ChatRouteContext) {
  const { id } = await context.params;
  return chatResponse("Couldn't load messages. Try again.", (actor) =>
    listMessages(actor, id, {
      before: searchParam(request, "before"),
      after: searchParam(request, "after"),
      around: searchParam(request, "around"),
      limit: limitParam(request),
    }),
  );
}
