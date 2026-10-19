import { mailResponse } from "@/app/api/mail/respond";
import { discardMailDraft, readDraftInput, saveMailDraft } from "@/lib/mail/compose";
import { mailOrigin } from "@/lib/mail/origin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  return mailResponse((actor) => saveMailDraft(actor, readDraftInput(body), { origin: mailOrigin(request) }));
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return mailResponse(async (actor) => {
    await discardMailDraft(actor, id);
    return { discarded: true };
  });
}
