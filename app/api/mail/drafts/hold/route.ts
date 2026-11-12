import { mailResponse } from "@/app/api/mail/respond";
import { holdSharedDraft } from "@/lib/mail/shared-drafts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { draftId?: unknown; sending?: unknown };
  return mailResponse((actor) => holdSharedDraft(actor, body.draftId, body.sending === true));
}
