import { mailResponse } from "@/app/api/mail/respond";
import { getSharedThread } from "@/lib/mail/shares";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  return mailResponse((actor) => getSharedThread(actor, id));
}
