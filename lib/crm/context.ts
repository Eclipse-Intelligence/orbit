import type { Db } from "@/lib/db/pool";
import { getPool } from "@/lib/db/pool";
import { deliverDueWebhooks } from "@/lib/crm/webhooks";
import type { Actor } from "@/lib/crm/types";

export async function withActor<T>(
  actor: Actor,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    if (actor.type === "user") {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: actor.userId, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");
    } else {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        actor.workspaceId,
      ]);
      await client.query("select set_config('app.agent_id', $1, true)", [
        actor.agentId,
      ]);
      await client.query("select set_config('app.actor_type', 'agent', true)");
      await client.query("set local role crm_agent");
    }
    const result = await fn(client);
    await client.query("commit");
    void deliverDueWebhooks().catch(() => undefined);
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The connection is discarded by release after a failed transaction.
    }
    throw error;
  } finally {
    client.release();
  }
}

export function actorKey(actor: Actor) {
  return actor.type === "user" ? `user:${actor.userId}` : `agent:${actor.agentId}`;
}
