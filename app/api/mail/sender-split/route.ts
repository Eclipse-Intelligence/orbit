import { mailResponse } from "@/app/api/mail/respond";
import { setSenderSplit } from "@/lib/mail/split";
import { MAIL_SPLITS } from "@/lib/mail/view";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { sender?: unknown; split?: unknown };
  const split = MAIL_SPLITS.find((item) => item === body.split) ?? null;
  return mailResponse((actor) => setSenderSplit(actor, typeof body.sender === "string" ? body.sender : "", split));
}
