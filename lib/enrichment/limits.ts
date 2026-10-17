import { query } from "@/lib/db/pool";

const LIMIT = 300;
const WINDOW_SECONDS = 3600;

export async function enrichmentAllowed(userId: string, cost: number) {
  for (let index = 0; index < Math.max(1, Math.min(cost, 10)); index += 1) {
    const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [
      `enrich:${userId}`,
      LIMIT,
      WINDOW_SECONDS,
    ]);
    if (!result.rows[0]?.allowed) return false;
  }
  return true;
}
