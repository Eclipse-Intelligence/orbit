import { chatResponse, limitParam, searchParam } from "@/lib/chat/http";
import { getDiscussion } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const task = searchParam(request, "task");
  const doc = searchParam(request, "doc");
  return chatResponse("Couldn't load the discussion. Try again.", (actor) =>
    getDiscussion(actor, task ? { kind: "task", id: task } : { kind: "doc", id: doc }, {
      before: searchParam(request, "before"),
      limit: limitParam(request),
    }),
  );
}
