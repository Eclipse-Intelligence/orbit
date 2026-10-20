import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export async function aiAllowed(userId: string, kind: string, limit: number) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`mail-ai:${kind}:${userId}`, limit, 600]);
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
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("mail request failed", error);
    return Response.json({ error: "Mail didn't load. Try again." }, { status: 500 });
  }
}
