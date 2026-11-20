import { chatResponse } from "@/lib/chat/http";
import { cleanRecordRefs, listRecordCards } from "@/lib/crm/chat-record-cards";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return chatResponse("Couldn't load the record. Try again.", async (actor) => ({
    cards: await listRecordCards(actor, cleanRecordRefs(new URL(request.url).searchParams.getAll("ref"))),
  }));
}
