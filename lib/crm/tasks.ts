import type { Db } from "@/lib/db/pool";
import { alertMembersAfterCommit } from "@/lib/alerts";
import { taskPanelHref } from "@/lib/chat/discussions";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError, notFound } from "@/lib/crm/errors";
import { resolveLinks } from "@/lib/crm/links";
import { detectedIds, detectTaskRecordsInDb, type DetectedLinkIds, type DetectedTaskLinks } from "@/lib/crm/task-detect";
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
  type UserActor,
} from "@/lib/crm/types";
import { isReminderMinutes, REMINDER_LOOKAHEAD_MS } from "@/lib/crm/reminder-options";
import { directTaskSql } from "@/lib/crm/task-access";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { dayWindow, readDateTime } from "@/lib/time";

const TASK_SQL = `
  select
    t.id,
    t.workspace_id,
    t.title,
    t.description,
    t.due_at,
    t.remind_minutes,
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
    nullif(trim(ct.first_name), '') as contact_first_name,
    nullif(trim(ct.last_name), '') as contact_last_name,
    t.opportunity_id,
    op.name as opportunity_name,
    t.created_by_user_id,
    t.created_by_agent_id,
    t.archived_at,
    t.clickup_task_id,
    t.clickup_list_id,
    t.clickup_url,
    t.clickup_error,
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
  remind_minutes: number | null;
  completed_at: Date | string | null;
  priority: TaskPriority;
  owner_id: string | null;
  owner_name: string | null;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  opportunity_id: string | null;
  opportunity_name: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  archived_at: Date | string | null;
  clickup_task_id: string | null;
  clickup_list_id: string | null;
  clickup_url: string | null;
  clickup_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PreparedTask = {
  title?: string;
  description?: string | null;
  dueAt?: string | null;
  remindMinutes?: number | null;
  priority?: TaskPriority;
  ownerId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  completed?: boolean;
  completedAt?: string | null;
};

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    dueAt: iso(row.due_at),
    remindMinutes: row.remind_minutes,
    completedAt: iso(row.completed_at),
    priority: row.priority,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    companyId: row.company_id,
    companyName: row.company_name,
    contactId: row.contact_id,
    contactName: row.contact_name,
    contactFirstName: row.contact_first_name,
    contactLastName: row.contact_last_name,
    opportunityId: row.opportunity_id,
    opportunityName: row.opportunity_name,
    createdByUserId: row.created_by_user_id,
    createdByAgentId: row.created_by_agent_id,
    archivedAt: iso(row.archived_at),
    clickupTaskId: row.clickup_task_id,
    clickupListId: row.clickup_list_id,
    clickupUrl: row.clickup_url,
    clickupError: row.clickup_error,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function timestamp(value: string | null | undefined, field: string) {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const reading = readDateTime(value);
  if (!reading.ok) throw new CrmError("invalid_input", reading.error, 400, { field });
  return reading.date.toISOString();
}

function prepareTask(input: TaskWrite, mode: "create" | "patch"): PreparedTask {
  const next: PreparedTask = {};
  if (input.title !== undefined) {
    const title = cleanText(input.title, 200, "title");
    if (!title) throw new CrmError("invalid_input", "Enter a task.", 400, { field: "title" });
    next.title = title;
  } else if (mode === "create") {
    throw new CrmError("invalid_input", "Enter a task.", 400, { field: "title" });
  }
  if (input.description !== undefined) next.description = cleanText(input.description, 10000, "description");
  if (input.dueAt !== undefined) next.dueAt = timestamp(input.dueAt, "dueAt");
  if (input.remindMinutes !== undefined) {
    if (input.remindMinutes !== null && !isReminderMinutes(input.remindMinutes)) {
      throw new CrmError("invalid_input", "Choose a reminder.", 400, { field: "remindMinutes" });
    }
    next.remindMinutes = input.remindMinutes;
  }
  if (input.priority !== undefined) {
    if (!(TASK_PRIORITIES as readonly string[]).includes(input.priority)) {
      throw new CrmError("invalid_input", "Unknown priority.", 400, { field: "priority" });
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

function actorName(actor: Actor) {
  return actor.type === "user" ? actor.fullName?.trim() || actor.email || "Someone" : actor.agentName || "An agent";
}

function silent(provenance: Provenance | undefined) {
  return provenance?.source === "clickup";
}

function taskAlerts(db: Db, actor: Actor, before: Task | null, task: Task, provenance: Provenance | undefined) {
  if (silent(provenance)) return;
  const name = actorName(actor);
  if (task.ownerId && task.ownerId !== (before?.ownerId ?? null) && !task.completedAt) {
    const handed = Boolean(before && actor.type === "user" && before.ownerId === actor.userId && task.createdByUserId !== actor.userId);
    alertMembersAfterCommit(db, actor, [task.ownerId], {
      source: "task",
      key: `task:${task.id}:owner:${task.ownerId}:${task.updatedAt}`,
      title: handed ? `${name} handed you a task` : `${name} assigned you a task`,
      body: task.title,
      href: taskPanelHref(task.id),
      tag: `task:${task.id}`,
      workspaceId: task.workspaceId,
    });
  }
  if (before && !before.completedAt && task.completedAt && task.createdByUserId) {
    alertMembersAfterCommit(db, actor, [task.createdByUserId], {
      source: "task",
      key: `task:${task.id}:done`,
      title: `Done by ${name}`,
      body: task.title,
      href: `${TASKS_PATH}?view=completed&task=${task.id}`,
      tag: `task:${task.id}`,
      workspaceId: task.workspaceId,
    });
  }
}

export function canChangeTask(actor: Actor, task: { ownerId: string | null; createdByUserId: string | null }) {
  if (actor.type !== "user") return true;
  return actor.role === "owner" || actor.role === "admin" || task.ownerId === actor.userId || task.createdByUserId === actor.userId;
}

async function assertAssignee(db: Db, workspaceId: string, ownerId: string | null | undefined) {
  try {
    await assertOwner(db, workspaceId, ownerId);
  } catch (error) {
    if (error instanceof CrmError && error.code === "invalid_input") {
      throw new CrmError("invalid_input", "Choose an assignee in this workspace.", 400, { field: "ownerId" });
    }
    throw error;
  }
}

async function tagInDb(db: Db, actor: UserActor, task: { id: string; title: string }, userIds: string[], provenance: Provenance | undefined) {
  const added = await db.query<{ user_id: string }>(
    `insert into crm.task_participants (task_id, user_id, added_by)
     select $1, person, $3 from unnest($2::uuid[]) as person
     on conflict (task_id, user_id) do nothing
     returning user_id`,
    [task.id, userIds, actor.userId],
  );
  const fresh = added.rows.map((row) => row.user_id);
  for (const userId of fresh) {
    await recordAudit(db, actor, "task.participant_added", "task", task.id, provenance ?? { operation: "tag_task" }, {
      after: { title: task.title },
      participant: { userId, addedBy: actor.userId },
    });
  }
  return fresh;
}

async function keepAssignerTagged(
  db: Db,
  actor: Actor,
  task: { id: string; title: string; createdByUserId: string | null },
  previousOwner: string | null,
  nextOwner: string | null,
  provenance: Provenance | undefined,
) {
  if (actor.type !== "user" || nextOwner === actor.userId || nextOwner === previousOwner) return false;
  if (nextOwner === null && canChangeTask(actor, { ownerId: null, createdByUserId: task.createdByUserId })) return false;
  return (await tagInDb(db, actor, task, [actor.userId], provenance)).length > 0;
}

async function readTask(db: Db, id: string) {
  const result = await db.query<TaskRow>(`${TASK_SQL} where t.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function createTaskInDb(
  db: Db,
  actor: Actor,
  input: TaskWrite,
  provenance?: Provenance,
  options: { detectedLinks?: DetectedLinkIds; detection?: DetectedTaskLinks } = {},
) {
  const write = prepareTask(input, "create");
  if (!write.title) throw new CrmError("invalid_input", "Enter a task.", 400, { field: "title" });
  if (write.ownerId === undefined && actor.type === "user") write.ownerId = actor.userId;
  await assertAssignee(db, actor.workspaceId, write.ownerId);
  let detectedLinks = Object.keys(options.detectedLinks ?? {});
  let detecting = false;
  if (write.companyId === undefined && write.contactId === undefined && write.opportunityId === undefined) {
    const found = detectedIds(options.detection ?? (await detectTaskRecordsInDb(db, actor.workspaceId, write.title)));
    Object.assign(write, found);
    detectedLinks.push(...Object.keys(found));
    detecting = detectedLinks.length > 0;
  }
  let links;
  try {
    links = await resolveLinks(db, actor.workspaceId, write);
  } catch (error) {
    if (!detecting || !(error instanceof CrmError)) throw error;
    write.companyId = write.contactId = write.opportunityId = undefined;
    detectedLinks = [];
    links = await resolveLinks(db, actor.workspaceId, write);
  }
  const actorRef = actorIds(actor);
  try {
    const inserted = await db.query<{ id: string }>(
      `insert into crm.tasks (
        workspace_id, title, description, due_at, completed_at, priority, owner_id,
        company_id, contact_id, opportunity_id, created_by_user_id, created_by_agent_id, remind_minutes
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
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
        write.remindMinutes ?? null,
      ],
    );
    const saved = await readTask(db, inserted.rows[0].id);
    if (!saved) throw new CrmError("internal_error", "Couldn't save. Try again.", 500);
    const task = mapTask(saved);
    await recordAudit(db, actor, "task.created", "task", task.id, provenance, {
      after: task,
      ...(detectedLinks.length > 0 ? { detectedLinks: [...new Set(detectedLinks)] } : {}),
    });
    if (!silent(provenance)) await keepAssignerTagged(db, actor, task, null, task.ownerId, provenance);
    taskAlerts(db, actor, null, task, provenance);
    return task;
  } catch (error) {
    constraintError(error, "duplicate_task", "A matching task already exists.");
  }
}

function cannotChange(write: PreparedTask = {}) {
  const reassigning = write.ownerId !== undefined;
  return new CrmError(
    "forbidden",
    `Only the assignee, the task's creator, a workspace owner or an admin can ${reassigning ? "reassign" : "change"} it.`,
    403,
    reassigning ? { field: "ownerId" } : undefined,
  );
}

async function applyTask(
  db: Db,
  actor: Actor,
  current: TaskRow,
  write: PreparedTask,
  provenance: Provenance | undefined,
  options: { restoring?: boolean; undoing?: string | null } = {},
) {
  await assertAssignee(db, actor.workspaceId, write.ownerId);
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
    write.completedAt !== undefined
      ? write.completedAt
      : write.completed === undefined
        ? undefined
        : write.completed
          ? (iso(current.completed_at) ?? new Date().toISOString())
          : null;
  const change = assignColumns([
    [write.title !== undefined, "title", "title", write.title ?? null],
    [write.description !== undefined, "description", "description", write.description ?? null],
    [write.dueAt !== undefined, "due_at", "dueAt", write.dueAt ?? null],
    [write.remindMinutes !== undefined, "remind_minutes", "remindMinutes", write.remindMinutes ?? null],
    [write.priority !== undefined, "priority", "priority", write.priority ?? null],
    [write.ownerId !== undefined, "owner_id", "ownerId", write.ownerId ?? null],
    [write.companyId !== undefined || write.contactId !== undefined || write.opportunityId !== undefined, "company_id", "companyId", links.companyId],
    [write.contactId !== undefined, "contact_id", "contactId", links.contactId],
    [write.opportunityId !== undefined, "opportunity_id", "opportunityId", links.opportunityId],
    [completedAt !== undefined, "completed_at", "completedAt", completedAt ?? null],
  ]);
  const before = mapTask(current);
  if (change.sets.length === 0) return { task: before, changed: false };
  const nextOwner = write.ownerId === undefined ? undefined : (write.ownerId ?? null);
  const reassigning = nextOwner !== undefined && nextOwner !== current.owner_id && canChangeTask(actor, { ownerId: current.owner_id, createdByUserId: current.created_by_user_id });
  let taggedAssigner = false;
  if (reassigning && !options.restoring && !silent(provenance)) {
    taggedAssigner = await keepAssignerTagged(db, actor, { id: current.id, title: current.title, createdByUserId: current.created_by_user_id }, current.owner_id, nextOwner, provenance);
  }
  change.values.push(current.id);
  let updated = 0;
  try {
    const result = await db.query(
      `update crm.tasks set ${change.sets.join(", ")} where id = $${change.values.length}`,
      change.values,
    );
    updated = result.rowCount ?? 0;
  } catch (error) {
    if (isPgError(error) && error.code === "42501") throw cannotChange(write);
    constraintError(error, "duplicate_task", "A matching task already exists.");
  }
  if (updated === 0) throw cannotChange(write);
  const saved = await readTask(db, current.id);
  if (!saved) throw notFound("task");
  const task = mapTask(saved);
  if (reassigning && options.restoring && options.undoing && actor.type === "user" && canChangeTask(actor, task) && !silent(provenance)) {
    const untagged = await db.query(
      `delete from crm.task_participants p
       using crm.audit_events e
       where e.id = $3 and e.entity_id = p.task_id and coalesce((e.changes ->> 'taggedAssigner')::boolean, false)
         and p.task_id = $1 and p.user_id = $2 and p.added_by = $2 and p.created_at = e.created_at
       returning p.user_id`,
      [current.id, actor.userId, options.undoing],
    );
    if ((untagged.rowCount ?? 0) > 0) {
      await recordAudit(db, actor, "task.participant_removed", "task", current.id, provenance, {
        after: { title: task.title },
        participant: { userId: actor.userId, removedBy: actor.userId },
      });
    }
  }
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
    {
      ...changedFields(
        before as unknown as Record<string, unknown>,
        task as unknown as Record<string, unknown>,
        change.fields,
      ),
      ...(taggedAssigner ? { taggedAssigner: true } : {}),
    },
  );
  taskAlerts(db, actor, before, task, provenance);
  return { task, changed: true };
}

export async function updateTaskInDb(
  db: Db,
  actor: Actor,
  id: string,
  input: TaskWrite,
  provenance?: Provenance,
) {
  const current = await readTask(db, id);
  if (!current) throw notFound("task");
  return applyTask(db, actor, current, prepareTask(input, "patch"), provenance);
}

export function mineFilter(actor: Actor, values: unknown[], alias = "t") {
  if (actor.type !== "user") return null;
  values.push(actor.userId);
  return `(${alias}.owner_id = $${values.length} or (${alias}.owner_id is null and ${directTaskSql(alias)}))`;
}

export function taggedFilter(actor: Actor, values: unknown[], alias = "t") {
  if (actor.type !== "user") return "false";
  values.push(actor.userId);
  const ref = `$${values.length}`;
  return `(${alias}.owner_id is distinct from ${ref} and exists (
    select 1 from crm.task_participants tagged where tagged.task_id = ${alias}.id and tagged.user_id = ${ref}
  ))`;
}

export async function countOpenTasks(actor: Actor, options: { mine?: boolean } = {}) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const mine = options.mine ? mineFilter(actor, values) : null;
    const result = await db.query<{ total: number }>(
      `select count(*)::int as total
       from crm.tasks t
       where t.workspace_id = $1 and t.archived_at is null and t.completed_at is null and ${directTaskSql("t")}${mine ? ` and ${mine}` : ""}`,
      values,
    );
    return result.rows[0]?.total ?? 0;
  });
}

export async function listTasks(actor: Actor, query: TaskListQuery = {}, options: { maxLimit?: number } = {}) {
  assertScope(actor.scopes, "crm:read");
  const page = options.maxLimit
    ? { limit: Math.min(options.maxLimit, Math.max(1, query.limit ?? 50)), offset: Math.min(10_000, Math.max(0, query.offset ?? 0)) }
    : pageWindow(query.limit, query.offset);
  const view: TaskView | undefined = query.view;
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["t.workspace_id = $1"];
    if (!query.includeArchived) where.push("t.archived_at is null");
    if (query.companyId) {
      values.push(query.companyId);
      where.push(`t.company_id = $${values.length}`);
    }
    if (query.contactId) {
      values.push(query.contactId);
      where.push(`t.contact_id = $${values.length}`);
    }
    if (query.tagged) where.push(taggedFilter(actor, values));
    else {
      where.push(directTaskSql("t"));
      const mine = query.mine ? mineFilter(actor, values) : null;
      if (mine) where.push(mine);
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
        : `t.due_at asc nulls last,
           case t.priority when 'high' then 0 when 'normal' then 1 else 2 end,
           t.created_at asc`;
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

export async function getTask(actor: Actor, id: string, options: { direct?: boolean } = {}) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw notFound("task");
  return withActor(actor, async (db) => {
    const row = options.direct
      ? (await db.query<TaskRow>(`${TASK_SQL} where t.id = $1 and ${directTaskSql("t")}`, [id])).rows[0]
      : await readTask(db, id);
    if (!row) throw notFound("task");
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
  if (!isUuid(id)) throw notFound("task");
  const provenance = options.provenance ?? { operation: "update_task" };
  const hash = requestHash("update_task", { id, input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const current = await readTask(db, id);
      if (!current) throw notFound("task");
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
  if (!isUuid(id)) throw notFound("task");
  const provenance = options.provenance ?? { operation: "archive_task" };
  const hash = requestHash("archive_task", { id, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, () => archiveTaskInDb(db, actor, id, provenance)),
  );
}

export async function archiveTaskInDb(db: Db, actor: Actor, id: string, provenance: Provenance) {
  const current = await readTask(db, id);
  if (!current) throw notFound("task");
  if (current.archived_at) return { task: mapTask(current) };
  const archived = await db.query("update crm.tasks set archived_at = now() where id = $1", [id]);
  if ((archived.rowCount ?? 0) === 0) throw cannotChange();
  const saved = await readTask(db, id);
  if (!saved) throw notFound("task");
  const task = mapTask(saved);
  await recordAudit(db, actor, "task.archived", "task", task.id, provenance, {
    before: { archivedAt: null },
    after: { archivedAt: task.archivedAt },
  });
  return { task };
}

export async function unarchiveTaskInDb(db: Db, actor: Actor, id: string, provenance: Provenance) {
  const current = await readTask(db, id);
  if (!current) throw notFound("task");
  if (!current.archived_at) return { task: mapTask(current) };
  const restored = await db.query("update crm.tasks set archived_at = null where id = $1", [id]);
  if ((restored.rowCount ?? 0) === 0) throw cannotChange();
  const saved = await readTask(db, id);
  if (!saved) throw notFound("task");
  const task = mapTask(saved);
  await recordAudit(db, actor, "task.updated", "task", task.id, provenance, {
    fields: ["archivedAt"],
    before: { archivedAt: iso(current.archived_at) },
    after: { archivedAt: null },
  });
  return { task };
}

export async function readTaskInDb(db: Db, id: string) {
  const row = await readTask(db, id);
  return row ? mapTask(row) : null;
}

export async function restoreTaskInDb(
  db: Db,
  actor: Actor,
  id: string,
  input: TaskWrite,
  completedAt: string | null | undefined,
  provenance: Provenance,
  undoing: string | null = null,
) {
  const current = await readTask(db, id);
  if (!current) throw notFound("task");
  const write = prepareTask(input, "patch");
  if (completedAt !== undefined) write.completedAt = completedAt;
  return applyTask(db, actor, current, write, provenance, { restoring: true, undoing });
}

export type DueReminder = {
  id: string;
  title: string;
  dueAt: string;
  remindMinutes: number;
  companyName: string | null;
  contactName: string | null;
};

export async function listDueReminders(actor: Actor, now = new Date()): Promise<DueReminder[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId, now.toISOString(), new Date(now.getTime() + REMINDER_LOOKAHEAD_MS).toISOString()];
    const mine = mineFilter(actor, values);
    const result = await db.query<TaskRow>(
      `${TASK_SQL}
       where t.workspace_id = $1${mine ? ` and ${mine}` : ""}
         and t.remind_minutes is not null
         and t.due_at is not null
         and t.completed_at is null
         and t.archived_at is null
         and t.due_at > $2::timestamptz
         and t.due_at - make_interval(mins => t.remind_minutes) <= $3::timestamptz
       order by t.due_at
       limit 50`,
      values,
    );
    return result.rows.map((row) => {
      const task = mapTask(row);
      return {
        id: task.id,
        title: task.title,
        dueAt: task.dueAt ?? now.toISOString(),
        remindMinutes: task.remindMinutes ?? 0,
        companyName: task.companyName,
        contactName: task.contactName,
      };
    });
  });
}

export async function listTaskParticipants(actor: UserActor, taskIds: string[]): Promise<Record<string, string[]>> {
  assertScope(actor.scopes, "crm:read");
  const ids = [...new Set(taskIds.filter(isUuid))];
  if (ids.length === 0) return {};
  return withActor(actor, async (db) => {
    const result = await db.query<{ task_id: string; user_id: string }>(
      `select p.task_id, p.user_id from crm.task_participants p
       join crm.tasks t on t.id = p.task_id
       where p.task_id = any($1::uuid[]) and p.user_id is distinct from t.owner_id
       order by p.created_at, p.user_id`,
      [ids],
    );
    const byTask: Record<string, string[]> = {};
    for (const row of result.rows) (byTask[row.task_id] ??= []).push(row.user_id);
    return byTask;
  });
}

export async function addTaskParticipantsInDb(db: Db, actor: UserActor, taskId: string, userIds: string[], provenance?: Provenance, options: { alert?: boolean } = {}) {
  const task = await readTask(db, taskId);
  if (!task) throw notFound("task");
  const wanted = [...new Set(userIds.filter(isUuid).map((id) => id.toLowerCase()))].filter((id) => id !== task.owner_id);
  if (wanted.length === 0) return [];
  const members = await db.query<{ user_id: string }>(
    "select user_id from crm.workspace_members where workspace_id = $1 and user_id = any($2::uuid[])",
    [task.workspace_id, wanted],
  );
  if (members.rows.length !== wanted.length) {
    throw new CrmError("invalid_input", "Choose people in this workspace.", 400, { field: "userIds" });
  }
  const fresh = await tagInDb(db, actor, { id: task.id, title: task.title }, wanted, provenance);
  if (fresh.length > 0 && options.alert !== false) {
    alertMembersAfterCommit(db, actor, fresh, {
      source: "task",
      key: `task:${taskId}:tagged:${Date.now()}`,
      title: `${actorName(actor)} tagged you in a task`,
      body: task.title,
      href: taskPanelHref(taskId, { tagged: true }),
      tag: `task:${taskId}`,
      workspaceId: task.workspace_id,
    });
  }
  return fresh;
}

export async function addTaskParticipants(actor: UserActor, taskId: string, userIds: string[]) {
  assertScope(actor.scopes, "tasks:write");
  if (!isUuid(taskId)) throw notFound("task");
  return withActor(actor, (db) => addTaskParticipantsInDb(db, actor, taskId, userIds));
}

export async function removeTaskParticipant(actor: UserActor, taskId: string, userId: string, provenance?: Provenance) {
  assertScope(actor.scopes, "tasks:write");
  if (!isUuid(taskId)) throw notFound("task");
  if (!isUuid(userId)) return false;
  return withActor(actor, async (db) => {
    const task = await readTask(db, taskId);
    if (!task) throw notFound("task");
    if (task.owner_id === userId) return false;
    const listed = await db.query("select 1 from crm.task_participants where task_id = $1 and user_id = $2", [taskId, userId]);
    if ((listed.rowCount ?? 0) === 0) return false;
    const removed = await db.query("delete from crm.task_participants where task_id = $1 and user_id = $2", [taskId, userId]);
    if ((removed.rowCount ?? 0) === 0) throw new CrmError("forbidden", "You can't remove them from this task.", 403);
    await recordAudit(db, actor, "task.participant_removed", "task", taskId, provenance ?? { operation: "untag_task" }, {
      after: { title: task.title },
      participant: { userId, removedBy: actor.userId },
    });
    return true;
  });
}
