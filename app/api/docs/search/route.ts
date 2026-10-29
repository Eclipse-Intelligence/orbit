import { getUserActor } from "@/lib/auth/user";
import { docsReads, docsRespond } from "@/lib/docs/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await getUserActor();
  return docsRespond(actor, (signedIn) => docsReads.search({ actor: signedIn, request, params: {} }));
}
