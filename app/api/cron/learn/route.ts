import { cronAuthorization } from "@/lib/crm/scheduler";
import { runNightlyLearning } from "@/lib/learning/nightly";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUDGET_MS = 240_000;

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to run nightly learning." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return Response.json(await runNightlyLearning({ deadline: Date.now() + BUDGET_MS }));
  } catch (error) {
    console.error("Nightly learning failed", error);
    return Response.json({ error: "Nightly learning failed." }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
