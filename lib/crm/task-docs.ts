import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError, notFound } from "@/lib/crm/errors";
import { actorIds, iso, isUuid } from "@/lib/crm/mutate";
import { assertScope, hasScope } from "@/lib/crm/scopes";
import { TASK_DOC_IDS_SQL } from "@/lib/crm/task-doc-sql";
import { withMailThreadsInDb } from "@/lib/crm/task-mail";
import { canChangeTask } from "@/lib/crm/task-rights";
import type { Actor, Task, TaskDoc } from "@/lib/crm/types";
import { localDate } from "@/lib/docs/daily";
import { shortDay } from "@/lib/docs/format";

export const MAX_TASK_DOCS = 20;

export const NOT_A_DOC = "Choose a doc you can open in this workspace.";


export type TaskDocEntry = {
  id: string;
  title: string | null;
  readable: boolean;
  reason: "linked" | "mention";
  kind: "note" | "daily";
  shared: boolean;
  folderPath: string | null;
  dailyDate: string | null;
  updatedAt: string | null;
};

export type DocTask = {
  id: string;
  title: string;
  dueAt: string | null;
  dueHasTime: boolean;
  completedAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  tagged: boolean;
};

export function readDocIds(given: unknown): string[] {
  if (given === null || given === undefined) return [];
  if (!Array.isArray(given)) throw new CrmError("invalid_input", "docIds takes a list of doc ids, or an empty list to take them all off.", 400, { field: "docIds" });
  const ids = given.map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""));
  if (ids.some((id) => !isUuid(id))) throw new CrmError("invalid_input", NOT_A_DOC, 400, { field: "docIds" });
  const unique = [...new Set(ids)];
  if (unique.length > MAX_TASK_DOCS) throw new CrmError("invalid_input", `Link up to ${MAX_TASK_DOCS} docs to a task.`, 400, { field: "docIds" });
  return unique;
}

export type TaskDocsPlan = { add: string[]; remove: string[] };

export async function linkableDocIdsInDb(db: Db, actor: Actor, workspaceId: string, ids: string[]) {
  if (ids.length === 0 || !hasScope(actor.scopes, "docs:read")) return [];
  const found = await db.query<{ id: string }>(
    "select p.id from crm.pages p where p.id = any($1::uuid[]) and p.workspace_id = $2 and p.kind = 'note' and p.archived_at is null",
    [ids, workspaceId],
  );
  const linkable = new Set(found.rows.map((row) => row.id));
  return ids.filter((id) => linkable.has(id));
}

export const DOCS_OWNER_ONLY = "Only the task's assignee or creator can change its docs.";

export type TaskDocRights = { ownerId: string | null; createdByUserId: string | null; createdByAgentId: string | null };

export async function planTaskDocsInDb(
  db: Db,
  actor: Actor,
  workspaceId: string,
  current: string[],
  wanted: string[] | undefined,
  options: { lenient?: boolean; task?: TaskDocRights } = {},
): Promise<TaskDocsPlan | null> {
  if (wanted === undefined) return null;
  let add = wanted.filter((id) => !current.includes(id));
  const remove = current.filter((id) => !wanted.includes(id));
  if ((add.length > 0 || remove.length > 0) && options.task && !canChangeTask(actor, options.task)) {
    throw new CrmError("forbidden", DOCS_OWNER_ONLY, 403, { field: "docIds" });
  }
  if (add.length > 0 && !options.lenient && !hasScope(actor.scopes, "docs:read")) {
    throw new CrmError("forbidden", "This token can't read docs, so it can't link them to a task.", 403, { field: "docIds" });
  }
  if (add.length > 0) {
    const linkable = await linkableDocIdsInDb(db, actor, workspaceId, add);
    if (!options.lenient && linkable.length !== add.length) throw new CrmError("invalid_input", NOT_A_DOC, 400, { field: "docIds" });
    add = linkable;
  }
  if (add.length === 0 && remove.length === 0) return null;
  if (current.length - remove.length + add.length > MAX_TASK_DOCS) {
    throw new CrmError("invalid_input", `Link up to ${MAX_TASK_DOCS} docs to a task.`, 400, { field: "docIds" });
  }
  return { add, remove };
}

export async function writeTaskDocsInDb(db: Db, actor: Actor, task: { id: string; workspaceId: string }, plan: TaskDocsPlan) {
  if (plan.remove.length > 0) {
    const removed = await db.query("delete from crm.task_docs where task_id = $1 and page_id = any($2::uuid[]) returning page_id", [task.id, plan.remove]);
    if ((removed.rowCount ?? 0) < plan.remove.length) throw new CrmError("forbidden", DOCS_OWNER_ONLY, 403, { field: "docIds" });
  }
  if (plan.add.length > 0) {
    const by = actorIds(actor);
    try {
      await db.query(
      `insert into crm.task_docs (task_id, page_id, workspace_id, created_by, created_by_agent_id, created_at)
       select $1, item.page, $3, $4, $5, now() + item.place * interval '1 microsecond'
       from unnest($2::uuid[]) with ordinality as item(page, place)
       on conflict (task_id, page_id) do nothing`,
        [task.id, plan.add, task.workspaceId, by.userId, by.agentId],
      );
    } catch (error) {
      if (isPgError(error) && error.code === "42501") throw new CrmError("forbidden", DOCS_OWNER_ONLY, 403, { field: "docIds" });
      if (isPgError(error) && ["23503", "23514"].includes(error.code ?? "")) throw new CrmError("invalid_input", NOT_A_DOC, 400, { field: "docIds" });
      throw error;
    }
  }
}

export function sameDocIds(left: string[] | null | undefined, right: string[] | null | undefined) {
  const a = [...new Set(left ?? [])].sort();
  const b = [...new Set(right ?? [])].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

async function readableTitles(db: Db, viewer: Actor, ids: string[]) {
  const titles = new Map<string, { title: string; archived: boolean }>();
  if (ids.length === 0 || !hasScope(viewer.scopes, "docs:read")) return titles;
  const result = await db.query<{ id: string; title: string; archived: boolean }>(
    "select p.id, p.title, p.archived_at is not null as archived from crm.pages p where p.id = any($1::uuid[])",
    [ids],
  );
  for (const row of result.rows) titles.set(row.id, { title: row.title, archived: row.archived });
  return titles;
}

export async function withTaskDocsInDb<T extends Task>(db: Db, viewer: Actor, tasks: T[]): Promise<T[]> {
  const ids = [...new Set(tasks.flatMap((task) => task.docIds ?? []))];
  const titles = await readableTitles(db, viewer, ids);
  return tasks.map((task) => {
    const docs = (task.docIds ?? []).flatMap((id): TaskDoc[] => {
      const found = titles.get(id);
      if (found?.archived) return [];
      return [found ? { id, title: found.title, readable: true } : { id, title: null, readable: false }];
    });
    return { ...task, docs, canLinkDocs: canChangeTask(viewer, task) };
  });
}

export async function withViewerLinksInDb<T extends Task>(db: Db, viewer: Actor, tasks: T[]): Promise<T[]> {
  return withTaskDocsInDb(db, viewer, await withMailThreadsInDb(db, viewer, tasks));
}

export function withoutViewerLinks<T extends Task>(task: T): Omit<T, "mailThread" | "docs" | "canLinkDocs"> {
  const rest: Partial<T> = { ...task };
  delete rest.mailThread;
  delete rest.docs;
  delete rest.canLinkDocs;
  return rest as Omit<T, "mailThread" | "docs" | "canLinkDocs">;
}

type FolderRow = { id: string; parent_id: string | null; name: string };

export async function folderPathsInDb(db: Db, workspaceId: string) {
  const result = await db.query<FolderRow>("select f.id, f.parent_id, f.name from crm.page_folders f where f.workspace_id = $1 and f.archived_at is null", [workspaceId]);
  const folders = new Map(result.rows.map((row) => [row.id, row]));
  const paths = new Map<string, string>();
  const pathOf = (id: string): string | null => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const names: string[] = [];
    const seen = new Set<string>();
    let at = folders.get(id);
    while (at && !seen.has(at.id) && names.length < 12) {
      seen.add(at.id);
      names.unshift(at.name);
      at = at.parent_id ? folders.get(at.parent_id) : undefined;
    }
    if (names.length === 0) return null;
    const path = names.join(" › ");
    paths.set(id, path);
    return path;
  };
  return (folderId: string | null) => (folderId ? pathOf(folderId) : null);
}

function dailyTitle(day: string) {
  const year = day.slice(0, 4);
  return year === localDate(new Date()).slice(0, 4) ? shortDay(day) : `${shortDay(day)} ${year}`;
}

type DocRow = {
  id: string;
  title: string | null;
  kind: "note" | "daily" | null;
  daily_date: string | null;
  shared: boolean | null;
  folder_id: string | null;
  edited_at: Date | string | null;
  archived: boolean | null;
};

const DOC_FIELDS = `p.id, p.title, p.kind, p.daily_date::text as daily_date, p.effective_shared as shared, p.folder_id, p.edited_at, p.archived_at is not null as archived`;

export async function listTaskDocsInDb(db: Db, viewer: Actor, task: { id: string; workspaceId: string; docIds: string[] }): Promise<TaskDocEntry[]> {
  const reading = hasScope(viewer.scopes, "docs:read");
  const linked = reading && task.docIds.length > 0
    ? (await db.query<DocRow>(`select ${DOC_FIELDS} from crm.pages p where p.id = any($1::uuid[])`, [task.docIds])).rows
    : [];
  const me = viewer.type === "user" ? viewer.userId : null;
  const mentions = reading
    ? (
        await db.query<DocRow>(
          `select ${DOC_FIELDS} from crm.pages p
           where p.archived_at is null
             and (p.workspace_id = $2 or (p.kind = 'daily' and p.user_id = $3::uuid))
             and exists (select 1 from crm.page_links l where l.page_id = p.id and l.target_kind = 'task' and l.target_record_id = $1)
           order by p.edited_at desc
           limit 100`,
          [task.id, task.workspaceId, me],
        )
      ).rows
    : [];
  const pathOf = reading ? await folderPathsInDb(db, task.workspaceId) : () => null;
  const entry = (row: DocRow, reason: TaskDocEntry["reason"]): TaskDocEntry => ({
    id: row.id,
    title: row.kind === "daily" && row.daily_date ? dailyTitle(row.daily_date) : (row.title ?? ""),
    readable: true,
    reason,
    kind: row.kind === "daily" ? "daily" : "note",
    shared: Boolean(row.shared),
    folderPath: pathOf(row.folder_id),
    dailyDate: row.daily_date,
    updatedAt: iso(row.edited_at),
  });
  const found = new Map(linked.map((row) => [row.id, row]));
  const linkedEntries = [...task.docIds].reverse().flatMap((id): TaskDocEntry[] => {
    const row = found.get(id);
    if (row?.archived) return [];
    if (row) return [entry(row, "linked")];
    return [{ id, title: null, readable: false, reason: "linked", kind: "note", shared: false, folderPath: null, dailyDate: null, updatedAt: null }];
  });
  const mentionEntries = mentions.filter((row) => !task.docIds.includes(row.id)).map((row) => entry(row, "mention"));
  return [...linkedEntries, ...mentionEntries];
}

export async function listTaskDocs(actor: Actor, taskId: string): Promise<TaskDocEntry[]> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(taskId)) throw notFound("task");
  return withActor(actor, async (db) => {
    const found = await db.query<{ id: string; workspace_id: string; doc_ids: string[] }>(
      `select t.id, t.workspace_id, ${TASK_DOC_IDS_SQL} as doc_ids
       from crm.tasks t where t.id = $1 and t.workspace_id = $2`,
      [taskId, actor.workspaceId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("task");
    return listTaskDocsInDb(db, actor, { id: row.id, workspaceId: row.workspace_id, docIds: row.doc_ids ?? [] });
  });
}

type DocTaskRow = {
  id: string;
  title: string;
  due_at: Date | string | null;
  due_has_time: boolean;
  completed_at: Date | string | null;
  owner_id: string | null;
  owner_name: string | null;
  tagged: boolean;
};

export async function listDocTasks(actor: Actor, pageId: string): Promise<DocTask[]> {
  assertScope(actor.scopes, "docs:read");
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(pageId)) return [];
  const me = actor.type === "user" ? actor.userId : null;
  return withActor(actor, async (db) => {
    const page = await db.query("select 1 from crm.pages where id = $1 and workspace_id = $2 and kind = 'note'", [pageId, actor.workspaceId]);
    if ((page.rowCount ?? 0) === 0) throw new CrmError("not_found", "That note doesn't exist, or it's private to someone else.", 404);
    const result = await db.query<DocTaskRow>(
      `select t.id, t.title, t.due_at, t.due_has_time, t.completed_at, t.owner_id, nullif(trim(p.full_name), '') as owner_name,
         ($2::uuid is not null and t.owner_id is distinct from $2::uuid and t.created_by_user_id is distinct from $2::uuid
           and exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = $2::uuid)) as tagged
       from crm.task_docs d
       join crm.tasks t on t.id = d.task_id
       left join crm.profiles p on p.id = t.owner_id
       where d.page_id = $1 and t.workspace_id = $3 and d.workspace_id = $3 and t.archived_at is null
       order by (t.completed_at is not null), t.due_at asc nulls last, t.created_at asc, t.id
       limit 200`,
      [pageId, me, actor.workspaceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      dueAt: iso(row.due_at),
      dueHasTime: Boolean(row.due_has_time) && row.due_at !== null,
      completedAt: iso(row.completed_at),
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      tagged: Boolean(row.tagged),
    }));
  });
}
