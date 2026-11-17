import { query } from "@/lib/db/pool";
import { siteOrigin } from "@/lib/site-url";

export const MAX_WORKERS = 10;
export const RUNS_PER_WORKER = 25;
export const WORKER_LEASE_SECONDS = 300;
const START_TIMEOUT_MS = 10_000;

export async function takeWorkerLease() {
  const result = await query<{ id: string | null }>("select private.take_workflow_worker($1, $2) as id", [MAX_WORKERS, WORKER_LEASE_SECONDS]);
  return result.rows[0]?.id ?? null;
}

export async function releaseWorkerLease(id: string) {
  await query("select private.release_workflow_worker($1)", [id]);
}

export function workersWanted(backlog: number, live: number) {
  return Math.max(0, Math.min(MAX_WORKERS, Math.ceil(backlog / RUNS_PER_WORKER)) - live);
}

export async function startWorkers(options: { fetchImpl?: typeof fetch } = {}) {
  const origin = siteOrigin();
  const secret = process.env.CRON_SECRET?.trim();
  if (!origin || !secret) return 0;
  const backlog = (await query<{ count: number }>("select private.workflow_backlog(true) as count")).rows[0]?.count ?? 0;
  if (backlog === 0) return 0;
  const live = (await query<{ count: number }>("select private.live_workflow_workers() as count")).rows[0]?.count ?? 0;
  const wanted = workersWanted(backlog, live);
  if (wanted === 0) return 0;
  const send = options.fetchImpl ?? fetch;
  await Promise.allSettled(
    Array.from({ length: wanted }, () =>
      send(`${origin}/api/workflows/worker`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      }),
    ),
  );
  return wanted;
}
