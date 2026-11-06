import { extensionJson, extensionOptions, limitPairing, orbitUrl } from "@/lib/extension/http";
import { startPairing } from "@/lib/extension/pairing";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return extensionJson(request, async () => {
    await limitPairing(request, "start");
    return { body: await startPairing(orbitUrl(request)) };
  });
}

export function OPTIONS(request: Request) {
  return extensionOptions(request);
}
