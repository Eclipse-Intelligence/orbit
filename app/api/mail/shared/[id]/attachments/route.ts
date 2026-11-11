import { mailResponse } from "@/app/api/mail/respond";
import { listSharedAttachments } from "@/lib/mail/shares";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const message = new URL(request.url).searchParams.get("message") ?? "";
  return mailResponse(async (actor) => ({ attachments: await listSharedAttachments(actor, id, message) }));
}
