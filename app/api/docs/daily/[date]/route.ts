import { getUserActor } from "@/lib/auth/user";
import { docsWrites, docsRespond } from "@/lib/docs/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ date: string }> };

export async function POST(request: Request, context: Context) {
  const [actor, params] = await Promise.all([getUserActor(), context.params]);
  return docsRespond(actor, (signedIn) => docsWrites.openDaily({ actor: signedIn, request, params }));
}
