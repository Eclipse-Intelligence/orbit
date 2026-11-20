import { chatResponse } from "@/lib/chat/http";
import { listSavedIds } from "@/lib/crm/chat-saved";

export const dynamic = "force-dynamic";

export async function GET() {
  return chatResponse("Couldn't load saved messages. Try again.", (actor) => listSavedIds(actor));
}
