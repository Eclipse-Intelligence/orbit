import { cronAuthorization } from "@/lib/crm/scheduler";
import { processAllDueMail } from "@/lib/mail/due";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to send scheduled mail." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  return Response.json({ users: await processAllDueMail(Date.now() + 45_000) });
}

export const GET = handle;
export const POST = handle;
