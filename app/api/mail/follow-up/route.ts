import { aiAllowed, mailResponse } from "@/app/api/mail/respond";
import { CrmError } from "@/lib/crm/errors";
import { followUpUnwritten, restoreFollowUp, saveFollowUpBody, sendFollowUpNow, writeFollowUpNow } from "@/lib/mail/follow-up";
import { mailOrigin } from "@/lib/mail/origin";
import { cancelFollowUp } from "@/lib/mail/prepare";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TOO_MANY = "That's a lot of follow-ups at once. Wait a few minutes.";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; action?: unknown; body?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  return mailResponse(async (actor) => {
    if (body.action === "save") return saveFollowUpBody(actor, id, body.body);
    if (body.action === "write") {
      if (!(await aiAllowed(actor.userId, "follow-up", 20))) throw new CrmError("rate_limited", TOO_MANY, 429);
      return writeFollowUpNow(actor, id);
    }
    if (body.action === "send") {
      if ((await followUpUnwritten(actor, id)) && !(await aiAllowed(actor.userId, "follow-up", 20))) throw new CrmError("rate_limited", TOO_MANY, 429);
      return sendFollowUpNow(actor, id, { origin: mailOrigin(request) });
    }
    if (body.action === "cancel") {
      if ((await cancelFollowUp(actor, id)) === 0) throw new CrmError("conflict", "Orbit is already sending this follow-up.", 409);
      return { cancelled: true };
    }
    if (body.action === "restore") return restoreFollowUp(actor, id);
    throw new CrmError("invalid_input", "Choose save, write, send, cancel or restore.", 400);
  });
}
