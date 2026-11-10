import { AI_NOT_SET_UP, TOO_MANY_REQUESTS, aiAllowed, aiConfigured, mailResponse } from "@/app/api/mail/respond";
import { CrmError } from "@/lib/crm/errors";
import { askMail } from "@/lib/mail/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { question?: unknown; account?: unknown };
  return mailResponse(async (actor) => {
    if (!aiConfigured()) throw new CrmError("unavailable", AI_NOT_SET_UP, 503);
    if (!(await aiAllowed(actor.userId, "ask", 60))) throw new CrmError("rate_limited", TOO_MANY_REQUESTS, 429);
    return askMail(actor, {
      question: typeof body.question === "string" ? body.question : "",
      account: typeof body.account === "string" ? body.account : null,
    });
  });
}
