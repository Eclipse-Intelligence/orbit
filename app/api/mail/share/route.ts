import { mailResponse } from "@/app/api/mail/respond";
import { getThreadShare } from "@/lib/mail/shares";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const thread = new URL(request.url).searchParams.get("thread") ?? "";
  return mailResponse((actor) => getThreadShare(actor, thread));
}
