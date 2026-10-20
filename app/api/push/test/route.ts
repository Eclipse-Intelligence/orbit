import { mailResponse } from "@/app/api/mail/respond";
import { pushToUser, savePushSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return mailResponse(async (actor) => {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
    if (endpoint) await savePushSubscription(actor, { endpoint, keys: body.keys }, request.headers.get("user-agent"));
    const result = await pushToUser(
      actor,
      { title: "Orbit", body: "Notifications are working on this device.", url: "/mail", tag: "orbit-test" },
      { endpoint: endpoint ?? undefined },
    );
    return { ...result, host: endpoint ? new URL(endpoint).host : null };
  });
}
