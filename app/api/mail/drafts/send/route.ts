import { mailResponse } from "@/app/api/mail/respond";
import { readAttachmentIds, readDraftInput, sendMailDraft } from "@/lib/mail/compose";
import { mailOrigin } from "@/lib/mail/origin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { attachments?: unknown };
  return mailResponse((actor) => sendMailDraft(actor, { ...readDraftInput(body), attachments: readAttachmentIds(body.attachments) }, { origin: mailOrigin(request), storedFiles: "replace" }));
}
