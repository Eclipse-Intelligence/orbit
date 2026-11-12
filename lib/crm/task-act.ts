import type { Db } from "@/lib/db/pool";
import { bookingUrl } from "@/lib/assistant/links";
import { getBookingPage } from "@/lib/booking/pages";
import { createActivityInDb } from "@/lib/crm/activities";
import { headline } from "@/lib/crm/activity-pad";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound, tooLong } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { splitDescription } from "@/lib/crm/task-description";
import { canChangeTask, createTaskInDb, readTaskInDb, updateTaskInDb } from "@/lib/crm/tasks";
import type { Activity, ActivityType, Provenance, Task, UserActor } from "@/lib/crm/types";

export type TaskPerson = { id: string; name: string; jobTitle: string | null; phone: string | null; email: string | null };

export type TaskContext = {
  opportunity: { id: string; name: string; stage: string | null; status: string; value: string | null; currency: string } | null;
  lastActivity: { type: ActivityType; title: string | null; occurredAt: string } | null;
  lastEmail: { subject: string | null; at: string } | null;
  thread: { key: string; subject: string | null; at: string | null } | null;
  bookingUrl: string | null;
  people: TaskPerson[];
};

export type OutcomeKind = "call" | "email" | "meeting";

export type TaskOutcome = {
  note: string;
  kind: OutcomeKind | null;
  next: { title: string; dueAt: string | null } | null;
};

export type LinkChange = { kind: "contact" | "company" | "opportunity"; id: string | null };

const OUTCOME_KINDS: OutcomeKind[] = ["call", "email", "meeting"];
const PEOPLE_SHOWN = 8;

function cannotChange() {
  return new CrmError("forbidden", "Only the assignee, the task's creator, a workspace owner or an admin can change it.", 403);
}

function linkedThread(description: string | null) {
  for (const link of splitDescription(description).links) {
    const value = new URLSearchParams(link.href.split("?")[1] ?? "").get("thread");
    if (!value) continue;
    const split = value.indexOf("|");
    const sourceId = value.slice(0, split);
    const key = value.slice(split + 1);
    if (split > 0 && isUuid(sourceId) && key && key.length <= 450) return { value, sourceId, key };
  }
  return null;
}

async function opportunityFor(db: Db, workspaceId: string, task: Task) {
  type Row = { id: string; name: string; stage: string | null; status: string; value: string | null; currency: string };
  const columns = "o.id, o.name, s.name as stage, o.status, o.value::text as value, o.currency";
  if (task.opportunityId) {
    const linked = await db.query<Row>(
      `select ${columns} from crm.opportunities o left join crm.pipeline_stages s on s.id = o.stage_id where o.id = $1 and o.workspace_id = $2`,
      [task.opportunityId, workspaceId],
    );
    return linked.rows[0] ?? null;
  }
  if (!task.contactId && !task.companyId) return null;
  const open = await db.query<Row>(
    `select ${columns} from crm.opportunities o
     left join crm.pipeline_stages s on s.id = o.stage_id
     where o.workspace_id = $1 and o.archived_at is null and o.status = 'open'
       and (($2::uuid is not null and o.primary_contact_id = $2) or ($3::uuid is not null and o.company_id = $3))
     order by ($2::uuid is not null and o.primary_contact_id = $2) desc, o.updated_at desc
     limit 1`,
    [workspaceId, task.contactId, task.companyId],
  );
  return open.rows[0] ?? null;
}

async function lastActivityFor(db: Db, workspaceId: string, task: Task) {
  const column = task.contactId ? "contact_id" : task.companyId ? "company_id" : task.opportunityId ? "opportunity_id" : null;
  const id = task.contactId ?? task.companyId ?? task.opportunityId;
  if (!column || !id) return null;
  const result = await db.query<{ type: ActivityType; title: string | null; occurred_at: Date }>(
    `select type, title, occurred_at from crm.activities
     where workspace_id = $1 and ${column} = $2 and archived_at is null and occurred_at <= now()
     order by occurred_at desc limit 1`,
    [workspaceId, id],
  );
  const row = result.rows[0];
  return row ? { type: row.type, title: row.title, occurredAt: iso(row.occurred_at) ?? new Date(0).toISOString() } : null;
}

async function lastEmailFor(db: Db, actor: UserActor, address: string | null) {
  const email = address?.trim().toLowerCase();
  if (!email) return null;
  const result = await db.query<{ subject: string | null; at: Date }>(
    `select m.subject, coalesce(m.sent_at, m.received_at, m.created_at) as at
     from crm.mail_messages m
     where m.user_id = $1 and not m.is_draft
       and (lower(m.from_email) = $2
         or exists (select 1 from jsonb_array_elements(m.to_recipients) r where lower(r ->> 'address') = $2))
     order by at desc
     limit 1`,
    [actor.userId, email],
  );
  const row = result.rows[0];
  return row ? { subject: row.subject, at: iso(row.at) ?? new Date(0).toISOString() } : null;
}

async function threadFor(db: Db, actor: UserActor, description: string | null) {
  const thread = linkedThread(description);
  if (!thread) return null;
  const result = await db.query<{ subject: string | null; at: Date | null }>(
    `select (array_agg(m.subject order by coalesce(m.sent_at, m.received_at, m.created_at) desc))[1] as subject,
       max(coalesce(m.sent_at, m.received_at, m.created_at)) as at
     from crm.mail_messages m
     where m.user_id = $1 and m.source_id = $2 and m.thread_key = $3
     having count(*) > 0`,
    [actor.userId, thread.sourceId, thread.key],
  );
  const row = result.rows[0];
  return row ? { key: thread.value, subject: row.subject, at: iso(row.at) } : null;
}

async function companyPeople(db: Db, workspaceId: string, task: Task) {
  if (task.contactId || !task.companyId) return [];
  const result = await db.query<{ id: string; name: string; job_title: string | null; phone: string | null; email: string | null }>(
    `select c.id,
       coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, c.phone, 'Unnamed contact') as name,
       nullif(trim(c.job_title), '') as job_title, nullif(trim(c.phone), '') as phone, nullif(trim(c.email), '') as email
     from crm.contacts c
     where c.workspace_id = $1 and c.company_id = $2 and c.archived_at is null
     order by (nullif(trim(c.phone), '') is not null) desc, c.updated_at desc, c.id
     limit ${PEOPLE_SHOWN}`,
    [workspaceId, task.companyId],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, jobTitle: row.job_title, phone: row.phone, email: row.email }));
}

async function viewerBookingUrl(actor: UserActor) {
  const page = await getBookingPage(actor).catch(() => null);
  return page?.exists && page.enabled ? bookingUrl(page.slug) : null;
}

export async function taskContext(actor: UserActor, taskId: string): Promise<TaskContext> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(taskId)) throw notFound("task");
  const [found, booking] = await Promise.all([
    withActor(actor, async (db) => {
      const task = await readTaskInDb(db, taskId);
      if (!task || task.workspaceId !== actor.workspaceId) throw notFound("task");
      const [opportunity, lastActivity, lastEmail, thread, people] = await Promise.all([
        opportunityFor(db, actor.workspaceId, task),
        lastActivityFor(db, actor.workspaceId, task),
        lastEmailFor(db, actor, task.contactEmail),
        threadFor(db, actor, task.description),
        companyPeople(db, actor.workspaceId, task),
      ]);
      return { opportunity, lastActivity, lastEmail, thread, people };
    }),
    viewerBookingUrl(actor),
  ]);
  return { ...found, bookingUrl: booking };
}

async function lockedTask(db: Db, actor: UserActor, taskId: string) {
  await db.query("select 1 from crm.tasks where id = $1 for update", [taskId]);
  const task = await readTaskInDb(db, taskId);
  if (!task || task.workspaceId !== actor.workspaceId || task.archivedAt) throw notFound("task");
  if (!canChangeTask(actor, task)) throw cannotChange();
  return task;
}

async function companyOf(db: Db, table: "contacts" | "opportunities", id: string | null) {
  if (!id) return null;
  const result = await db.query<{ company_id: string | null }>(`select company_id from crm.${table} where id = $1`, [id]);
  if (!result.rows[0]) throw notFound(table === "contacts" ? "contact" : "opportunity");
  return result.rows[0].company_id;
}

export async function relinkTask(actor: UserActor, taskId: string, change: LinkChange, provenance: Provenance) {
  assertScope(actor.scopes, "tasks:write");
  if (!isUuid(taskId)) throw notFound("task");
  if (change.id !== null && !isUuid(change.id)) throw notFound(change.kind);
  return withActor(actor, async (db) => {
    const task = await lockedTask(db, actor, taskId);
    let companyId = task.companyId;
    let contactId = task.contactId;
    let opportunityId = task.opportunityId;
    const contactCompany = () => companyOf(db, "contacts", contactId);
    const opportunityCompany = () => companyOf(db, "opportunities", opportunityId);
    if (change.kind === "contact") {
      contactId = change.id;
      const company = await contactCompany();
      if (company) companyId = company;
      if (opportunityId && (await opportunityCompany()) !== companyId) opportunityId = null;
    } else if (change.kind === "opportunity") {
      opportunityId = change.id;
      if (opportunityId) {
        companyId = await opportunityCompany();
        const company = await contactCompany();
        if (contactId && company && company !== companyId) contactId = null;
      }
    } else {
      const before = companyId;
      companyId = change.id;
      const company = await contactCompany();
      if (contactId && company && company !== companyId && (companyId || company === before)) contactId = null;
      if (opportunityId && (await opportunityCompany()) !== companyId) opportunityId = null;
    }
    const updated = await updateTaskInDb(db, actor, taskId, { companyId, contactId, opportunityId }, provenance);
    return updated.task;
  });
}

function cleanOutcome(input: TaskOutcome) {
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > 10_000) throw new CrmError("invalid_input", tooLong("the note", 10_000), 400, { field: "note" });
  const kind = OUTCOME_KINDS.includes(input.kind as OutcomeKind) ? (input.kind as OutcomeKind) : null;
  const title = typeof input.next?.title === "string" ? input.next.title.trim() : "";
  const dueAt = typeof input.next?.dueAt === "string" && input.next.dueAt.trim() ? input.next.dueAt.trim() : null;
  return { note, kind, next: title ? { title, dueAt } : null };
}

export async function completeTaskWithOutcome(
  actor: UserActor,
  taskId: string,
  input: TaskOutcome,
): Promise<{ task: Task; activity: Activity | null; next: Task | null }> {
  assertScope(actor.scopes, "tasks:write");
  if (!isUuid(taskId)) throw notFound("task");
  const outcome = cleanOutcome(input);
  if (outcome.note) assertScope(actor.scopes, "activities:write");
  return withActor(actor, async (db) => {
    const task = await lockedTask(db, actor, taskId);
    const links = { companyId: task.companyId, contactId: task.contactId, opportunityId: task.opportunityId };
    let activity: Activity | null = null;
    if (outcome.note) {
      if (!links.companyId && !links.contactId && !links.opportunityId) {
        throw new CrmError("invalid_input", "Link a person or company first.", 400, { field: "contactId" });
      }
      const title = headline(outcome.note).slice(0, 200);
      activity = await createActivityInDb(
        db,
        actor,
        {
          type: outcome.kind ?? "note",
          title,
          body: outcome.note === title ? null : outcome.note,
          ...links,
          metadata: { source: "task", taskId: task.id },
        },
        { operation: "log_activity", source: "task_outcome" },
      );
    }
    let next: Task | null = null;
    if (outcome.next) {
      next = await createTaskInDb(
        db,
        actor,
        { title: outcome.next.title, dueAt: outcome.next.dueAt, ...links, ownerId: task.ownerId ?? actor.userId, priority: "normal" },
        { operation: "create_task", source: "task_outcome" },
      );
      if (task.clickupListId) {
        await db.query("update crm.tasks set clickup_list_id = $2 where id = $1", [next.id, task.clickupListId]);
        next = { ...next, clickupListId: task.clickupListId };
      }
    }
    const done = task.completedAt
      ? task
      : (await updateTaskInDb(db, actor, taskId, { completed: true }, { operation: "complete_task", source: "task_outcome" })).task;
    return { task: done, activity, next };
  });
}
