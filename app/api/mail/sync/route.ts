import { mailResponse } from "@/app/api/mail/respond";
import { syncMail } from "@/lib/mail/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST() {
  return mailResponse(async (actor) => {
    const report = await syncMail(actor, { budgetMs: 8_000, backfill: false });
    return { stored: report.stored, removed: report.removed };
  });
}
