import { getUserActor } from "@/lib/auth/user";
import { docsReads, docsRespond } from "@/lib/docs/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; versionId: string }> };

export async function GET(request: Request, context: Context) {
  const [actor, params] = await Promise.all([getUserActor(), context.params]);
  return docsRespond(actor, (signedIn) => docsReads.version({ actor: signedIn, request, params }));
}
