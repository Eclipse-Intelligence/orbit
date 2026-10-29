import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit } from "@/lib/crm/mutate";
import type { Actor, Provenance } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { assertDocsRead, assertDocsWrite, placeableFolder, visibilityError, visibilityOf } from "@/lib/docs/store";
import { FOLDER_NAME_MAX, type DocFolder, type FolderMoveResult, type FolderSharing, type VisibilityChange } from "@/lib/docs/types";

type FolderRow = {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  user_id: string | null;
  owner_name: string | null;
  shared: boolean;
  effective_shared: boolean;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  page_count: number;
  parent_visible: boolean;
  created_by_agent_id: string | null;
  creator_agent_name: string | null;
};

const FOLDER_SELECT = `select f.id, f.workspace_id, f.parent_id, f.name, f.position, f.user_id, coalesce(nullif(o.full_name, ''), o.email) as owner_name,
  f.shared, f.effective_shared, f.created_at, f.updated_at, f.archived_at,
  (select count(*)::int from crm.pages p where p.folder_id = f.id and p.archived_at is null) as page_count,
  (f.parent_id is null or exists (select 1 from crm.page_folders up where up.id = f.parent_id)) as parent_visible,
  f.created_by_agent_id, creator.name as creator_agent_name
  from crm.page_folders f left join crm.profiles o on o.id = f.user_id left join crm.agents creator on creator.id = f.created_by_agent_id`;

const NOT_FOUND = "That folder doesn't exist, or it's private to someone else.";
const DEFAULT_PROVENANCE: Provenance = { operation: "docs" };

function mapFolder(actor: Actor, row: FolderRow): DocFolder {
  return {
    id: row.id,
    parentId: row.parent_visible ? row.parent_id : null,
    name: row.name,
    position: row.position,
    owner: row.user_id ? { id: row.user_id, name: row.owner_name ?? "Former member" } : null,
    createdByAgent: row.created_by_agent_id ? { id: row.created_by_agent_id, name: row.creator_agent_name ?? "Agent" } : null,
    ownedByMe: actor.type === "user" && row.user_id === actor.userId,
    shared: row.shared,
    effectiveShared: row.effective_shared,
    visibility: visibilityOf(row.shared, row.effective_shared),
    pageCount: row.page_count,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    archivedAt: iso(row.archived_at),
  };
}

function checkName(value: unknown) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new CrmError("invalid_input", "Give the folder a name.", 400, { field: "name" });
  if (name.length > FOLDER_NAME_MAX) throw new CrmError("invalid_input", `A folder name can be up to ${FOLDER_NAME_MAX} characters.`, 400, { field: "name" });
  return name;
}

async function loadFolder(db: Db, actor: Actor, id: string, lock = false) {
  if (!isUuid(id)) throw new CrmError("not_found", NOT_FOUND, 404);
  const result = await db.query<FolderRow>(`${FOLDER_SELECT} where f.id = $1 and f.workspace_id = $2${lock ? " for update of f" : ""}`, [id, actor.workspaceId]);
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", NOT_FOUND, 404);
  return row;
}

async function auditFolder(db: Db, actor: Actor, event: string, folder: FolderRow, provenance: Provenance | undefined, changes: Record<string, unknown>, wasShared = folder.effective_shared) {
  if (!folder.effective_shared && !wasShared) return;
  await recordAudit(db, actor, event, "page_folder", folder.id, provenance ?? DEFAULT_PROVENANCE, { name: folder.name, ...changes });
}

export async function listFolders(actor: Actor, options: { archived?: boolean } = {}): Promise<DocFolder[]> {
  assertDocsRead(actor);
  return withActor(actor, async (db) => {
    const result = await db.query<FolderRow>(
      `${FOLDER_SELECT} where f.workspace_id = $1 and ${options.archived ? "f.archived_at is not null" : "f.archived_at is null"}
       order by f.position, lower(f.name), f.id`,
      [actor.workspaceId],
    );
    return result.rows.map((row) => mapFolder(actor, row));
  });
}

export async function getFolder(actor: Actor, id: string) {
  assertDocsRead(actor);
  return withActor(actor, async (db) => mapFolder(actor, await loadFolder(db, actor, id)));
}

async function nextPosition(db: Db, actor: Actor, parentId: string | null) {
  const result = await db.query<{ next: number }>(
    "select coalesce(max(position), -1) + 1 as next from crm.page_folders where workspace_id = $1 and parent_id is not distinct from $2 and archived_at is null",
    [actor.workspaceId, parentId],
  );
  return Number(result.rows[0]?.next ?? 0);
}

export async function createFolder(actor: Actor, input: { name: unknown; parentId?: string | null; shared?: boolean }, provenance?: Provenance) {
  assertDocsWrite(actor);
  const name = checkName(input.name);
  return withActor(actor, async (db) => {
    const parent = input.parentId ? await placeableFolder(db, actor, input.parentId, actor.type === "user" ? actor.userId : null) : null;
    const owner = actor.type === "user" ? actor.userId : null;
    const shared = owner === null ? true : input.shared === true;
    const inserted = await db.query<{ id: string }>(
      `insert into crm.page_folders (workspace_id, user_id, parent_id, name, position, shared, created_by_agent_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [actor.workspaceId, owner, parent?.id ?? null, name, await nextPosition(db, actor, parent?.id ?? null), shared, actor.type === "agent" ? actor.agentId : null],
    );
    const folder = await loadFolder(db, actor, inserted.rows[0].id);
    await auditFolder(db, actor, "page_folder.created", folder, provenance, { parentId: folder.parent_id });
    return mapFolder(actor, folder);
  });
}

export async function renameFolder(actor: Actor, id: string, name: unknown, provenance?: Provenance) {
  assertDocsWrite(actor);
  const next = checkName(name);
  return withActor(actor, async (db) => {
    const folder = await loadFolder(db, actor, id, true);
    if (folder.name !== next) {
      await db.query("update crm.page_folders set name = $2 where id = $1", [folder.id, next]);
      await auditFolder(db, actor, "page_folder.updated", { ...folder, name: next }, provenance, { previousName: folder.name });
    }
    return mapFolder(actor, await loadFolder(db, actor, id));
  });
}

async function placeAmongSiblings(db: Db, actor: Actor, id: string, parentId: string | null, index: number | undefined) {
  const siblings = await db.query<{ id: string }>(
    `select id from crm.page_folders where workspace_id = $1 and parent_id is not distinct from $2 and archived_at is null and id <> $3
     order by position, lower(name), id`,
    [actor.workspaceId, parentId, id],
  );
  const order = siblings.rows.map((row) => row.id);
  const at = index === undefined ? order.length : Math.max(0, Math.min(order.length, Math.trunc(index)));
  order.splice(at, 0, id);
  await db.query(
    `update crm.page_folders f set position = x.position from unnest($1::uuid[], $2::int[]) as x(id, position)
     where f.id = x.id and f.position <> x.position`,
    [order, order.map((_, position) => position)],
  );
}

export async function moveFolder(
  actor: Actor,
  id: string,
  input: { parentId: string | null; index?: number; allowVisibilityChange?: boolean },
  provenance?: Provenance,
): Promise<FolderMoveResult> {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const folder = await loadFolder(db, actor, id, true);
    if (folder.archived_at) throw new CrmError("invalid_input", "This folder is archived. Restore it before moving it.", 400);
    if (input.parentId === folder.id) throw new CrmError("invalid_input", "A folder can't go inside itself.", 400, { field: "parentId" });
    const parent = input.parentId ? await placeableFolder(db, actor, input.parentId, folder.user_id) : null;
    const before = visibilityOf(folder.shared, folder.effective_shared);
    const afterShared = folder.shared || Boolean(parent?.effective_shared);
    const after = visibilityOf(folder.shared, afterShared);
    const change: VisibilityChange = { before, after, changed: (before === "private") !== (after === "private") };
    if (!afterShared && !(actor.type === "user" && folder.user_id === actor.userId)) {
      throw new CrmError("forbidden", `That would make it private to ${folder.owner_name ?? "its owner"}, so only they can move it there.`, 403, { field: "parentId" });
    }
    if (change.changed && !input.allowVisibilityChange) throw visibilityError(after, parent ? parent.name : "the top level");
    const moving = (folder.parent_id ?? null) !== (parent?.id ?? null);
    if (moving) {
      try {
        await db.query("update crm.page_folders set parent_id = $2 where id = $1", [folder.id, parent?.id ?? null]);
      } catch (error) {
        if ((error as { code?: string }).code === "23514") throw new CrmError("invalid_input", "A folder can't go inside one of its own folders.", 400, { field: "parentId" });
        throw busyError(error);
      }
    }
    await placeAmongSiblings(db, actor, folder.id, parent?.id ?? null, input.index);
    const moved = await loadFolder(db, actor, id);
    if (moving) await auditFolder(db, actor, "page_folder.moved", moved, provenance, { parentId: moved.parent_id, previousParentId: folder.parent_id, visibility: after }, folder.effective_shared);
    return { folder: mapFolder(actor, moved), visibility: change };
  });
}

function busyError(error: unknown) {
  if (isPgError(error) && error.code === "40P01") {
    return new CrmError("conflict", "Someone else was changing these folders at the same moment. Try again.", 409);
  }
  return error;
}

async function sharing(db: Db, folder: FolderRow): Promise<FolderSharing> {
  const result = await db.query<{ docs: number; folders: number; shared_on_their_own: number; owned_by_others: number }>(
    `with recursive tree as (
       select f.id from crm.page_folders f where f.id = $1
       union all
       select c.id from crm.page_folders c join tree t on c.parent_id = t.id
     )
     select
       (select count(*)::int from crm.pages p where p.folder_id in (select id from tree) and p.archived_at is null) as docs,
       (select count(*)::int - 1 from tree) as folders,
       (select count(*)::int from crm.pages p where p.folder_id in (select id from tree) and p.archived_at is null and p.shared) as shared_on_their_own,
       (select count(*)::int from crm.pages p where p.folder_id in (select id from tree) and p.archived_at is null and p.user_id is distinct from $2)
         + (select count(*)::int from crm.page_folders f where f.id in (select id from tree) and f.id <> $1 and f.archived_at is null and f.user_id is distinct from $2) as owned_by_others`,
    [folder.id, folder.user_id],
  );
  const row = result.rows[0];
  return {
    folderId: folder.id,
    shared: folder.shared,
    effectiveShared: folder.effective_shared,
    docs: row.docs,
    folders: row.folders,
    sharedOnTheirOwn: row.shared_on_their_own,
    ownedByOthers: row.owned_by_others,
  };
}

export async function folderSharing(actor: Actor, id: string) {
  assertDocsRead(actor);
  return withActor(actor, async (db) => sharing(db, await loadFolder(db, actor, id)));
}

export async function shareFolder(actor: Actor, id: string, shared: boolean, provenance?: Provenance) {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const folder = await loadFolder(db, actor, id, true);
    if (folder.shared !== shared) {
      if (!shared && !(actor.type === "user" && folder.user_id === actor.userId)) {
        throw new CrmError(
          "forbidden",
          folder.user_id ? `Only ${folder.owner_name ?? "its owner"} can make this folder private.` : "This folder has no owner, so it can't be made private.",
          403,
        );
      }
      const before = await sharing(db, folder);
      try {
        await db.query("update crm.page_folders set shared = $2 where id = $1", [folder.id, shared]);
      } catch (error) {
        throw busyError(error);
      }
      const after = await loadFolder(db, actor, id);
      await auditFolder(db, actor, "page_folder.shared", after, provenance, { shared, docs: before.docs, folders: before.folders }, folder.effective_shared);
      return { folder: mapFolder(actor, after), sharing: { ...before, shared: after.shared, effectiveShared: after.effective_shared } };
    }
    return { folder: mapFolder(actor, folder), sharing: await sharing(db, folder) };
  });
}

export async function archiveFolder(actor: Actor, id: string, provenance?: Provenance) {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const folder = await loadFolder(db, actor, id, true);
    if (folder.archived_at) return mapFolder(actor, folder);
    const stamp = await db.query<{ now: Date }>("select now() as now");
    const at = stamp.rows[0].now;
    await db.query(
      `with recursive tree as (
         select f.id from crm.page_folders f where f.id = $1
         union all
         select c.id from crm.page_folders c join tree t on c.parent_id = t.id where c.archived_at is null
       ),
       pages as (update crm.pages p set archived_at = $2 where p.folder_id in (select id from tree) and p.archived_at is null returning p.id)
       update crm.page_folders f set archived_at = $2 where f.id in (select id from tree) and f.archived_at is null`,
      [folder.id, at],
    );
    await auditFolder(db, actor, "page_folder.archived", folder, provenance, {});
    return mapFolder(actor, await loadFolder(db, actor, id));
  });
}

export async function restoreFolder(actor: Actor, id: string, provenance?: Provenance) {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const folder = await loadFolder(db, actor, id, true);
    if (!folder.archived_at) return mapFolder(actor, folder);
    if (folder.parent_id) {
      const parent = await db.query<{ name: string; archived_at: Date | null }>("select name, archived_at from crm.page_folders where id = $1", [folder.parent_id]);
      if (parent.rows[0]?.archived_at) throw new CrmError("invalid_input", `It's inside ${parent.rows[0].name}, which is archived. Restore that folder first.`, 400);
    }
    await db.query(
      `with recursive tree as (
         select f.id from crm.page_folders f where f.id = $1
         union all
         select c.id from crm.page_folders c join tree t on c.parent_id = t.id where c.archived_at = $2
       ),
       pages as (update crm.pages p set archived_at = null where p.folder_id in (select id from tree) and p.archived_at = $2 returning p.id)
       update crm.page_folders f set archived_at = null where f.id in (select id from tree)`,
      [folder.id, folder.archived_at],
    );
    await auditFolder(db, actor, "page_folder.restored", folder, provenance, {});
    return mapFolder(actor, await loadFolder(db, actor, id));
  });
}
