import { mailResponse } from "@/app/api/mail/respond";
import { getThread } from "@/lib/mail/threads";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  return mailResponse((actor) => getThread(actor, key));
}
