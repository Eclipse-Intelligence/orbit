import { extensionJson, extensionOptions, orbitUrl, requireExtension } from "@/lib/extension/http";
import { extensionActors } from "@/lib/extension/pairing";
import type { MeResponse } from "@/lib/extension/protocol";
import { workspaceOptions } from "@/lib/extension/records";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return extensionJson(request, async () => {
    const auth = await requireExtension(request);
    const actors = await extensionActors(auth);
    const first = actors[0];
    const body: MeResponse = {
      browser: { id: auth.browserId, name: auth.name },
      user: { id: auth.userId, name: first?.fullName || first?.email || "You", email: first?.email ?? "" },
      orbitUrl: orbitUrl(request),
      workspaces: await Promise.all(actors.map((actor) => workspaceOptions(actor))),
    };
    return { body };
  });
}

export function OPTIONS(request: Request) {
  return extensionOptions(request);
}
