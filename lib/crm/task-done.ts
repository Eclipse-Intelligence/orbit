import { after } from "next/server";
import { z } from "zod";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { Actor } from "@/lib/crm/types";
import { dayKeyAt } from "@/lib/crm/working-days";
import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { completeJson, withinWindow } from "@/lib/llm";
import { NEXT_STEP_INSTRUCTION } from "@/lib/workflows/templates";

export type TaskDoneKind = "email" | "call" | "meeting";

export type TaskDoneOffer = {
  id: string;
  taskId: string;
  activityId: string;
  kind: TaskDoneKind;
  note: string | null;
  nextTitle: string | null;
  nextDue: string | null;
  createdAt: string;
  activityTitle: string | null;
  activityAt: string;
};

const BACKGROUND_BUDGET_MS = 25_000;
const STEP_MIN_MS = 10_000;
const MODEL_MIN_MS = 7_500;
const RETRY_SECONDS = [60, 300, 900, 3600];
const UPDATED_FIELDS = ["type", "body", "occurredAt", "companyId", "contactId"];
const COUNTING_TYPES = ["email", "call", "meeting"];
const OPEN_TASKS_SHOWN = 20;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function taskDoneConfigured() {
  return Boolean(process.env.LLM_API_KEY?.trim());
}

function queuedFor(eventType: string, entityType: string, entityId: string, changes: Record<string, unknown>) {
  if (eventType === "call_summary.ready") {
    const activityId = changes.activityId;
    return typeof activityId === "string" ? { activityId, reason: "summary" } : null;
  }
  if (entityType !== "activity") return null;
  if (eventType === "activity.created") {
    const created = changes.after as { type?: unknown } | undefined;
    return typeof created?.type === "string" && COUNTING_TYPES.includes(created.type) ? { activityId: entityId, reason: "created" } : null;
  }
  if (eventType === "activity.updated") {
    const fields = Array.isArray(changes.fields) ? changes.fields : [];
    return fields.some((field) => UPDATED_FIELDS.includes(String(field))) ? { activityId: entityId, reason: "updated" } : null;
  }
  return null;
}

export async function enqueueTaskDone(db: Db, eventType: string, entityType: string, entityId: string, changes: Record<string, unknown>) {
  if (!taskDoneConfigured()) return;
  const queued = queuedFor(eventType, entityType, entityId, changes);
  if (!queued || !isUuid(queued.activityId)) return;
  await db.query("insert into crm.task_done_queue (activity_id, reason) values ($1, $2)", [queued.activityId, queued.reason]);
  kickTaskDone();
}

export function kickTaskDone() {
  try {
    after(async () => {
      try {
        await drainTaskDoneQueue();
      } catch (error) {
        console.error("Looks done check failed", error);
      }
    });
  } catch {}
}

type ActivityRow = {
  workspace_id: string;
  kind: TaskDoneKind;
  title: string | null;
  body: string | null;
  summary: string | null;
  occurred_at: Date;
  contact_id: string | null;
  company_id: string | null;
  contact_name: string | null;
  company_name: string | null;
};

type TaskRow = {
  task_id: string;
  assignee_id: string;
  title: string;
  notes: string | null;
  due_at: Date | null;
  candidate: boolean;
};

const answerSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      satisfied: z.boolean(),
      note: z.string().nullish(),
      nextTask: z.string().nullish(),
      dueOn: z.string().nullish(),
    }),
  ),
});

const SYSTEM = `You check one person's open tasks against something that has just happened with the people the tasks are about. For each task in "tasks", decide whether the activity does what the task asks.
- A task that names several topics or steps is done only when the activity covers all of them. A task that names nothing specific, such as "Call Jane Wednesday", is done by any activity of the kind it asks for with that person.
- The activity has to be the kind of thing the task asks for: a task to send something is done by an email that sends it, a task to call by a call, a task to meet by a meeting. When the task names no kind, any kind counts.
- Judge only from the activity. When you are unsure, answer false. An activity that is only related to the task doesn't finish it.
- note: one short line on what in the activity does the task, in plain UK English. Empty when satisfied is false.
- For a task that is done: ${NEXT_STEP_INSTRUCTION} "Open tasks on the same records" in the request lists what is already open. nextTask is a short instruction naming who it is with, such as "Send Jane the signed order form", and empty if none. dueOn is the day it should be done by, as YYYY-MM-DD, from today on, and empty if no day fits. Leave both empty when satisfied is false.
Reply with JSON only: {"tasks": [{"id": "...", "satisfied": true, "note": "...", "nextTask": "...", "dueOn": "..."}]}, with one entry for every task id given.`;

function dueDay(value: string | null | undefined, today: string) {
  const day = value?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? null : day;
}

function dueText(date: Date | null) {
  return date ? dayKeyAt(date) : null;
}

type MatchOptions = { deadline: number; fetchImpl?: typeof fetch; asked?: string[] };

export async function matchActivityToTasks(activityId: string, options: MatchOptions) {
  const found = await query<ActivityRow>("select * from private.task_done_activity($1)", [activityId]);
  const activity = found.rows[0];
  if (!activity) return { offered: 0, outOfTime: false, asked: [] as string[] };
  const rows = (await query<TaskRow>("select * from private.task_done_candidates($1)", [activityId])).rows;
  const skip = new Set(options.asked ?? []);
  const assignees = [...new Set(rows.filter((row) => row.candidate).map((row) => row.assignee_id))].filter((id) => !skip.has(id));
  if (assignees.length === 0) return { offered: 0, outOfTime: false, asked: [] as string[] };
  const finished: string[] = [];
  const today = dayKeyAt(new Date());
  const text = withinWindow([activity.summary, activity.body].filter(Boolean).join("\n\n"));
  let offered = 0;
  for (const assignee of assignees) {
    if (options.deadline - Date.now() < MODEL_MIN_MS) return { offered, outOfTime: true, asked: finished };
    const mine = rows.filter((row) => row.assignee_id === assignee);
    const candidates = mine.filter((row) => row.candidate);
    const request = {
      today,
      activity: {
        kind: activity.kind,
        title: activity.title,
        when: activity.occurred_at.toISOString(),
        with: activity.contact_name ?? null,
        company: activity.company_name ?? null,
        text,
      },
      tasks: candidates.map((row) => ({ id: row.task_id, title: row.title, notes: row.notes, due: dueText(row.due_at) })),
      "Open tasks on the same records": mine.slice(0, OPEN_TASKS_SHOWN).map((row) => (row.due_at ? `${row.title} (due ${dueText(row.due_at)})` : row.title)),
    };
    const { data } = await completeJson({
      system: SYSTEM,
      user: JSON.stringify(request),
      schema: answerSchema,
      deadline: options.deadline,
      fetchImpl: options.fetchImpl,
    });
    const allowed = new Set(candidates.map((row) => row.task_id));
    const decided = new Set<string>();
    for (const answer of data.tasks) {
      if (!answer.satisfied || !allowed.has(answer.id) || decided.has(answer.id)) continue;
      decided.add(answer.id);
      const nextTitle = answer.nextTask?.trim() || null;
      const stored = await query<{ offer: boolean }>("select private.offer_task_done($1, $2, $3, $4, $5) as offer", [
        answer.id,
        activityId,
        answer.note?.trim() || null,
        nextTitle,
        nextTitle ? dueDay(answer.dueOn, today) : null,
      ]);
      if (stored.rows[0]?.offer) offered += 1;
    }
    finished.push(assignee);
  }
  return { offered, outOfTime: false, asked: finished };
}

type Claimed = { id: string; activity_id: string; claim_token: string; attempts: number; asked: string[] };

export async function drainTaskDoneQueue(options: { deadline?: number; fetchImpl?: typeof fetch } = {}) {
  const totals = { processed: 0, offered: 0, retried: 0 };
  if (!taskDoneConfigured()) return totals;
  const deadline = options.deadline ?? Date.now() + BACKGROUND_BUDGET_MS;
  while (deadline - Date.now() > STEP_MIN_MS) {
    const claimed = (await query<Claimed>("select * from private.claim_task_done_queue($1)", [1])).rows[0];
    if (!claimed) break;
    try {
      const matched = await matchActivityToTasks(claimed.activity_id, { deadline, fetchImpl: options.fetchImpl, asked: claimed.asked });
      totals.offered += matched.offered;
      if (matched.outOfTime) {
        await query("select private.release_task_done_queue($1, $2, $3)", [claimed.id, claimed.claim_token, matched.asked]);
        break;
      }
      await query("select private.finish_task_done_queue($1, $2)", [claimed.id, claimed.claim_token]);
      totals.processed += 1;
    } catch (error) {
      console.error("Looks done check failed", error);
      const delay = RETRY_SECONDS[Math.min(claimed.attempts, RETRY_SECONDS.length) - 1] ?? RETRY_SECONDS[0];
      await query("select private.retry_task_done_queue($1, $2, $3)", [claimed.id, claimed.claim_token, delay]);
      totals.retried += 1;
    }
  }
  return totals;
}

type OfferRow = {
  id: string;
  task_id: string;
  activity_id: string;
  kind: TaskDoneKind;
  note: string | null;
  next_title: string | null;
  next_due: string | null;
  created_at: Date;
  title: string | null;
  occurred_at: Date;
};

export async function taskDoneOffers(actor: Actor, taskIds: string[]): Promise<TaskDoneOffer[]> {
  const wanted = [...new Set(taskIds.filter(isUuid))];
  if (wanted.length === 0) return [];
  return withActor(actor, async (db) => {
    const result = await db.query<OfferRow>(
      `select o.id, o.task_id, o.activity_id, o.kind, o.note, o.next_title, o.next_due::text as next_due, o.created_at,
         a.title, a.occurred_at
       from crm.task_done_offers o
       join crm.tasks t on t.id = o.task_id
       join crm.activities a on a.id = o.activity_id
       where o.task_id = any($1::uuid[]) and o.state = 'offered'
         and t.workspace_id = $2 and t.completed_at is null and t.archived_at is null
         and a.archived_at is null and a.workspace_id = t.workspace_id
       order by o.created_at desc`,
      [wanted, actor.workspaceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      activityId: row.activity_id,
      kind: row.kind,
      note: row.note,
      nextTitle: row.next_title,
      nextDue: row.next_due,
      createdAt: row.created_at.toISOString(),
      activityTitle: row.title,
      activityAt: row.occurred_at.toISOString(),
    }));
  });
}

export async function dismissTaskDoneOffer(actor: Actor, offerId: string) {
  if (actor.type !== "user") throw new CrmError("forbidden", "Only a person can decide this.", 403);
  if (!isUuid(offerId)) throw new CrmError("not_found", "Offer not found.", 404);
  return withActor(actor, async (db) => {
    const current = await db.query<{ state: string }>("select state from crm.task_done_offers where id = $1", [offerId]);
    const state = current.rows[0]?.state;
    if (!state) throw new CrmError("not_found", "Offer not found.", 404);
    if (state === "dismissed") return { id: offerId, changed: false };
    const updated = await db.query(
      "update crm.task_done_offers set state = 'dismissed', decided_at = now(), decided_by = $2 where id = $1 and state = 'offered' returning id",
      [offerId, actor.userId],
    );
    if (updated.rowCount === 0) {
      if (state === "closed") return { id: offerId, changed: false };
      throw new CrmError("forbidden", "Only the person doing this task can decide that.", 403);
    }
    return { id: offerId, changed: true };
  });
}
