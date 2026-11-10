import { mailResponse } from "@/app/api/mail/respond";
import { mailUnreadCount } from "@/lib/mail/threads";

export const dynamic = "force-dynamic";

export async function GET() {
  return mailResponse(async (actor) => ({ unread: await mailUnreadCount(actor) }));
}
