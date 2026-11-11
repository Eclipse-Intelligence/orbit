import { chatResponse, limitParam, searchParam } from "@/lib/chat/http";
import { listThreads } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return chatResponse("Couldn't load threads. Try again.", (actor) => listThreads(actor, { cursor: searchParam(request, "cursor"), limit: limitParam(request) }));
}
