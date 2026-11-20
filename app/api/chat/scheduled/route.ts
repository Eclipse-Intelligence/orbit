import { chatResponse } from "@/lib/chat/http";
import { listScheduled } from "@/lib/crm/chat-scheduled";

export const dynamic = "force-dynamic";

export async function GET() {
  return chatResponse("Couldn't load scheduled messages. Try again.", (actor) => listScheduled(actor));
}
