import type { Actor, Provenance } from "@/lib/crm/types";

export function auditJson(actor: Actor, eventType: string, entityType: string, entityId: string | null, provenance: Provenance, changes: Record<string, unknown>) {
  return JSON.stringify({
    eventType,
    entityType,
    entityId,
    actorType: actor.type,
    userId: actor.type === "user" ? actor.userId : null,
    agentId: actor.type === "agent" ? actor.agentId : null,
    credentialId: actor.type === "agent" ? actor.credentialId : null,
    source: provenance.source ?? null,
    sourceUrl: provenance.sourceUrl ?? null,
    operation: provenance.operation,
    workflowStep: provenance.workflowStep ?? null,
    changes,
  });
}
