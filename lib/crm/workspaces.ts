import { CrmError, isPgError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export type CreatedWorkspace = { id: string; name: string };

export function canCreateWorkspaces(roles: string[]) {
  return roles.includes("owner");
}

export async function createWorkspace(actor: UserActor, input: { name: unknown }): Promise<CreatedWorkspace> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CrmError("invalid_input", "Give the workspace a name.", 400);
  if (name.length > 120) throw new CrmError("invalid_input", "Keep the name to 120 characters.", 400);
  try {
    const result = await query<{ id: string }>("select private.create_workspace($1, $2, null) as id", [actor.userId, name]);
    return { id: result.rows[0].id, name };
  } catch (error) {
    if (isPgError(error) && (error.code === "42501" || error.code === "22023")) {
      throw new CrmError(error.code === "42501" ? "forbidden" : "invalid_input", error.message, error.code === "42501" ? 403 : 400);
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

export async function actorForWorkspace(actor: UserActor, workspaceId: string) {
  if (workspaceId === actor.workspaceId) return actor;
  return (await workspaceActors(actor)).find((item) => item.workspaceId === workspaceId) ?? actor;
}

export async function homeWorkspaceId(actor: UserActor) {
  return (await workspaceActors(actor))[0]?.workspaceId ?? actor.workspaceId;
}

export function actorIn(actors: UserActor[], workspaceId: string) {
  const found = actors.find((item) => item.workspaceId === workspaceId);
  if (!found) throw new CrmError("forbidden", "You're not in that workspace.", 403);
  return found;
}
