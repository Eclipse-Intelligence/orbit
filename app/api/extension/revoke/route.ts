import { extensionJson, extensionOptions, requireExtension } from "@/lib/extension/http";
import { revokeSelf } from "@/lib/extension/pairing";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return extensionJson(request, async () => {
    await revokeSelf(await requireExtension(request));
    return { body: { ok: true } };
  });
}

export function OPTIONS(request: Request) {
  return extensionOptions(request);
}
