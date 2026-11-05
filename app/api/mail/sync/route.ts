import { mailResponse } from "@/app/api/mail/respond";
import { getHomeActor } from "@/lib/auth/user";
import { processDueMail } from "@/lib/mail/due";
import { mailOrigin } from "@/lib/mail/origin";
import { syncMail } from "@/lib/mail/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const deadline = Date.now() + 27_000;
  return mailResponse(async (current) => {
    const actor = (await getHomeActor()) ?? current;
    const report = await syncMail(actor, { budgetMs: 8_000, backfill: false });
    const due = await processDueMail(actor, { origin: mailOrigin(request), deadline }).catch(() => null);
    return { stored: report.stored, removed: report.removed, due };
  });
}
