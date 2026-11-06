import { capture } from "@/lib/extension/capture";
import { extensionJson, extensionOptions, readBody, requireExtensionActor } from "@/lib/extension/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return extensionJson(request, async () => {
    const { actor } = await requireExtensionActor(request);
    return { body: await capture(actor, await readBody(request, 256_000)) };
  });
}

export function OPTIONS(request: Request) {
  return extensionOptions(request);
}
