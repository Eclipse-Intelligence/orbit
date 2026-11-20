import { chatResponse } from "@/lib/chat/http";
import { getMessages } from "@/lib/crm/chat-quotes";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return chatResponse("Couldn't load the message. Try again.", (actor) => getMessages(actor, new URL(request.url).searchParams.getAll("id")));
}
