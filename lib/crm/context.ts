import { after } from "next/server";
import type { Db } from "@/lib/db/pool";
import { getPool } from "@/lib/db/pool";
import { takeWebhooksQueued } from "@/lib/crm/webhook-queue";
import { deliverDueWebhooks } from "@/lib/crm/webhooks";
import type { Actor } from "@/lib/crm/types";

function scheduleWebhooks() {
  const run = () => {
    void deliverDueWebhooks().catch((error) => console.error("Webhook delivery failed", error));
  };
  try {
    after(run);
  } catch {
    run();
  }
}

export async function withActor<T>(
  actor: Actor,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(
      actor.type === "user"
        ? `begin; select set_config('request.jwt.claims', ${client.escapeLiteral(
            JSON.stringify({ sub: actor.userId, role: "authenticated" }),
          )}, true); set local role authenticated`
        : `begin; select set_config('app.workspace_id', ${client.escapeLiteral(actor.workspaceId)}, true), set_config('app.agent_id', ${client.escapeLiteral(
            actor.agentId,
          )}, true), set_config('app.actor_type', 'agent', true); set local role crm_agent`,
    );
    const result = await fn(client);
    await client.query("commit");
    if (takeWebhooksQueued(client)) scheduleWebhooks();
    return result;
  } catch (error) {
    takeWebhooksQueued(client);
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export function actorKey(actor: Actor) {
  return actor.type === "user" ? `user:${actor.userId}` : `agent:${actor.agentId}`;
}
