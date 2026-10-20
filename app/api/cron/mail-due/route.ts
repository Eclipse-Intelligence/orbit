import { cronAuthorization } from "@/lib/crm/scheduler";
import { processAllCalendarAlerts } from "@/lib/calendar-alerts";
import { processAllDueMail } from "@/lib/mail/due";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to send scheduled mail." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  const deadline = Date.now() + 45_000;
  const users = await processAllDueMail(deadline - 10_000);
  const calendar = await processAllCalendarAlerts(deadline).catch((error) => {
    console.error("Calendar alerts failed", error);
    return { users: 0, sent: 0 };
  });
  return Response.json({ users, calendar });
}

export const GET = handle;
export const POST = handle;
