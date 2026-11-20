import { getUserActor } from "@/lib/auth/user";
import type { ChatRouteContext } from "@/lib/chat/http";
import { linkPreviewImage, previewImageResponse } from "@/lib/crm/chat-link-previews";
import { CrmError } from "@/lib/crm/errors";

export const dynamic = "force-dynamic";

const MISSING = "That image isn't available.";

export async function GET(_request: Request, context: ChatRouteContext) {
  const { id } = await context.params;
  try {
    const actor = await getUserActor();
    if (!actor) return Response.json({ error: "Your session ended. Sign in again." }, { status: 401 });
    return previewImageResponse(await linkPreviewImage(actor, id));
  } catch (error) {
    if (error instanceof CrmError && error.status === 404) return Response.json({ error: MISSING }, { status: 404, headers: { "cache-control": "private, max-age=60" } });
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Chat preview image failed", error);
    return Response.json({ error: "Couldn't load the image. Try again." }, { status: 500 });
  }
}
