import { mailResponse } from "@/app/api/mail/respond";
import { removePushSubscription, savePushSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return mailResponse((actor) => savePushSubscription(actor, { endpoint: body.endpoint, keys: body.keys }, request.headers.get("user-agent")));
}

export async function DELETE(request: Request) {
  const endpoint = new URL(request.url).searchParams.get("endpoint") ?? "";
  return mailResponse(async (actor) => {
    await removePushSubscription(actor, endpoint);
    return { removed: true };
  });
}
