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

function actorSession(db: Db, actor: Actor) {
  return actor.type === "user"
    ? `select set_config('request.jwt.claims', ${db.escapeLiteral(
        JSON.stringify({ sub: actor.userId, role: "authenticated" }),
      )}, true); set local role authenticated`
    : `select set_config('app.workspace_id', ${db.escapeLiteral(actor.workspaceId)}, true), set_config('app.agent_id', ${db.escapeLiteral(
        actor.agentId,
      )}, true), set_config('app.actor_type', 'agent', true); set local role crm_agent`;
}

async function inActorTransaction<T>(
  actor: Actor,
  appStep: ((db: Db) => Promise<void>) | null,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    if (appStep) {
      await client.query("begin");
      await appStep(client);
      await client.query(actorSession(client, actor));
    } else {
      await client.query(`begin; ${actorSession(client, actor)}`);
    }
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

export async function withActor<T>(
  actor: Actor,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return inActorTransaction(actor, null, fn);
}

export async function withActorAfterAppStep<T>(
  actor: Actor,
  appStep: (db: Db) => Promise<void>,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return inActorTransaction(actor, appStep, fn);
}

export function actorKey(actor: Actor) {
  return actor.type === "user" ? `user:${actor.userId}` : `agent:${actor.agentId}`;
}
