import { mailResponse } from "@/app/api/mail/respond";
import { discardMailDraft, readAttachmentIds, readDraftInput, saveMailDraft } from "@/lib/mail/compose";
import { mailOrigin } from "@/lib/mail/origin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { attachments?: unknown };
  return mailResponse((actor) =>
    saveMailDraft(actor, { ...readDraftInput(body), attachments: readAttachmentIds(body.attachments) }, { origin: mailOrigin(request), storedFiles: "replace" }),
  );
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return mailResponse(async (actor) => {
    await discardMailDraft(actor, id);
    return { discarded: true };
  });
}
