import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { CrmError, notSetUp } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { graphReconnect } from "@/lib/mail/accounts";
import { appNeedsAttention } from "@/lib/mail/microsoft";
import { APP_NEEDS_ATTENTION } from "@/lib/microsoft/oauth";

export function aiNotSetUp(actor: UserActor) {
  return notSetUp("AI", "LLM_API_KEY", actor);
}

export const TOO_MANY_REQUESTS = "Too many requests. Try again in a few minutes.";

export async function aiAllowed(userId: string, kind: string, limit: number) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`mail-ai:${kind}:${userId}`, limit, 600]);
  return Boolean(result.rows[0]?.allowed);
}

export async function withinLimit(userId: string, kind: string, limit: number, seconds: number) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`mail:${kind}:${userId}`, limit, seconds]);
  return Boolean(result.rows[0]?.allowed);
}

export function aiConfigured() {
  return Boolean(process.env.LLM_API_KEY?.trim());
}

export async function mailResponse<T>(run: (actor: UserActor) => Promise<T>) {
  const actor = await getUserActor();
  if (!actor) return Response.json({ error: "Sign in again." }, { status: 401 });
  try {
    return Response.json(await run(actor), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ ...error.details, error: error.message }, { status: error.status });
    const reconnect = graphReconnect(error, null);
    if (reconnect) return Response.json({ ...reconnect.details, error: reconnect.message }, { status: reconnect.status });
    if (appNeedsAttention(error)) return Response.json({ error: APP_NEEDS_ATTENTION }, { status: 502 });
    console.error("mail request failed", error);
    return Response.json({ error: "That didn't work. Try again." }, { status: 500 });
  }
}

export function inBackground(work: () => Promise<unknown>) {
  try {
    after(work);
  } catch {
    void work();
  }
}
