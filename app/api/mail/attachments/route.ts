import { mailResponse } from "@/app/api/mail/respond";
import { listMailAttachments } from "@/lib/mail/attachments";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("message") ?? "";
  return mailResponse(async (actor) => ({ attachments: await listMailAttachments(actor, id) }));
}
