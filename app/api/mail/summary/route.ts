import { aiAllowed, aiConfigured, mailResponse } from "@/app/api/mail/respond";
import { CrmError } from "@/lib/crm/errors";
import { summariseThread } from "@/lib/mail/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  return mailResponse(async (actor) => {
    if (!aiConfigured()) return { summary: null, todo: null };
    if (!(await aiAllowed(actor.userId, "summary", 200))) throw new CrmError("rate_limited", "That's a lot of summaries in a short time. Try again in a few minutes.", 429);
    return (await summariseThread(actor, key)) ?? { summary: null, todo: null };
  });
}
