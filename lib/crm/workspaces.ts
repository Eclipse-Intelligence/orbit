import { linkCreatedWorkspace } from "@/lib/assistant/eclipse-scope";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError, pgFailure, tooLong } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { safeOpenTarget, workspaceLink } from "@/lib/open-link";

export type CreatedWorkspace = { id: string; name: string };

export function canCreateWorkspaces(roles: string[]) {
  return roles.includes("owner");
}

export async function createWorkspace(actor: UserActor, input: { name: unknown }, options: { fetchImpl?: typeof fetch } = {}): Promise<CreatedWorkspace> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CrmError("invalid_input", "Enter a workspace name.", 400);
  if (name.length > 120) throw new CrmError("invalid_input", tooLong("the name", 120), 400);
  try {
    const result = await query<{ id: string }>("select private.create_workspace($1, $2, null) as id", [actor.userId, name]);
    await linkCreatedWorkspace(actor.userId, result.rows[0].id, name, options).catch(() => false);
    return { id: result.rows[0].id, name };
  } catch (error) {
    if (isPgError(error) && (error.code === "42501" || error.code === "22023")) {
      throw pgFailure(error, { "42501": "Only workspace owners can create a workspace." }) ?? error;
    }
    throw error;
  }
}

export type WorkspaceRef = { id: string; name: string };

export async function workspaceActors(actor: UserActor): Promise<UserActor[]> {
  const result = await query<{ workspace_id: string; workspace_name: string; role: WorkspaceRole }>(
    "select workspace_id, workspace_name, role from private.memberships_for($1)",
    [actor.userId],
  );
  return result.rows.map((row) =>
    row.workspace_id === actor.workspaceId
      ? actor
      : { ...actor, workspaceId: row.workspace_id, workspaceName: row.workspace_name, role: row.role, scopes: scopesForRole(row.role) },
  );
}

export async function alertLink(actor: UserActor, path: string) {
  if (!safeOpenTarget(path)) return path;
  const actors = await workspaceActors(actor).catch(() => [actor]);
  return workspaceLink(actor.workspaceId, path, actors.length);
}

export async function actorForWorkspace(actor: UserActor, workspaceId: string) {
  if (workspaceId === actor.workspaceId) return actor;
  return actorIn(await workspaceActors(actor), workspaceId);
}

export async function actorForTask(actor: UserActor, taskId: unknown) {
  if (typeof taskId !== "string" || !isUuid(taskId)) return actor;
  const found = await withActor(actor, (db) => db.query<{ workspace_id: string }>("select workspace_id from crm.tasks where id = $1", [taskId]));
  const workspaceId = found.rows[0]?.workspace_id;
  if (!workspaceId || workspaceId === actor.workspaceId) return actor;
  const member = (await workspaceActors(actor)).find((item) => item.workspaceId === workspaceId);
  if (!member) throw new CrmError("not_found", TASK_LOOKUP_FAILED, 404);
  return member;
}

export async function actorsForTasks(actor: UserActor, taskIds: string[]) {
  const ids = [...new Set(taskIds.filter(isUuid))];
  if (ids.length === 0) return taskIds.map(() => actor);
  const found = await withActor(actor, (db) =>
    db.query<{ id: string; workspace_id: string }>("select id, workspace_id from crm.tasks where id = any($1::uuid[])", [ids]),
  );
  const homes = new Map(found.rows.map((row) => [row.id, row.workspace_id]));
  const elsewhere = [...homes.values()].some((workspaceId) => workspaceId !== actor.workspaceId);
  const members = elsewhere ? await workspaceActors(actor) : [actor];
  return taskIds.map((id) => {
    const workspaceId = homes.get(id);
    if (!workspaceId || workspaceId === actor.workspaceId) return actor;
    const member = members.find((item) => item.workspaceId === workspaceId);
    if (!member) throw new CrmError("not_found", TASK_LOOKUP_FAILED, 404);
    return member;
  });
}

export const TASK_LOOKUP_FAILED = "Couldn't find that task. Try again.";

export async function taskActorOrError(actor: UserActor, taskId: unknown): Promise<{ actor: UserActor; error?: undefined } | { actor?: undefined; error: string }> {
  try {
    return { actor: await actorForTask(actor, taskId) };
  } catch {
    return { error: TASK_LOOKUP_FAILED };
  }
}

export async function homeWorkspaceId(actor: UserActor) {
  return (await workspaceActors(actor))[0]?.workspaceId ?? actor.workspaceId;
}

export function actorIn(actors: UserActor[], workspaceId: string) {
  const found = actors.find((item) => item.workspaceId === workspaceId);
  if (!found) throw new CrmError("forbidden", "You're not in that workspace.", 403);
  return found;
}
