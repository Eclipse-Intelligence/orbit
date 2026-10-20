import { mailResponse } from "@/app/api/mail/respond";
import { listScheduledDrafts } from "@/lib/mail/compose";

export const dynamic = "force-dynamic";

export async function GET() {
  return mailResponse(async (actor) => ({ drafts: await listScheduledDrafts(actor) }));
}
