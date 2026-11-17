import { CAMPAIGN_SYNC_MS, syncCampaigns } from "@/lib/campaigns/sync";
import { cronAuthorization } from "@/lib/crm/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth === "unconfigured") return Response.json({ error: "Set CRON_SECRET to sync campaigns on a schedule." }, { status: 503 });
  if (auth === "unauthorized") return Response.json({ error: "Unauthorized." }, { status: 401 });
  const startedAt = Date.now();
  const report = await syncCampaigns({ deadline: startedAt + CAMPAIGN_SYNC_MS });
  return Response.json({ startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, ...report });
}

export const GET = handle;
export const POST = handle;
