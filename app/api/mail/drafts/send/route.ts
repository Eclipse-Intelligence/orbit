import { mailResponse } from "@/app/api/mail/respond";
import { readDraftInput, sendMailDraft } from "@/lib/mail/compose";
import { mailOrigin } from "@/lib/mail/origin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { attachments?: unknown };
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter((item): item is string => typeof item === "string") : [];
  return mailResponse((actor) => sendMailDraft(actor, { ...readDraftInput(body), attachments }, { origin: mailOrigin(request) }));
}
