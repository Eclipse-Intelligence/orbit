import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { ACTION_BUDGET_MS, applyMailAction, partialProblem, readMailActionInput, type MailAction } from "@/lib/mail/actions";
import { RECONNECT_NEEDED } from "@/lib/mail/mailboxes";
import { GraphMailError, GraphOutOfTime, reconnectProblem } from "@/lib/mail/microsoft";
import { threadKey } from "@/lib/mail/threads";
import { isMoveAction, type MoveAction } from "@/lib/mail/refusals";
import { mailViewParam, readMailView, type MailView } from "@/lib/mail/view";


type PendingRow = {
  id: string;
  source_id: string;
  thread_key: string;
  action: MoveAction;
  view: string | null;
  until: Date | null;
  origin: string | null;
  attempts: number;
  created_at: Date;
};

const BATCH = 6;
const WORKERS = 3;
const LEASE_SECONDS = 120;
const BACKOFF_MS = [5_000, 15_000, 60_000];
const BACKOFF_LONG_MS = 5 * 60_000;
const RETRY_AFTER_CAP_MS = 15 * 60_000;
const RECONNECT_WAIT_MS = 5 * 60_000;
const GIVE_UP_MS = 24 * 60 * 60_000;
const MIN_STEP_MS = 8_000;
const GAVE_UP = "Outlook refused it.";

export async function queueMailAction(
  actor: UserActor,
  input: { thread: string; action: MailAction; view?: MailView | null; until?: string | null },
  origin: string | null = null,
) {
  const { until, view, sourceId, key } = readMailActionInput(input);
  if (!isMoveAction(input.action)) throw new CrmError("validation_error", "Choose a mail action.", 400);
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `insert into crm.mail_pending_actions (workspace_id, user_id, source_id, thread_key, action, view, until, origin, subject)
       select $1, $2, s.id, $4, $5, $6, $7, $8,
         (select left(m.subject, 2000) from crm.mail_messages m
          where m.user_id = $2 and m.source_id = s.id and m.thread_key = $4 and m.subject is not null
          order by coalesce(m.received_at, m.sent_at, m.created_at) desc limit 1)
       from crm.mail_sources s where s.id = $3 and s.user_id = $2
       returning id`,
      [actor.workspaceId, actor.userId, sourceId, key, input.action, view ? mailViewParam(view) : null, until?.toISOString() ?? null, origin],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new CrmError("not_found", "Conversation not found.", 404);
    return { id };
  });
}

async function claimDue(actor: UserActor, limit: number) {
  return withActor(actor, async (db) => {
    const result = await db.query<PendingRow>(
      `with due as (
         select p.id from crm.mail_pending_actions p
         where p.user_id = $1 and p.refused_at is null and p.next_attempt_at <= now()
           and not exists (
             select 1 from crm.mail_pending_actions e
             where e.user_id = p.user_id and e.source_id = p.source_id and e.thread_key = p.thread_key
               and e.refused_at is null and (e.created_at, e.id) < (p.created_at, p.id)
           )
         order by p.created_at, p.id
         limit $2
         for update skip locked
       )
       update crm.mail_pending_actions p set next_attempt_at = now() + make_interval(secs => $3)
       from due where p.id = due.id
       returning p.id, p.source_id, p.thread_key, p.action, p.view, p.until, p.origin, p.attempts, p.created_at`,
      [actor.userId, limit, LEASE_SECONDS],
    );
    return result.rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  });
}

type Outcome =
  | { kind: "done" }
  | { kind: "refused"; problem: string }
  | { kind: "reconnect"; problem: string }
  | { kind: "transient"; problem: string; waitMs: number | null };

function classify(error: unknown): Outcome {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const problem = error instanceof Error ? error.message : GAVE_UP;
  if (error instanceof CrmError) {
    if (error.code === RECONNECT_NEEDED) return { kind: "reconnect", problem };
    if (error.code === "not_found") return { kind: "done" };
  }
  if (cause instanceof GraphMailError) {
    if (cause.status === 404) return { kind: "done" };
    if (cause.status === 429) return { kind: "transient", problem, waitMs: cause.retryAfterMs };
    if (cause.status >= 500 || cause.status === 408) return { kind: "transient", problem, waitMs: cause.retryAfterMs };
    const reconnect = reconnectProblem(cause, null);
    if (reconnect) return { kind: "reconnect", problem: reconnect };
    return { kind: "refused", problem };
  }
  if (cause instanceof GraphOutOfTime) return { kind: "transient", problem, waitMs: null };
  if (error instanceof CrmError) return error.status >= 500 ? { kind: "transient", problem, waitMs: null } : { kind: "refused", problem };
  return { kind: "transient", problem, waitMs: null };
}

export function backoffMs(attempts: number, retryAfterMs: number | null) {
  const own = BACKOFF_MS[attempts - 1] ?? BACKOFF_LONG_MS;
  return Math.max(own, Math.min(retryAfterMs ?? 0, RETRY_AFTER_CAP_MS));
}

function snoozeTime(until: Date | null) {
  if (!until) return null;
  const earliest = Date.now() + 90_000;
  return new Date(Math.max(until.getTime(), earliest)).toISOString();
}

async function settle(actor: UserActor, row: PendingRow, outcome: Outcome) {
  await withActor(actor, async (db) => {
    if (outcome.kind === "done") {
      await db.query("delete from crm.mail_pending_actions where id = $1 and user_id = $2", [row.id, actor.userId]);
    } else if (outcome.kind === "refused") {
      await db.query(
        "update crm.mail_pending_actions set refused_at = now(), problem = $3, last_error = $3 where id = $1 and user_id = $2",
        [row.id, actor.userId, outcome.problem.slice(0, 2000)],
      );
    } else if (outcome.kind === "reconnect") {
      await db.query(
        "update crm.mail_pending_actions set next_attempt_at = now() + make_interval(secs => $3), last_error = $4 where id = $1 and user_id = $2",
        [row.id, actor.userId, RECONNECT_WAIT_MS / 1000, outcome.problem.slice(0, 2000)],
      );
    } else {
      await db.query(
        "update crm.mail_pending_actions set attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $3), last_error = $4 where id = $1 and user_id = $2",
        [row.id, actor.userId, backoffMs(row.attempts + 1, outcome.waitMs) / 1000, outcome.problem.slice(0, 2000)],
      );
    }
  });
}

async function runRow(actor: UserActor, row: PendingRow, fetchImpl: typeof fetch, deadline: number) {
  let outcome: Outcome;
  try {
    const result = await applyMailAction(
      actor,
      {
        thread: threadKey(row.source_id, row.thread_key),
        action: row.action,
        view: row.view ? readMailView(row.view) : null,
        until: row.action === "snooze" ? snoozeTime(row.until) : null,
      },
      fetchImpl,
      { deadline: Math.min(deadline, Date.now() + ACTION_BUDGET_MS), origin: row.origin },
    );
    const problem = partialProblem(result);
    if (!problem || result.gone) outcome = { kind: "done" };
    else outcome = result.refused ? { kind: "refused", problem } : { kind: "transient", problem, waitMs: null };
  } catch (error) {
    outcome = classify(error);
  }
  if ((outcome.kind === "transient" || outcome.kind === "reconnect") && Date.now() - row.created_at.getTime() > GIVE_UP_MS) {
    outcome = { kind: "refused", problem: GAVE_UP };
  }
  if (outcome.kind === "transient" || outcome.kind === "reconnect") console.error("Queued mail move will retry", { action: row.action, mailbox: row.source_id, attempts: row.attempts + 1 });
  await settle(actor, row, outcome);
}

export async function runPendingMailActions(actor: UserActor, options: { deadline?: number; fetchImpl?: typeof fetch } = {}) {
  const deadline = options.deadline ?? Date.now() + 45_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  let ran = 0;
  await withActor(actor, (db) =>
    db.query("delete from crm.mail_pending_actions where user_id = $1 and refused_at < now() - interval '3 days'", [actor.userId]),
  ).catch(() => undefined);
  while (deadline - Date.now() > MIN_STEP_MS) {
    const rows = await claimDue(actor, BATCH);
    if (rows.length === 0) break;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(WORKERS, rows.length) }, async () => {
        while (next < rows.length && deadline - Date.now() > MIN_STEP_MS) {
          const row = rows[next++];
          ran += 1;
          await runRow(actor, row, fetchImpl, deadline).catch((error) =>
            console.error("Couldn't record a queued mail move", error instanceof Error ? error.name : "unknown"),
          );
        }
      }),
    );
  }
  return ran;
}

export async function processAllPendingMail(deadline: number, fetchImpl: typeof fetch = fetch) {
  const members = await query<Parameters<typeof memberActor>[0]>("select * from private.mail_pending_members()");
  const users: { userId: string; ran: number | { error: string } }[] = [];
  for (const row of members.rows) {
    if (deadline - Date.now() <= MIN_STEP_MS) break;
    const actor = memberActor(row);
    try {
      users.push({ userId: actor.userId, ran: await runPendingMailActions(actor, { deadline, fetchImpl }) });
    } catch (error) {
      users.push({ userId: actor.userId, ran: { error: error instanceof Error ? error.name : "Queued mail failed." } });
    }
  }
  return users;
}
