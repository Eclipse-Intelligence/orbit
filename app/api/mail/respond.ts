import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";

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
