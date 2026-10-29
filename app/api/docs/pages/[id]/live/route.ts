import { getUserActor } from "@/lib/auth/user";
import { docsReads, docsRespond, docsWrites } from "@/lib/docs/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const [actor, params] = await Promise.all([getUserActor(), context.params]);
  return docsRespond(actor, (signedIn) => docsReads.live({ actor: signedIn, request, params }));
}

export async function POST(request: Request, context: Context) {
  const [actor, params] = await Promise.all([getUserActor(), context.params]);
  return docsRespond(actor, (signedIn) => docsWrites.liveSync({ actor: signedIn, request, params }));
}
