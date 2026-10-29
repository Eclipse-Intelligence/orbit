import { getUserActor } from "@/lib/auth/user";
import { docsReads, docsWrites, docsRespond } from "@/lib/docs/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const [actor, params] = await Promise.all([getUserActor(), context.params]);
  return docsRespond(actor, (signedIn) => docsReads.page({ actor: signedIn, request, params }));
}

export async function PUT(request: Request, context: Context) {
  const [actor, params] = await Promise.all([getUserActor(), context.params]);
  return docsRespond(actor, (signedIn) => docsWrites.save({ actor: signedIn, request, params }));
}
