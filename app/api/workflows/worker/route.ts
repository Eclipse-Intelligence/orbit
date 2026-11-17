import { after } from "next/server";
import { cronAuthorization } from "@/lib/crm/scheduler";
import { CRON_RUNS_AT_ONCE, LONG_TICK_MS, runWorkflowTick } from "@/lib/workflows/engine";
import { releaseWorkerLease, startWorkers, takeWorkerLease } from "@/lib/workflows/workers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runWorker(lease: string) {
  let processed = 0;
  try {
    processed = (await runWorkflowTick({ budgetMs: LONG_TICK_MS, long: true, limit: CRON_RUNS_AT_ONCE })).processed;
  } catch (error) {
    console.error("Workflow worker failed", error);
  } finally {
    await releaseWorkerLease(lease).catch((error) => console.error("Couldn't release a workflow worker", error));
  }
  if (processed > 0) await startWorkers().catch((error) => console.error("Couldn't start workflow workers", error));
}

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to run workflows." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  const lease = await takeWorkerLease();
  if (!lease) return Response.json({ started: false }, { status: 202 });
  after(() => runWorker(lease));
  return Response.json({ started: true }, { status: 202 });
}

export const POST = handle;
