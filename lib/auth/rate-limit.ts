import { CrmError, isPgError } from "@/lib/crm/errors";
import { query } from "@/lib/db/pool";

export const CALLS_PER_MINUTE = 120;
const WINDOW_SECONDS = 60;
const UNDEFINED_FUNCTION = "42883";

async function chargeOnce(key: string) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [key, CALLS_PER_MINUTE, WINDOW_SECONDS]);
  return Boolean(result.rows[0]?.allowed);
}

async function charge(key: string, cost: number) {
  if (cost <= 1) return chargeOnce(key);
  try {
    const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3, $4) as allowed", [
      key,
      CALLS_PER_MINUTE,
      WINDOW_SECONDS,
      cost,
    ]);
    return Boolean(result.rows[0]?.allowed);
  } catch (error) {
    if (!isPgError(error) || error.code !== UNDEFINED_FUNCTION) throw error;
    let allowed = true;
    for (let index = 0; index < cost; index += 1) allowed = (await chargeOnce(key)) && allowed;
    return allowed;
  }
}

export async function consumeRateLimitFor(key: string, cost = 1) {
  if (!(await charge(key, cost))) throw new CrmError("rate_limited", "Too many requests.", 429);
}
