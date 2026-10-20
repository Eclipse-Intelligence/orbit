import { mailResponse } from "@/app/api/mail/respond";
import { cancelFollowUp, updatePrepared } from "@/lib/mail/prepare";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; action?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  return mailResponse(async (actor) => {
    if (body.action === "cancel_reminder") {
      await cancelFollowUp(actor, id);
      return { ok: true, prepared: null };
    }
    return { ok: true, prepared: await updatePrepared(actor, id, body.action === "use" ? "use" : "dismiss") };
  });
}
