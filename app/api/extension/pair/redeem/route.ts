import { extensionJson, extensionOptions, limitPairing, readBody } from "@/lib/extension/http";
import { redeemPairing } from "@/lib/extension/pairing";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return extensionJson(request, async () => {
    await limitPairing(request, "redeem");
    const body = await readBody(request, 4_000);
    const result = await redeemPairing(body.code, body.secret);
    return { body: result, status: result.status === "pending" ? 202 : 200 };
  });
}

export function OPTIONS(request: Request) {
  return extensionOptions(request);
}
