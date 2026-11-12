import { mailResponse } from "@/app/api/mail/respond";
import { getSharedDraft, readSharedText, saveSharedDraft } from "@/lib/mail/shared-drafts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  return mailResponse((actor) => getSharedDraft(actor, id));
}

export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  return mailResponse((actor) => saveSharedDraft(actor, id, readSharedText(body)));
}
