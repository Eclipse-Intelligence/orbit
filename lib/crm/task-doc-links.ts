import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { canChangeTask, readTaskInDb, updateTaskInDb } from "@/lib/crm/tasks";
import type { Provenance, Task, UserActor } from "@/lib/crm/types";

export const LINK_DOC_FAILED = "Couldn't link the doc. Try again.";
export const UNLINK_DOC_FAILED = "Couldn't remove the link. Try again.";

export async function changeTaskDoc(actor: UserActor, taskId: string, pageId: string, change: "link" | "unlink", provenance: Provenance): Promise<Task> {
  assertScope(actor.scopes, "tasks:write");
  if (!isUuid(taskId)) throw notFound("task");
  if (!isUuid(pageId)) throw new CrmError("invalid_input", change === "link" ? LINK_DOC_FAILED : UNLINK_DOC_FAILED, 400, { field: "docIds" });
  const page = pageId.toLowerCase();
  return withActor(actor, async (db) => {
    await db.query("select 1 from crm.tasks where id = $1 for update", [taskId]);
    const task = await readTaskInDb(db, actor, taskId);
    if (!task || task.workspaceId !== actor.workspaceId || task.archivedAt) throw notFound("task");
    if (!canChangeTask(actor, task)) {
      throw new CrmError("forbidden", "Only the assignee, the task's creator, a workspace owner or an admin can change it.", 403);
    }
    const next = change === "link" ? [...task.docIds.filter((id) => id !== page), page] : task.docIds.filter((id) => id !== page);
    return (await updateTaskInDb(db, actor, taskId, { docIds: next }, provenance)).task;
  });
}
