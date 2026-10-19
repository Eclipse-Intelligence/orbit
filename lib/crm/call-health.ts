import { judgeCallSentiment } from "@/lib/crm/call-insights";
import { query } from "@/lib/db/pool";
import { ownerActor } from "@/lib/workflows/engine";

export async function backfillCallHealth(options: { limit?: number; budgetMs?: number; fetchImpl?: typeof fetch } = {}) {
  if (!process.env.LLM_API_KEY?.trim()) return { judged: 0, failed: 0 };
  const deadline = Date.now() + (options.budgetMs ?? 20_000);
  const claimed = await query<{ activity_id: string; workspace_id: string; user_id: string }>(
    "select * from private.claim_unjudged_calls($1)",
    [options.limit ?? 1],
  );
  let judged = 0;
  let failed = 0;
  for (const row of claimed.rows) {
    const actor = await ownerActor(row.user_id, row.workspace_id);
    if (!actor) continue;
    try {
      await judgeCallSentiment(actor, row.activity_id, { fetchImpl: options.fetchImpl, deadline });
      judged += 1;
    } catch (error) {
      failed += 1;
      console.error("Call health check failed", error);
    }
  }
  return { judged, failed };
}
