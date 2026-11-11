import { mailResponse } from "@/app/api/mail/respond";
import { listSharedThreads } from "@/lib/mail/shares";

export const dynamic = "force-dynamic";

export async function GET() {
  return mailResponse(async (actor) => ({ threads: await listSharedThreads(actor) }));
}
