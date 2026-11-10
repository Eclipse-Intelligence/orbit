import { cronAuthorization } from "@/lib/crm/scheduler";
import { processAllCalendarAlerts } from "@/lib/calendar-alerts";
import { sweepAgentMail } from "@/lib/agent-mail/jobs";
import { pollAgentMailboxes } from "@/lib/agent-mail/poll";
import { processAllDueMail } from "@/lib/mail/due";
import { sweepWaitingSteers } from "@/lib/assistant/chat";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to send scheduled mail." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  const started = Date.now();
  const deadline = started + 45_000;
  const users = await processAllDueMail(deadline - 10_000);
  const calendar = await processAllCalendarAlerts(deadline).catch((error) => {
    console.error("Calendar alerts failed", error);
    return { users: 0, sent: 0 };
  });
  const polled = await pollAgentMailboxes({ deadline: Date.now() + 20_000 }).catch((error) => {
    console.error("Agent mail poll failed", error instanceof Error ? error.name : "unknown");
    return null;
  });
  const agentMail = await sweepAgentMail({ budgetMs: Math.max(5_000, deadline - Date.now() + 30_000), deadline: Date.now() + 240_000 }).catch((error) => {
    console.error("Agent mail sweep failed", error instanceof Error ? error.name : "unknown");
    return 0;
  });
  const steering = await sweepWaitingSteers(started + 285_000).catch((error) => {
    console.error("Waiting assistant messages sweep failed", error instanceof Error ? error.name : "unknown");
    return 0;
  });
  return Response.json({ users, calendar, agentMail, polled, steering });
}

export const GET = handle;
export const POST = handle;
