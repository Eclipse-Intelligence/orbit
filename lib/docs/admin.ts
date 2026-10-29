import { CrmError, isPgError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export async function takeOverFormerMemberDocs(actor: UserActor, formerUserId: string) {
  if (!isUuid(formerUserId)) throw new CrmError("not_found", "That person isn't known here.", 404);
  try {
    const result = await query<{ docs: number; folders: number }>("select docs, folders from private.docs_reassign($1, $2, $3)", [
      actor.workspaceId,
      actor.userId,
      formerUserId,
    ]);
    return result.rows[0] ?? { docs: 0, folders: 0 };
  } catch (error) {
    if (isPgError(error) && (error.code === "42501" || error.code === "22023")) {
      throw new CrmError(error.code === "42501" ? "forbidden" : "invalid_input", error.message, error.code === "42501" ? 403 : 400);
    }
    throw error;
  }
}
