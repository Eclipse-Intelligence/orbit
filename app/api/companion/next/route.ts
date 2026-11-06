import { withApi } from "@/lib/api/http";
import { NO_STORE, requireCompanion } from "@/lib/companion/http";
import { IDLE_RETRY_MS, companionExpectingWork, nextCompanionJob } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WAIT_MS = 25_000;

export async function GET(request: Request) {
  return withApi(async () => {
    const auth = await requireCompanion(request);
    if (new URL(request.url).searchParams.get("mode") !== "short") {
      const job = await nextCompanionJob(auth, WAIT_MS);
      return Response.json({ job }, { headers: NO_STORE });
    }
    const expecting = await companionExpectingWork(auth);
    const job = await nextCompanionJob(auth, expecting ? WAIT_MS : 0);
    return Response.json({ job, retryAfterMs: job || expecting ? 0 : IDLE_RETRY_MS }, { headers: NO_STORE });
  });
}
