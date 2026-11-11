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

export const MCP_SENDS_PER_HOUR = 60;
const HOUR_MS = 3_600_000;

export async function consumeMailSendLimit(userId: string, now = Date.now()) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`mail-send:${userId}`, MCP_SENDS_PER_HOUR, HOUR_MS / 1000]);
  if (result.rows[0]?.allowed) return;
  const retryAt = new Date((Math.floor(now / HOUR_MS) + 1) * HOUR_MS);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(retryAt);
  throw new CrmError(
    "rate_limited",
    `${MCP_SENDS_PER_HOUR} emails have been sent or scheduled through MCP this hour, the most Orbit allows. Try again after ${time} London time.`,
    429,
    { retryAt: retryAt.toISOString() },
  );
}

export const MCP_CHAT_POSTS_PER_MINUTE = 60;

export async function consumeChatPostLimit(userId: string) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`chat-post:${userId}`, MCP_CHAT_POSTS_PER_MINUTE, WINDOW_SECONDS]);
  if (result.rows[0]?.allowed) return;
  throw new CrmError("rate_limited", `Couldn't post. ${MCP_CHAT_POSTS_PER_MINUTE} Chat messages a minute is the most MCP allows. Try again in a minute.`, 429);
}
