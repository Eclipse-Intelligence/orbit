import { mailResponse } from "@/app/api/mail/respond";
import { readAttachmentIds, readDraftInput, scheduleMailDraft, unscheduleMailDraft } from "@/lib/mail/compose";
import { mailOrigin } from "@/lib/mail/origin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { attachments?: unknown; sendAt?: unknown };
  return mailResponse((actor) =>
    scheduleMailDraft(
      actor,
      { ...readDraftInput(body), attachments: readAttachmentIds(body.attachments), sendAt: typeof body.sendAt === "string" ? body.sendAt : "" },
      { origin: mailOrigin(request) },
    ),
  );
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return mailResponse(async (actor) => ({ draft: await unscheduleMailDraft(actor, id) }));
}
