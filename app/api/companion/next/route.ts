import { withApi } from "@/lib/api/http";
import { NO_STORE, requireCompanion } from "@/lib/companion/http";
import { nextCompanionJob } from "@/lib/companion/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WAIT_MS = 25_000;

export async function GET(request: Request) {
  return withApi(async () => {
    const auth = await requireCompanion(request);
    const job = await nextCompanionJob(auth, WAIT_MS);
    return Response.json({ job }, { headers: NO_STORE });
  });
}
