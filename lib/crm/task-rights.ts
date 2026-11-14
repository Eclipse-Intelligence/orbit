import type { Actor } from "@/lib/crm/types";

export function canChangeTask(actor: Actor, task: { ownerId: string | null; createdByUserId: string | null; createdByAgentId?: string | null }) {
  if (actor.type !== "user") return Boolean(task.createdByAgentId) && task.createdByAgentId === actor.agentId;
  return task.ownerId === actor.userId || task.createdByUserId === actor.userId;
}
