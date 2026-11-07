import { mailResponse } from "@/app/api/mail/respond";
import { CrmError } from "@/lib/crm/errors";
import { readAttachmentIds, readDraftInput, SEND_UNCONFIRMED, sendMailDraft } from "@/lib/mail/compose";
import { mailOrigin } from "@/lib/mail/origin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { attachments?: unknown };
  return mailResponse(async (actor) => {
    try {
      return await sendMailDraft(actor, { ...readDraftInput(body), attachments: readAttachmentIds(body.attachments) }, { origin: mailOrigin(request), storedFiles: "replace" });
    } catch (error) {
      if (error instanceof CrmError) throw error;
      console.error("mail send failed", error);
      throw new CrmError("send_failed", SEND_UNCONFIRMED, 500);
    }
  });
}
