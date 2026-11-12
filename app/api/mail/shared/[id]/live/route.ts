import { getUserActor } from "@/lib/auth/user";
import { liveDraftResponse } from "@/lib/mail/live-draft-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const [actor, { id }] = await Promise.all([getUserActor(), context.params]);
  return liveDraftResponse(actor, id, request);
}

export async function POST(request: Request, context: Context) {
  const [actor, { id }] = await Promise.all([getUserActor(), context.params]);
  return liveDraftResponse(actor, id, request);
}
