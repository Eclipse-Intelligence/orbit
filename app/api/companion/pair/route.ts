import { withApi } from "@/lib/api/http";
import { NO_STORE, limitPairing, readObject } from "@/lib/companion/http";
import { redeemPairing } from "@/lib/companion/pairing";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApi(async () => {
    await limitPairing(request);
    const body = await readObject(request, 4_000);
    return Response.json(await redeemPairing(body.code, body.name), { headers: NO_STORE });
  });
}
