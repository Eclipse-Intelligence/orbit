import { cache } from "react";
import type { CaptureSection } from "@/lib/crm/capture-format";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { onWorkingDay } from "@/lib/crm/task-snooze";
import { updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { addWorkingDays, dayKeyAt, nextWorkingDay, nonWorkingReason, wallClockAt } from "@/lib/crm/working-days";
import { query, type Db } from "@/lib/db/pool";
import { waitingMail, workingDaysSince, type WaitingNudge, type WaitingReminder, type WaitingReply } from "@/lib/mail/waiting";
import { appTimeZone, startOfDay, zonedParts } from "@/lib/time";
import { approvalEmail } from "@/lib/workflows/store";
import type { RunState } from "@/lib/workflows/engine";

export type { SnoozeChoice } from "@/lib/crm/task-snooze";

const TASK_LIMIT = 100;
const SNOOZE_MIN_MS = 60_000;
const SNOOZE_MAX_MS = 366 * 86_400_000;

export type WaitingApproval = {
  kind: "approval";
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowName: string;
  title: string;
  details: string;
  companyId: string | null;
  companyName: string | null;
  email: { subject: string; href: string } | null;
  createdAt: string;
  arrivedAt: string;
};

export type WaitingTask = {
  kind: "task";
  id: string;
  workspaceId: string;
  title: string;
  dueAt: string;
  overdue: boolean;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  arrivedAt: string;
};

export type OthersApproval = {
  id: string;
  workflowId: string;
  workflowName: string;
  title: string;
  ownerName: string;
  createdAt: string;
  waitingDays: number;
};

export type Waiting = {
  approvals: WaitingApproval[];
  nudges: WaitingNudge[];
  reminders: WaitingReminder[];
  replies: WaitingReply[];
  tasks: WaitingTask[];
  failed: CaptureSection[];
};

export const EMPTY_WAITING: Waiting = { approvals: [], nudges: [], reminders: [], replies: [], tasks: [], failed: [] };

export function pastOneWorkingDay(at: Date | string, now: Date, timeZone = appTimeZone()) {
  const start = new Date(at);
  let key = dayKeyAt(start, timeZone);
  let { hour, minute } = zonedParts(start, timeZone);
  if (nonWorkingReason(key)) {
    key = nextWorkingDay(key);
    hour = 0;
    minute = 0;
  }
  return now.getTime() > wallClockAt(addWorkingDays(key, 1), hour, minute, timeZone);
}

type ApprovalRow = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  workflow_name: string;
  state: RunState;
  company_id: string | null;
  company_name: string | null;
  updated_at: Date;
};

async function approvalsInDb(db: Db, actor: UserActor, workspaceIds: string[]): Promise<WaitingApproval[]> {
  const result = await db.query<ApprovalRow>(
    `select r.id, r.workspace_id, r.workflow_id, w.name as workflow_name, r.state, r.company_id, co.name as company_name, r.updated_at
     from crm.workflow_runs r
     join crm.workflows w on w.id = r.workflow_id
     left join crm.companies co on co.id = r.company_id
     where r.owner_id = $1 and r.workspace_id = any($2::uuid[]) and r.status = 'waiting' and r.waiting_for = 'approval'
     order by r.updated_at`,
    [actor.userId, workspaceIds],
  );
  return result.rows.map((row) => {
    const at = iso(row.updated_at) ?? new Date(0).toISOString();
    return {
      kind: "approval",
      id: row.id,
      workspaceId: row.workspace_id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      title: row.state.approval?.title ?? "Approve this step",
      details: row.state.approval?.details ?? "",
      companyId: row.company_id,
      companyName: row.company_name,
      email: approvalEmail(row.state),
      createdAt: at,
      arrivedAt: at,
    };
  });
}

type TaskRow = {
  id: string;
  workspace_id: string;
  title: string;
  due_at: Date;
  created_at: Date;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
};

async function tasksInDb(db: Db, actor: UserActor, workspaceIds: string[], now: Date): Promise<WaitingTask[]> {
  const start = startOfDay(now);
  const result = await db.query<TaskRow>(
    `select t.id, t.workspace_id, t.title, t.due_at, t.created_at, t.company_id, co.name as company_name, t.contact_id,
       coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), ct.email) as contact_name
     from (
       select t.*, row_number() over (partition by t.workspace_id order by t.due_at asc, t.created_at asc, t.id asc) as place
       from crm.tasks t
       where (t.owner_id = $1 or t.owner_id is null) and t.workspace_id = any($2::uuid[]) and t.archived_at is null and t.completed_at is null
         and t.due_at is not null and t.due_at < $3
     ) t
     left join crm.companies co on co.id = t.company_id
     left join crm.contacts ct on ct.id = t.contact_id
     where t.place <= ${TASK_LIMIT}
     order by t.due_at asc, t.created_at asc, t.id asc`,
    [actor.userId, workspaceIds, startOfDay(now, appTimeZone(), 1)],
  );
  return result.rows.map((row) => {
    const due = new Date(row.due_at);
    const dayStart = startOfDay(due);
    const created = new Date(row.created_at);
    return {
      kind: "task",
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      dueAt: due.toISOString(),
      overdue: due.getTime() < start.getTime(),
      companyId: row.company_id,
      companyName: row.company_name,
      contactId: row.contact_id,
      contactName: row.contact_name,
      arrivedAt: (created > dayStart ? created : dayStart).toISOString(),
    };
  });
}

async function attempt<T>(db: Db, label: string, run: () => Promise<T>): Promise<T | null> {
  await db.query("savepoint capture_section");
  try {
    const value = await run();
    await db.query("release savepoint capture_section");
    return value;
  } catch (error) {
    await db.query("rollback to savepoint capture_section");
    console.error(label, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function waitingFor(actor: UserActor, actors: UserActor[], now = new Date()): Promise<Waiting> {
  assertScope(actor.scopes, "crm:read");
  const workspaceIds = actors.length ? actors.map((item) => item.workspaceId) : [actor.workspaceId];
  const [records, mail] = await Promise.all([
    withActor(actor, async (db) => ({
      approvals: await attempt(db, "Reading approvals waiting on you failed", () => approvalsInDb(db, actor, workspaceIds)),
      tasks: await attempt(db, "Reading tasks waiting on you failed", () => tasksInDb(db, actor, workspaceIds, now)),
    })).catch((error) => {
      console.error("Reading approvals and tasks failed", error instanceof Error ? error.message : error);
      return { approvals: null, tasks: null };
    }),
    waitingMail(actor, actors.length ? actors : [actor], now).catch((error) => {
      console.error("Reading mail waiting on you failed", error instanceof Error ? error.message : error);
      return { replies: [], nudges: [], reminders: [], failed: { replies: true, followUps: true } };
    }),
  ]);
  const failed: CaptureSection[] = [];
  if (records.approvals === null) failed.push("approvals");
  if (mail.failed.followUps) failed.push("followUps");
  if (mail.failed.replies) failed.push("replies");
  if (records.tasks === null) failed.push("tasks");
  return {
    approvals: records.approvals ?? [],
    tasks: records.tasks ?? [],
    replies: mail.replies,
    nudges: mail.nudges,
    reminders: mail.reminders,
    failed,
  };
}

const requestWaiting = cache(() => new Map<string, Promise<Waiting>>());

export function waitingOnce(actor: UserActor, actors: UserActor[], now = new Date()) {
  const store = requestWaiting();
  const key = `${actor.userId}|${actors.map((item) => item.workspaceId).join(",")}`;
  const found = store.get(key);
  if (found) return found;
  const pending = waitingFor(actor, actors, now);
  store.set(key, pending);
  pending.catch(() => store.delete(key));
  return pending;
}

export function waitingIn(waiting: Waiting, workspaceId: string, toFile: Iterable<string> = []): Waiting {
  const filing = new Set(toFile);
  return {
    approvals: waiting.approvals.filter((item) => item.workspaceId === workspaceId),
    nudges: waiting.nudges.filter((item) => item.workspaceId === workspaceId),
    reminders: waiting.reminders.filter((item) => item.workspaceId === workspaceId),
    replies: waiting.replies.filter((item) => item.workspaceId === workspaceId && !filing.has(item.key)),
    tasks: waiting.tasks.filter((item) => item.workspaceId === workspaceId),
    failed: waiting.failed,
  };
}

export async function listWaitingOnOthers(actor: UserActor, now = new Date()): Promise<OthersApproval[]> {
  if (actor.role !== "owner" && actor.role !== "admin") return [];
  const result = await query<{
    id: string;
    workflow_id: string;
    workflow_name: string;
    title: string | null;
    owner_name: string | null;
    updated_at: Date;
  }>("select * from private.waiting_approvals_of_others($1, $2)", [actor.userId, actor.workspaceId]);
  return result.rows
    .filter((row) => pastOneWorkingDay(row.updated_at, now))
    .map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      title: row.title ?? "Approve this step",
      ownerName: row.owner_name ?? "Someone",
      createdAt: iso(row.updated_at) ?? new Date(0).toISOString(),
      waitingDays: Math.max(1, workingDaysSince(row.updated_at, now)),
    }));
}

export async function snoozeTask(actor: UserActor, id: string, dueAt: string, now = Date.now()) {
  if (!isUuid(id)) throw notFound("task");
  const chosen = new Date(dueAt);
  if (Number.isNaN(chosen.getTime()) || chosen.getTime() < now + SNOOZE_MIN_MS || chosen.getTime() > now + SNOOZE_MAX_MS) {
    throw new CrmError("invalid_input", "Choose a time at least a minute from now and within a year.", 400, { field: "until" });
  }
  const at = onWorkingDay(chosen);
  return updateTask(actor, id, { dueAt: at.toISOString() }, { provenance: { operation: "snooze_task", source: "web" } });
}
