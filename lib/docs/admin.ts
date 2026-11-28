import { CrmError, isPgError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { withActor } from "@/lib/crm/context";
import { query } from "@/lib/db/pool";
import { listDocs, untagPrivatePages } from "@/lib/docs/store";

const ARCHIVED_PAGE = 200;
const ARCHIVED_REACH = 10_000;

export async function listArchivedDocs(actor: UserActor) {
  const notes = [];
  for (let offset = 0; offset <= ARCHIVED_REACH; offset += ARCHIVED_PAGE) {
    const page = await listDocs(actor, { archived: true, kind: "any", limit: ARCHIVED_PAGE, offset }, { newestArchivedFirst: true });
    notes.push(...page.data);
    if (!page.hasMore) break;
  }
  return notes;
}

export type FormerOwner = { id: string; name: string; docs: number; folders: number; examples: string[] };

export async function listFormerOwners(actor: UserActor): Promise<FormerOwner[]> {
  try {
    const result = await query<{ user_id: string; name: string; docs: number; folders: number; examples: string[] }>(
      "select user_id, name, docs, folders, examples from private.docs_former_owners($1, $2)",
      [actor.workspaceId, actor.userId],
    );
    return result.rows.map((row) => ({
      id: row.user_id,
      name: row.name,
      docs: row.docs,
      folders: row.folders,
      examples: row.examples.map((title) => title || "Untitled"),
    }));
  } catch (error) {
    if (isPgError(error) && error.code === "42501") throw new CrmError("forbidden", error.message, 403);
    throw error;
  }
}

export async function takeOverFormerMemberDocs(actor: UserActor, formerUserId: string) {
  if (!isUuid(formerUserId)) throw new CrmError("not_found", "That person isn't known here.", 404);
  try {
    const result = await query<{ docs: number; folders: number }>("select docs, folders from private.docs_reassign($1, $2, $3)", [
      actor.workspaceId,
      actor.userId,
      formerUserId,
    ]);
    await withActor(actor, (db) => untagPrivatePages(db, actor)).catch((error) => console.error("Couldn't turn people tags into text after a takeover", error));
    return result.rows[0] ?? { docs: 0, folders: 0 };
  } catch (error) {
    if (isPgError(error) && (error.code === "42501" || error.code === "22023")) {
      throw new CrmError(error.code === "42501" ? "forbidden" : "invalid_input", error.message, error.code === "42501" ? 403 : 400);
    }
    throw error;
  }
}
