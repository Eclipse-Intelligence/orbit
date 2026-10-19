import { mailResponse } from "@/app/api/mail/respond";
import { mailNav } from "@/lib/mail/threads";

export const dynamic = "force-dynamic";

export async function GET() {
  return mailResponse((actor) => mailNav(actor));
}
