import { backgroundTargets } from "@/lib/crm/conversations";
import { cronAuthorization } from "@/lib/crm/scheduler";
import { processDueMail } from "@/lib/mail/due";
import { prepareMail } from "@/lib/mail/prepare";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { syncMail, type MailSyncReport } from "@/lib/mail/sync";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUDGET_MS = 240_000;

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to sync mail on a schedule." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!microsoftConfigured()) return Response.json({ users: [] });
  const deadline = Date.now() + BUDGET_MS;
  const targets = (await backgroundTargets()).filter((target) => target.mailbox || target.calendarAccounts);
  const users: { userId: string; report: MailSyncReport | { error: string } }[] = [];
  for (const [index, target] of targets.entries()) {
    const remaining = deadline - Date.now();
    if (remaining < 5_000) break;
    const share = Math.floor(remaining / (targets.length - index));
    try {
      const report = await syncMail(target.actor, { deadline: Date.now() + share });
      await processDueMail(target.actor).catch((error) => console.error("Due mail failed", error));
      await prepareMail(target.actor, { deadline: Math.min(deadline - 5_000, Date.now() + Math.max(share, 30_000)) }).catch((error) =>
        console.error("Preparing mail failed", error),
      );
      users.push({ userId: target.actor.userId, report });
    } catch (error) {
      users.push({ userId: target.actor.userId, report: { error: error instanceof Error ? error.message : "Mail sync failed." } });
    }
  }
  if (users.some((user) => "workflowEvents" in user.report && user.report.workflowEvents > 0) && deadline - Date.now() > 15_000) {
    await runWorkflowTick({ budgetMs: Math.min(deadline - Date.now() - 5_000, 40_000) }).catch((error) => console.error("Workflow tick failed", error));
  }
  return Response.json({ users });
}

export const GET = handle;
export const POST = handle;
