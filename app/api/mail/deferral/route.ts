import { mailResponse } from "@/app/api/mail/respond";
import { CrmError } from "@/lib/crm/errors";
import { cancelDeferral, moveDeferral } from "@/lib/mail/deferrals";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; action?: unknown; at?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  return mailResponse(async (actor) => {
    if (body.action === "move") {
      if (typeof body.at !== "string") throw new CrmError("invalid_input", "Choose a date.", 400, { field: "at" });
      return { ok: true, deferral: await moveDeferral(actor, id, body.at) };
    }
    if (body.action === "cancel") {
      await cancelDeferral(actor, id);
      return { ok: true, deferral: null };
    }
    throw new CrmError("invalid_input", "Choose Change date or Cancel.", 400, { field: "action" });
  });
}
