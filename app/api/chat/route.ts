import { chatResponse } from "@/lib/chat/http";
import { listConversations } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET() {
  return chatResponse("Couldn't load Chat. Try again.", (actor) => listConversations(actor));
}
