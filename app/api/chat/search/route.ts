import { chatResponse, limitParam, searchParam } from "@/lib/chat/http";
import { searchChat } from "@/lib/crm/chat-search";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return chatResponse("Couldn't search. Try again.", (actor) =>
    searchChat(actor, {
      text: searchParam(request, "q"),
      in: searchParam(request, "in"),
      from: searchParam(request, "from"),
      hasFile: searchParam(request, "file"),
      after: searchParam(request, "after"),
      before: searchParam(request, "before"),
      cursor: searchParam(request, "cursor"),
      limit: limitParam(request),
    }),
  );
}
