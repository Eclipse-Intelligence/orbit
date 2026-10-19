import { mailResponse } from "@/app/api/mail/respond";
import { suggestRecipients } from "@/lib/mail/people";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const text = new URL(request.url).searchParams.get("q") ?? "";
  return mailResponse(async (actor) => ({ people: await suggestRecipients(actor, text) }));
}
