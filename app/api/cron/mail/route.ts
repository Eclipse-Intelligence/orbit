import { backgroundTargets } from "@/lib/crm/conversations";
import { followUpCallsAcross } from "@/lib/crm/follow-ups";
import { cronAuthorization } from "@/lib/crm/scheduler";
import { prepareMorningPass } from "@/lib/crm/task-prepare";
import { processDueMail } from "@/lib/mail/due";
import { readInviteReplies } from "@/lib/mail/invite-replies";
import { classifyCapture } from "@/lib/mail/capture-filter";
import { runMailPass } from "@/lib/mail/cron-pass";
import { prepareMail } from "@/lib/mail/prepare";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { SCHEDULED_FLOOR_MS, syncMail } from "@/lib/mail/sync";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUDGET_MS = 240_000;
const WORKFLOW_MS = 40_000;
const PREPARE_MS = 60_000;

async function prepareTasks(deadline: number) {
  return prepareMorningPass({ deadline }).catch((error) => {
    console.error("Preparing tasks failed", error instanceof Error ? error.message : error);
    return null;
  });
}

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to sync mail on a schedule." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!microsoftConfigured()) return Response.json({ users: [], tasks: await prepareTasks(Date.now() + PREPARE_MS) });
  const deadline = Date.now() + BUDGET_MS;
  const targets = (await backgroundTargets()).filter((target) => target.mailbox || target.calendarAccounts);
  const mailDeadline = deadline - WORKFLOW_MS - PREPARE_MS;
  const users = await runMailPass(
    targets.map((target) => target.actor),
    {
      sync: (actor, until) => syncMail(actor, { deadline: until, skipRecentMs: SCHEDULED_FLOOR_MS, announce: true, catchUp: true }),
      extras: async (actor, turnEnd) => {
        const within = (ms: number) => Math.min(turnEnd, Date.now() + ms);
        await processDueMail(actor, { deadline: within(30_000) }).catch((error) => console.error("Due mail failed", error));
        await prepareMail(actor, { deadline: turnEnd }).catch((error) => console.error("Preparing mail failed", error));
        await followUpCallsAcross(actor, { deadline: within(30_000) }).catch((error) => console.error("Call follow-ups failed", error));
        await readInviteReplies(actor, { deadline: within(20_000) }).catch((error) => console.error("Invite replies failed", error));
        await classifyCapture(actor, { deadline: within(30_000) }).catch((error) =>
          console.error("Sorting Capture email failed", error instanceof Error ? error.message : error),
        );
      },
    },
    mailDeadline,
  );
  const tasks = await prepareTasks(deadline - WORKFLOW_MS);
  if (deadline - Date.now() > 15_000) {
    await runWorkflowTick({ budgetMs: Math.min(deadline - Date.now() - 5_000, WORKFLOW_MS) }).catch((error) => console.error("Workflow tick failed", error));
  }
  return Response.json({ users, tasks });
}

export const GET = handle;
export const POST = handle;
