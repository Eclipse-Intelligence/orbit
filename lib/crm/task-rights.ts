import type { Actor } from "@/lib/crm/types";

type TaskRights = { ownerId: string | null; createdByUserId: string | null; createdByAgentId?: string | null; seriesId?: string | null; completedAt?: string | null };

export type SeriesRights = { id: string; ownerId: string | null; createdByUserId: string | null; createdByAgentId: string | null };

function ownsTask(actor: Actor, task: TaskRights) {
  if (actor.type !== "user") return Boolean(task.createdByAgentId) && task.createdByAgentId === actor.agentId;
  return task.ownerId === actor.userId || task.createdByUserId === actor.userId;
}

function ownsSeriesOf(actor: Actor, task: TaskRights, series?: SeriesRights) {
  if (!series || !task.seriesId || task.seriesId !== series.id || task.completedAt) return false;
  if (actor.type !== "user") return Boolean(series.createdByAgentId) && series.createdByAgentId === actor.agentId;
  return series.ownerId === actor.userId || series.createdByUserId === actor.userId;
}

export function canChangeTask(actor: Actor, task: TaskRights, series?: SeriesRights) {
  return ownsTask(actor, task) || ownsSeriesOf(actor, task, series);
}
