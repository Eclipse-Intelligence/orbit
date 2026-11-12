import { mailResponse } from "@/app/api/mail/respond";
import { getThreadShare, getThreadSharePeople } from "@/lib/mail/shares";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const thread = params.get("thread") ?? "";
  return mailResponse((actor) => (params.get("people") === "1" ? getThreadSharePeople(actor, thread) : getThreadShare(actor, thread)));
}
