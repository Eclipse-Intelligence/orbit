import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { assertScope, hasScope } from "@/lib/crm/scopes";
import { linkedThread, sharedTaskContextInDb, viewerLastEmailInDb, type TaskPerson } from "@/lib/crm/task-act";
import { splitDescription } from "@/lib/crm/task-description";
import { canChangeTask, readTaskInDb } from "@/lib/crm/tasks";
import type { Actor, ActivityType, Task, UserActor } from "@/lib/crm/types";
import { actorForTask } from "@/lib/crm/workspaces";
import { parseThreadKey } from "@/lib/mail/threads";
import type { Db } from "@/lib/db/pool";

export type TaskThread = { emailId: string; subject: string | null; messages: number; latest: string | null; fromNames: string[] };

export type TaskDetail = {
  task: Task;
  workspace: { id: string; name: string | null; current: boolean };
  readOnly: boolean;
  canChange: boolean;
  assignedToViewer: boolean;
  contact: TaskPerson | null;
  company: { id: string; name: string; phone: string | null } | null;
  opportunity: { id: string; name: string; stage: string | null; status: string; value: string | null; currency: string; linked: boolean } | null;
  people: TaskPerson[];
  lastActivity: { type: ActivityType; title: string | null; occurredAt: string } | null;
  mail: { lastEmail: { subject: string | null; at: string } | null; thread: TaskThread | null } | null;
};

export async function threadSummaryInDb(db: Db, userId: string, value: string): Promise<TaskThread | null> {
  let parsed: { sourceId: string; key: string };
  try {
    parsed = parseThreadKey(value);
  } catch {
    return null;
  }
  const result = await db.query<{ id: string; subject: string | null; messages: number; latest: Date | null; people: string[] | null }>(
    `select (array_agg(m.id order by coalesce(m.received_at, m.sent_at, m.created_at) desc))[1] as id,
       (array_agg(m.subject order by coalesce(m.received_at, m.sent_at, m.created_at) desc))[1] as subject,
       count(*)::int as messages,
       max(coalesce(m.received_at, m.sent_at, m.created_at)) as latest,
       array_agg(distinct coalesce(nullif(m.from_name, ''), m.from_email)) filter (where m.from_email is not null) as people
     from crm.mail_messages m
     where m.user_id = $1 and m.source_id = $2 and coalesce(m.thread_key, 'm:' || m.id::text) = $3`,
    [userId, parsed.sourceId, parsed.key],
  );
  const row = result.rows[0];
  if (!row?.id) return null;
  return { emailId: row.id, subject: row.subject, messages: row.messages, latest: iso(row.latest), fromNames: row.people ?? [] };
}

async function viewerMail(db: Db, actor: UserActor, task: Task): Promise<NonNullable<TaskDetail["mail"]>> {
  const thread = linkedThread(task.description);
  const [lastEmail, summary] = await Promise.all([viewerLastEmailInDb(db, actor, task), thread ? threadSummaryInDb(db, actor.userId, thread.value) : null]);
  return { lastEmail, thread: summary };
}

export async function taskDetailInDb(db: Db, home: Actor, task: Task, viewer: Actor = home): Promise<TaskDetail> {
  const [shared, mail] = await Promise.all([
    sharedTaskContextInDb(db, home.workspaceId, task),
    home.type === "user" ? viewerMail(db, home, task) : null,
  ]);
  const readOnly = home.workspaceId !== viewer.workspaceId;
  const deal = shared.opportunity;
  return {
    task: { ...task, description: splitDescription(task.description).text || null },
    workspace: { id: home.workspaceId, name: home.type === "user" ? home.workspaceName : null, current: !readOnly },
    readOnly,
    canChange: !readOnly && !task.archivedAt && hasScope(home.scopes, "tasks:write") && canChangeTask(home, task),
    assignedToViewer: home.type === "user" && task.ownerId === home.userId,
    contact: task.contactId
      ? { id: task.contactId, name: task.contactName ?? task.contactEmail ?? "Unnamed person", jobTitle: task.contactJobTitle, phone: task.contactPhone, email: task.contactEmail }
      : null,
    company: task.companyId ? { id: task.companyId, name: task.companyName ?? "Unnamed company", phone: task.companyPhone } : null,
    opportunity: deal ? { ...deal, linked: task.opportunityId === deal.id } : null,
    people: shared.people,
    lastActivity: shared.lastActivity,
    mail,
  };
}

export async function taskDetail(actor: Actor, taskId: string, options: { anyWorkspace?: boolean } = {}): Promise<TaskDetail> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(taskId)) throw notFound("task");
  const home = actor.type === "user" && options.anyWorkspace ? await actorForTask(actor, taskId) : actor;
  return withActor(home, async (db) => {
    const task = await readTaskInDb(db, taskId);
    if (!task || task.workspaceId !== home.workspaceId) throw notFound("task");
    return taskDetailInDb(db, home, task, actor);
  });
}

export async function taskDetailOrNull(actor: UserActor, taskId: string) {
  try {
    return await taskDetail(actor, taskId, { anyWorkspace: true });
  } catch (error) {
    if (error instanceof CrmError && (error.code === "not_found" || error.code === "forbidden")) return null;
    throw error;
  }
}
