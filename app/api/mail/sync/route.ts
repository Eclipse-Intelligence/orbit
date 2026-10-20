import { mailResponse } from "@/app/api/mail/respond";
import { processDueMail } from "@/lib/mail/due";
import { mailOrigin } from "@/lib/mail/origin";
import { syncMail } from "@/lib/mail/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  return mailResponse(async (actor) => {
    const report = await syncMail(actor, { budgetMs: 8_000, backfill: false });
    const due = await processDueMail(actor, { origin: mailOrigin(request) }).catch(() => null);
    return { stored: report.stored, removed: report.removed, due };
  });
}
