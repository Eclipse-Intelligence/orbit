import { CrmError, isPgError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export type CreatedWorkspace = { id: string; name: string; brandSourceId: string | null };

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
    return { id: result.rows[0].id, name, brandSourceId };
  } catch (error) {
    if (isPgError(error) && (error.code === "42501" || error.code === "22023")) {
      throw new CrmError(error.code === "42501" ? "forbidden" : "invalid_input", error.message, error.code === "42501" ? 403 : 400);
    }
    throw error;
  }
}

