import { chatResponse, searchParam } from "@/lib/chat/http";
import { listChatPeople } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return chatResponse("Couldn't load people. Try again.", async (actor) => ({ people: await listChatPeople(actor, { workspaceId: searchParam(request, "workspace") }) }));
}
