import { chatResponse } from "@/lib/chat/http";
import { listUnreads } from "@/lib/crm/chat";

export const dynamic = "force-dynamic";

export async function GET() {
  return chatResponse("Couldn't load unread messages. Try again.", (actor) => listUnreads(actor));
}
