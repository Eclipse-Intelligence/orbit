import { cronAuthorization } from "@/lib/crm/scheduler";
import { runWorkflowTick } from "@/lib/workflows/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to run workflows on a schedule." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  return Response.json(await runWorkflowTick({ budgetMs: 50_000 }));
}

export const GET = handle;
export const POST = handle;
