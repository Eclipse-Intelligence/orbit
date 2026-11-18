import { mailResponse } from "@/app/api/mail/respond";
import { getHomeActor } from "@/lib/auth/user";
import { processDueMail } from "@/lib/mail/due";
import { mailOrigin } from "@/lib/mail/origin";
import { screenSyncOptions, syncProblems, syncMail } from "@/lib/mail/sync";
import { mailVersion } from "@/lib/mail/threads";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const deadline = Date.now() + 27_000;
  const body = await request.json().catch(() => null);
  return mailResponse(async (current) => {
    const actor = (await getHomeActor()) ?? current;
    const report = await syncMail(actor, screenSyncOptions(body));
    const due = await processDueMail(actor, { origin: mailOrigin(request), deadline }).catch(() => null);
    const version = await mailVersion(current).catch(() => null);
    return { stored: report.stored, removed: report.removed, due, version, problems: syncProblems(report) };
  });
}
