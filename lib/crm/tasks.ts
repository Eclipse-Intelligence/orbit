import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { resolveLinks } from "@/lib/crm/links";
import {
  actorIds,
  assertOwner,
  assignColumns,
  changedFields,
  constraintError,
  iso,
  isUuid,
  pageWindow,
  recordAudit,
  replayOrRun,
  requestHash,
  type MutationOptions,
  type MutationOutcome,
} from "@/lib/crm/mutate";
import { cleanText, likePattern } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import {
  TASK_PRIORITIES,
  type Actor,
  type Provenance,
  type Task,
  type TaskListQuery,
  type TaskPriority,
  type TaskView,
  type TaskWrite,
} from "@/lib/crm/types";

const TASK_SQL = `
  select
    t.id,
    t.workspace_id,
    t.title,
    t.description,
    t.due_at,
    t.completed_at,
    t.priority,
    t.owner_id,
    p.full_name as owner_name,
    t.company_id,
    co.name as company_name,
    t.contact_id,
    coalesce(
      nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''),
      ct.email,
      ct.phone
    ) as contact_name,
    t.opportunity_id,
    op.name as opportunity_name,
    t.created_by_user_id,
    t.created_by_agent_id,
    t.archived_at,
    t.created_at,
    t.updated_at
  from crm.tasks t
  left join crm.profiles p on p.id = t.owner_id
  left join crm.companies co on co.id = t.company_id
  left join crm.contacts ct on ct.id = t.contact_id
  left join crm.opportunities op on op.id = t.opportunity_id
`;

type TaskRow = {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  due_at: Date | string | null;
  completed_at: Date | string | null;
  priority: TaskPriority;
  owner_id: string | null;
  owner_name: string | null;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  opportunity_id: string | null;
  opportunity_name: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PreparedTask = {
  title?: string;
  description?: string | null;
  dueAt?: string | null;
  priority?: TaskPriority;
  ownerId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  completed?: boolean;
};

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    dueAt: iso(row.due_at),
    completedAt: iso(row.completed_at),
    priority: row.priority,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    companyId: row.company_id,
    companyName: row.company_name,
    contactId: row.contact_id,
    contactName: row.contact_name,
    opportunityId: row.opportunity_id,
    opportunityName: row.opportunity_name,
    createdByUserId: row.created_by_user_id,
    createdByAgentId: row.created_by_agent_id,
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function timestamp(value: string | null | undefined, field: string) {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CrmError("invalid_input", "Enter a valid date and time.", 400, { field });
  }
  return date.toISOString();
}

function prepareTask(input: TaskWrite, mode: "create" | "patch"): PreparedTask {
  const next: PreparedTask = {};
  if (input.title !== undefined) {
    const title = cleanText(input.title, 200, "title");
    if (!title) throw new CrmError("invalid_input", "Enter a next action.", 400, { field: "title" });
    next.title = title;
  } else if (mode === "create") {
    throw new CrmError("invalid_input", "Enter a next action.", 400, { field: "title" });
  }
  if (input.description !== undefined) next.description = cleanText(input.description, 10000, "description");
  if (input.dueAt !== undefined) next.dueAt = timestamp(input.dueAt, "dueAt");
  if (input.priority !== undefined) {
    if (!(TASK_PRIORITIES as readonly string[]).includes(input.priority)) {
      throw new CrmError("invalid_input", "Priority is not recognised.", 400, { field: "priority" });
    }
    next.priority = input.priority;
  }
  if (input.ownerId !== undefined) next.ownerId = input.ownerId || null;
  if (input.companyId !== undefined) next.companyId = input.companyId || null;
  if (input.contactId !== undefined) next.contactId = input.contactId || null;
  if (input.opportunityId !== undefined) next.opportunityId = input.opportunityId || null;
  if (input.completed !== undefined) next.completed = input.completed;
  return next;
}

async function readTask(db: Db, id: string) {
  const result = await db.query<TaskRow>(`${TASK_SQL} where t.id = $1`, [id]);
  return result.rows[0] ?? null;
}

function dayWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export async function createTaskInDb(
  db: Db,
  actor: Actor,
  input: TaskWrite,
  provenance?: Provenance,
) {
  const write = prepareTask(input, "create");
  if (!write.title) throw new CrmError("invalid_input", "Enter a next action.", 400, { field: "title" });
  await assertOwner(db, actor.workspaceId, write.ownerId);
  const links = await resolveLinks(db, actor.workspaceId, write);
  const actorRef = actorIds(actor);
  try {
    const inserted = await db.query<{ id: string }>(
      `insert into crm.tasks (
        workspace_id, title, description, due_at, completed_at, priority, owner_id,
        company_id, contact_id, opportunity_id, created_by_user_id, created_by_agent_id
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      ) returning id`,
      [
        actor.workspaceId,
        write.title,
        write.description ?? null,
        write.dueAt ?? null,
        write.completed ? new Date().toISOString() : null,
        write.priority ?? "normal",
        write.ownerId ?? null,
        links.companyId,
        links.contactId,
        links.opportunityId,
        actorRef.userId,
        actorRef.agentId,
      ],
    );
    const saved = await readTask(db, inserted.rows[0].id);
    if (!saved) throw new CrmError("internal_error", "Next action was not saved.", 500);
    const task = mapTask(saved);
    await recordAudit(db, actor, "task.created", "task", task.id, provenance, { after: task });
    return task;
  } catch (error) {
    constraintError(error, "duplicate_task", "That next action already exists.");
  }
}

async function applyTask(
  db: Db,
  actor: Actor,
  current: TaskRow,
  write: PreparedTask,
  provenance: Provenance | undefined,
) {
  await assertOwner(db, actor.workspaceId, write.ownerId);
  const links = await resolveLinks(
    db,
    actor.workspaceId,
    write,
    {
      companyId: current.company_id,
      contactId: current.contact_id,
      opportunityId: current.opportunity_id,
    },
  );
  const completedAt =
    write.completed === undefined
      ? undefined
      : write.completed
        ? (iso(current.completed_at) ?? new Date().toISOString())
        : null;
  const change = assignColumns([
    [write.title !== undefined, "title", "title", write.title ?? null],
    [write.description !== undefined, "description", "description", write.description ?? null],
    [write.dueAt !== undefined, "due_at", "dueAt", write.dueAt ?? null],
    [write.priority !== undefined, "priority", "priority", write.priority ?? null],
    [write.ownerId !== undefined, "owner_id", "ownerId", write.ownerId ?? null],
    [write.companyId !== undefined || write.contactId !== undefined || write.opportunityId !== undefined, "company_id", "companyId", links.companyId],
    [write.contactId !== undefined, "contact_id", "contactId", links.contactId],
    [write.opportunityId !== undefined, "opportunity_id", "opportunityId", links.opportunityId],
    [completedAt !== undefined, "completed_at", "completedAt", completedAt ?? null],
  ]);
  const before = mapTask(current);
  if (change.sets.length === 0) return { task: before, changed: false };
  change.values.push(current.id);
  try {
    await db.query(
      `update crm.tasks set ${change.sets.join(", ")} where id = $${change.values.length}`,
      change.values,
    );
  } catch (error) {
    constraintError(error, "duplicate_task", "That next action already exists.");
  }
  const saved = await readTask(db, current.id);
  if (!saved) throw new CrmError("not_found", "Next action not found.", 404);
  const task = mapTask(saved);
  const event =
    before.completedAt !== task.completedAt
      ? task.completedAt
        ? "task.completed"
        : "task.reopened"
      : "task.updated";
  await recordAudit(
    db,
    actor,
    event,
    "task",
    task.id,
    provenance,
    changedFields(
      before as unknown as Record<string, unknown>,
      task as unknown as Record<string, unknown>,
      change.fields,
    ),
  );
  return { task, changed: true };
}

export async function countOpenTasks(actor: Actor) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<{ total: number }>(
      `select count(*)::int as total
       from crm.tasks
       where workspace_id = $1 and archived_at is null and completed_at is null`,
      [actor.workspaceId],
    );
    return result.rows[0]?.total ?? 0;
  });
}

export async function listTasks(actor: Actor, query: TaskListQuery = {}) {
  assertScope(actor.scopes, "crm:read");
  const page = pageWindow(query.limit, query.offset);
  const view: TaskView | undefined = query.view;
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["t.workspace_id = $1"];
    if (!query.includeArchived) where.push("t.archived_at is null");
    if (query.companyId) {
      values.push(query.companyId);
      where.push(`t.company_id = $${values.length}`);
    }
    if (query.ownerId === "unassigned") where.push("t.owner_id is null");
    else if (query.ownerId) {
      values.push(query.ownerId);
      where.push(`t.owner_id = $${values.length}`);
    }
    const window = dayWindow();
    if (view === "overdue") {
      where.push("t.completed_at is null");
      values.push(window.start.toISOString());
      where.push(`t.due_at < $${values.length}`);
    } else if (view === "today") {
      where.push("t.completed_at is null");
      values.push(window.start.toISOString(), window.end.toISOString());
      where.push(`(t.due_at is null or (t.due_at >= $${values.length - 1} and t.due_at < $${values.length}))`);
    } else if (view === "upcoming") {
      where.push("t.completed_at is null");
      values.push(window.end.toISOString());
      where.push(`t.due_at >= $${values.length}`);
    } else if (view === "completed") {
      values.push(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
      where.push(`t.completed_at is not null and t.completed_at >= $${values.length}`);
    } else if (view !== "none") {
      where.push("t.completed_at is null");
    }
    const text = query.query?.trim();
    if (text) {
      values.push(likePattern(text.slice(0, 200)));
      const ref = `$${values.length}`;
      where.push(`(
        t.title ilike ${ref} escape '\\'
        or coalesce(t.description, '') ilike ${ref} escape '\\'
        or coalesce(co.name, '') ilike ${ref} escape '\\'
      )`);
    }
    const whereSql = where.join(" and ");
    const count = await db.query<{ total: number }>(
      `select count(*)::int as total
       from crm.tasks t
       left join crm.companies co on co.id = t.company_id
       where ${whereSql}`,
      values,
    );
    const order =
      view === "completed"
        ? "t.completed_at desc"
        : "t.due_at asc nulls last, t.priority desc, t.created_at asc";
    const listed = [...values, page.limit, page.offset];
    const rows = await db.query<TaskRow>(
      `${TASK_SQL}
       where ${whereSql}
       order by ${order}, t.id asc
       limit $${listed.length - 1} offset $${listed.length}`,
      listed,
    );
    return {
      data: rows.rows.map(mapTask),
      total: count.rows[0]?.total ?? 0,
      limit: page.limit,
      offset: page.offset,
    };
  });
}

export async function getTask(actor: Actor, id: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Next action not found.", 404);
  return withActor(actor, async (db) => {
    const row = await readTask(db, id);
    if (!row) throw new CrmError("not_found", "Next action not found.", 404);
    return mapTask(row);
  });
}

export async function createTask(
  actor: Actor,
  input: TaskWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ task: Task }>> {
  assertScope(actor.scopes, "tasks:write");
  const provenance = options.provenance ?? { operation: "create_task" };
  const hash = requestHash("create_task", { input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 201, async () => ({
      task: await createTaskInDb(db, actor, input, provenance),
    })),
  );
}

export async function updateTask(
  actor: Actor,
  id: string,
  input: TaskWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ task: Task }>> {
  assertScope(actor.scopes, "tasks:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Next action not found.", 404);
  const provenance = options.provenance ?? { operation: "update_task" };
  const hash = requestHash("update_task", { id, input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const current = await readTask(db, id);
      if (!current) throw new CrmError("not_found", "Next action not found.", 404);
      const updated = await applyTask(db, actor, current, prepareTask(input, "patch"), provenance);
      return { task: updated.task };
    }),
  );
}

export async function completeTask(
  actor: Actor,
  id: string,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ task: Task }>> {
  return updateTask(actor, id, { completed: true }, {
    ...options,
    provenance: options.provenance ?? { operation: "complete_task" },
  });
}

export async function archiveTask(
  actor: Actor,
  id: string,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ task: Task }>> {
  assertScope(actor.scopes, "tasks:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Next action not found.", 404);
  const provenance = options.provenance ?? { operation: "archive_task" };
  const hash = requestHash("archive_task", { id, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const current = await readTask(db, id);
      if (!current) throw new CrmError("not_found", "Next action not found.", 404);
      if (current.archived_at) return { task: mapTask(current) };
      await db.query("update crm.tasks set archived_at = now() where id = $1", [id]);
      const saved = await readTask(db, id);
      if (!saved) throw new CrmError("not_found", "Next action not found.", 404);
      const task = mapTask(saved);
      await recordAudit(db, actor, "task.archived", "task", task.id, provenance, {
        before: { archivedAt: null },
        after: { archivedAt: task.archivedAt },
      });
      return { task };
    }),
  );
}
