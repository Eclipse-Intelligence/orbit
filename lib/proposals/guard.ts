import { getUserActor } from "@/lib/auth/user";
import { clientIp } from "@/lib/booking/book";
import { query } from "@/lib/db/pool";

export async function signedIn() {
  return Boolean(await getUserActor().catch(() => null));
}

export async function guardPublic(request: Request, key: string, limit: number, options: { clientOnly?: boolean } = {}) {
  if (options.clientOnly && (await signedIn())) {
    return { error: Response.json({ error: "You're signed in to Orbit, so this can't be done as the client. Open the link in a private window to try it." }, { status: 403 }) };
  }
  const ip = clientIp(request.headers);
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`proposal-${key}:${ip}`, limit, 600]);
  if (result.rows[0]?.allowed === false) return { error: Response.json({ error: "Too many requests. Wait a few minutes and try again." }, { status: 429 }) };
  return { ip, userAgent: request.headers.get("user-agent") };
}
