import { chatResponse, limitParam, searchParam } from "@/lib/chat/http";
import type { ChatSubject } from "@/lib/chat/types";
import { CrmError } from "@/lib/crm/errors";
import { getDiscussion } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const given: ChatSubject[] = [];
  const task = searchParam(request, "task");
  const doc = searchParam(request, "doc");
  const share = searchParam(request, "mail_thread") ?? searchParam(request, "share");
  if (task) given.push({ kind: "task", id: task });
  if (doc) given.push({ kind: "doc", id: doc });
  if (share) given.push({ kind: "mail_thread", id: share });
  return chatResponse("Couldn't load the discussion. Try again.", async (actor) => {
    if (given.length === 0) throw new CrmError("invalid_input", "Give a task, a doc or a shared email.", 400);
    if (given.length > 1) throw new CrmError("invalid_input", "Give one task, doc or shared email.", 400);
    return getDiscussion(actor, given[0], {
      before: searchParam(request, "before"),
      limit: limitParam(request),
    });
  });
}
