import { cronAuthorization } from "@/lib/crm/scheduler";
import { LONG_TICK_MS, runWorkflowTick } from "@/lib/workflows/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to run workflows on a schedule." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  return Response.json(await runWorkflowTick({ budgetMs: LONG_TICK_MS, long: true }));
}

export const GET = handle;
export const POST = handle;
