import { after } from "next/server";
import type { Db } from "@/lib/db/pool";
import type { Actor, Provenance } from "@/lib/crm/types";
import { eventTriggerTypes } from "@/lib/workflows/definition";

export async function enqueueWorkflowEvent(
  db: Db,
  actor: Actor,
  eventType: string,
  entityType: string,
  entityId: string,
  provenance: Provenance | undefined,
  changes: Record<string, unknown>,
) {
  const triggers = eventTriggerTypes(eventType, entityType, changes);
  if (triggers.length === 0) return;
  await db.query(
    `insert into crm.workflow_events (
       workspace_id, trigger_types, event_type, entity_type, entity_id, data, actor_user_id, source_workflow_id, depth
     ) values ($1, $2::text[], $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [
      actor.workspaceId,
      triggers,
      eventType,
      entityType,
      /^[0-9a-f-]{36}$/i.test(entityId) ? entityId : null,
      JSON.stringify(changes),
      actor.type === "user" ? actor.userId : null,
      provenance?.workflowId ?? null,
      provenance?.depth ?? 0,
    ],
  );
  kickWorkflows();
}

export function kickWorkflows() {
  try {
    after(async () => {
      try {
        const { runWorkflowTick } = await import("@/lib/workflows/engine");
        await runWorkflowTick({ budgetMs: 25_000 });
      } catch (error) {
        console.error("Workflow tick failed", error);
      }
    });
  } catch {}
}
