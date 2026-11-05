import { copyBrandProfile } from "@/lib/crm/brand";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export type CreatedWorkspace = { id: string; name: string; brandSourceId: string | null; warning: string | null };

export const BRAND_COPY_FAILED = "The workspace was created but its brand profile couldn't be copied. Fill it in under Settings, Brand.";

export function canCreateWorkspaces(roles: string[]) {
  return roles.includes("owner");
}

export async function createWorkspace(
  actor: UserActor,
  input: { name: unknown; brandStart: unknown },
): Promise<CreatedWorkspace> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CrmError("invalid_input", "Give the workspace a name.", 400);
  if (name.length > 120) throw new CrmError("invalid_input", "Keep the name to 120 characters.", 400);
  if (input.brandStart !== "blank" && input.brandStart !== "copy") {
    throw new CrmError("invalid_input", "Choose Blank or Copy.", 400);
  }
  const brandSourceId = input.brandStart === "copy" ? actor.workspaceId : null;
  try {
    const result = await query<{ id: string }>("select private.create_workspace($1, $2, $3) as id", [
      actor.userId,
      name,
      brandSourceId,
    ]);
    const id = result.rows[0].id;
    let warning: string | null = null;
    if (brandSourceId) {
      try {
        await copyBrandProfile(actor, brandSourceId, id);
      } catch (error) {
        console.error("Copying the brand profile failed", error instanceof Error ? error.message : "unknown");
        warning = BRAND_COPY_FAILED;
      }
    }
    return { id, name, brandSourceId, warning };
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

export function actorIn(actors: UserActor[], workspaceId: string) {
  const found = actors.find((item) => item.workspaceId === workspaceId);
  if (!found) throw new CrmError("forbidden", "You're not in that workspace.", 403);
  return found;
}
