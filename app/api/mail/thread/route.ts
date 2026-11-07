import { mailResponse } from "@/app/api/mail/respond";
import { getThread } from "@/lib/mail/threads";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const key = params.get("key") ?? "";
  return mailResponse((actor) => getThread(actor, key, { reader: true, attachments: params.get("attachments") === "1" }));
}
