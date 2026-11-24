import { cache } from "react";
import type { CaptureSection } from "@/lib/crm/capture-format";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { onWorkingDay } from "@/lib/crm/task-snooze";
import { getTask, updateTask } from "@/lib/crm/tasks";
import { atKeepingKind } from "@/lib/crm/task-time";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { waitingMail, type WaitingNudge, type WaitingReminder, type WaitingReply } from "@/lib/mail/waiting";
import { approvalEmail } from "@/lib/workflows/store";
import type { RunState } from "@/lib/workflows/engine";

export type { SnoozeChoice } from "@/lib/crm/task-snooze";

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

export type Waiting = {
  approvals: WaitingApproval[];
  nudges: WaitingNudge[];
  reminders: WaitingReminder[];
  replies: WaitingReply[];
  failed: CaptureSection[];
};

export const EMPTY_WAITING: Waiting = { approvals: [], nudges: [], reminders: [], replies: [], failed: [] };

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

export async function waitingFor(actor: UserActor, actors: UserActor[], now = new Date(), options: { serial?: boolean } = {}): Promise<Waiting> {
  assertScope(actor.scopes, "crm:read");
  const workspaceIds = actors.length ? actors.map((item) => item.workspaceId) : [actor.workspaceId];
  const readRecords = () =>
    withActor(actor, async (db) => ({
      approvals: await attempt(db, "Reading approvals waiting on you failed", () => approvalsInDb(db, actor, workspaceIds)),
    })).catch((error) => {
      console.error("Reading approvals failed", error instanceof Error ? error.message : error);
      return { approvals: null };
    });
  const readMail = () =>
    waitingMail(actor, actors.length ? actors : [actor], now).catch((error) => {
      console.error("Reading mail waiting on you failed", error instanceof Error ? error.message : error);
      return { replies: [], nudges: [], reminders: [], failed: { replies: true, followUps: true } };
    });
  const [records, mail] = options.serial ? [await readRecords(), await readMail()] : await Promise.all([readRecords(), readMail()]);
  const failed: CaptureSection[] = [];
  if (records.approvals === null) failed.push("approvals");
  if (mail.failed.followUps) failed.push("followUps");
  if (mail.failed.replies) failed.push("replies");
  return {
    approvals: records.approvals ?? [],
    replies: mail.replies,
    nudges: mail.nudges,
    reminders: mail.reminders,
    failed,
  };
}

const requestWaiting = cache(() => new Map<string, Promise<Waiting>>());

export function waitingOnce(actor: UserActor, actors: UserActor[], now = new Date(), options: { serial?: boolean } = {}) {
  const store = requestWaiting();
  const key = `${actor.userId}|${actors.map((item) => item.workspaceId).join(",")}|${options.serial ? "serial" : ""}`;
  const found = store.get(key);
  if (found) return found;
  const pending = waitingFor(actor, actors, now, options);
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
    failed: waiting.failed,
  };
}

export async function snoozeTask(actor: UserActor, id: string, dueAt: string, now = Date.now()) {
  if (!isUuid(id)) throw notFound("task");
  const chosen = new Date(dueAt);
  if (Number.isNaN(chosen.getTime()) || chosen.getTime() < now + SNOOZE_MIN_MS || chosen.getTime() > now + SNOOZE_MAX_MS) {
    throw new CrmError("invalid_input", "Choose a time at least a minute from now and within a year.", 400, { field: "until" });
  }
  const at = onWorkingDay(chosen);
  const task = await getTask(actor, id);
  return updateTask(actor, id, atKeepingKind(task, at.toISOString()), { provenance: { operation: "snooze_task", source: "web" } });
}
