import { chatResponse, limitParam, searchParam } from "@/lib/chat/http";
import { listSaved } from "@/lib/crm/chat-saved";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return chatResponse("Couldn't load saved messages. Try again.", (actor) => listSaved(actor, { cursor: searchParam(request, "cursor"), limit: limitParam(request) }));
}
