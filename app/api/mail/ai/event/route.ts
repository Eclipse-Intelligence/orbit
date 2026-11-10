import { aiNotSetUp, TOO_MANY_REQUESTS, aiAllowed, aiConfigured, mailResponse } from "@/app/api/mail/respond";
import { CrmError } from "@/lib/crm/errors";
import { eventFromThread } from "@/lib/mail/event";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { key?: unknown };
  return mailResponse(async (actor) => {
    if (!aiConfigured()) throw new CrmError("unavailable", aiNotSetUp(actor), 503);
    if (!(await aiAllowed(actor.userId, "event", 40))) throw new CrmError("rate_limited", TOO_MANY_REQUESTS, 429);
    return eventFromThread(actor, typeof body.key === "string" ? body.key.slice(0, 500) : "");
  });
}
