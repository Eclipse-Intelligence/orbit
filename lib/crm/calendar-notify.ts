import { after } from "next/server";
import { syncCalendar } from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { memberActor, safeEqual } from "@/lib/crm/conversations";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { query } from "@/lib/db/pool";
import { graphNotices, graphValidation, type GraphNotice } from "@/lib/microsoft/notifications";
import { signalSynced } from "@/lib/sync-signals";

const BUDGET_MS = 55_000;
const CALENDAR_SYNC_MS = 20_000;
const POLL_MS = 1_000;
const SHORTEST_SYNC_MS = 3_000;
const MAX_PASSES = 2;
const LOCK_GRACE_SECONDS = 60;
const SYNC_LIMIT = 3;

type OwnerRow = {
  subscription_id: string;
  calendar_id: string;
  client_state: string | null;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

export type CalendarTarget = { actor: UserActor; calendarId: string; subscriptionId: string; lifecycle: GraphNotice["lifecycleEvent"][] };

type Schedule = (task: () => Promise<unknown>) => void;

type Options = { fetchImpl?: typeof fetch; deadline?: number; schedule?: Schedule; pollMs?: number };

type CalendarState = { pending: boolean; held: boolean; connection_id: string | null; account_id: string | null };

function matches(given: string, stored: string | null) {
  if (!stored) return false;
  try {
    return safeEqual(given, decryptSecret(stored));
  } catch {
    return false;
  }
}

export async function calendarTargets(notices: GraphNotice[]) {
  const ids = [...new Set(notices.map((notice) => notice.subscriptionId))];
  if (ids.length === 0) return [];
  const owners = await query<OwnerRow>("select * from private.calendar_subscription_owners($1::text[])", [ids]);
  const bySubscription = new Map(owners.rows.map((row) => [row.subscription_id, row]));
  const targets = new Map<string, CalendarTarget>();
  for (const notice of notices) {
    const owner = bySubscription.get(notice.subscriptionId);
    if (!owner || !matches(notice.clientState, owner.client_state)) continue;
    const target = targets.get(owner.calendar_id) ?? { actor: memberActor(owner), calendarId: owner.calendar_id, subscriptionId: owner.subscription_id, lifecycle: [] };
    if (notice.lifecycleEvent) target.lifecycle.push(notice.lifecycleEvent);
    targets.set(owner.calendar_id, target);
  }
  return [...targets.values()];
}

async function prepareForRenewal(target: CalendarTarget) {
  const removed = target.lifecycle.includes("subscriptionRemoved");
  const renew = target.lifecycle.includes("reauthorizationRequired");
  if (!removed && !renew) return;
  await withActor(target.actor, (db) =>
    removed
      ? db.query(
          `update crm.calendars set graph_subscription_id = null, graph_subscription_expires_at = null, graph_client_state = null, graph_subscription_retry_at = null
           where id = $1 and user_id = $2 and graph_subscription_id = $3`,
          [target.calendarId, target.actor.userId, target.subscriptionId],
        )
      : db.query("update crm.calendars set graph_subscription_expires_at = now() where id = $1 and user_id = $2 and graph_subscription_id = $3", [
          target.calendarId,
          target.actor.userId,
          target.subscriptionId,
        ]),
  );
}

async function readState(actor: UserActor, calendarId: string) {
  const result = await withActor(actor, (db) =>
    db.query<CalendarState>(
      `select resync_pending as pending, coalesce(notify_locked_until > now(), false) as held, connection_id, account_id
       from crm.calendars where id = $1 and user_id = $2`,
      [calendarId, actor.userId],
    ),
  );
  return result.rows[0] ?? null;
}

function lockSeconds(until: number) {
  return Math.max(1, Math.ceil((until - Date.now()) / 1000)) + LOCK_GRACE_SECONDS;
}

async function claimCalendar(actor: UserActor, calendarId: string, until: number) {
  const result = await withActor(actor, (db) =>
    db.query(
      `update crm.calendars set notify_locked_until = now() + make_interval(secs => $3), resync_pending = false
       where id = $1 and user_id = $2 and (notify_locked_until is null or notify_locked_until < now())
       returning id`,
      [calendarId, actor.userId, lockSeconds(until)],
    ),
  );
  return (result.rowCount ?? 0) > 0;
}

async function changedAgain(actor: UserActor, calendarId: string, until: number) {
  const result = await withActor(actor, (db) =>
    db.query(
      `update crm.calendars set resync_pending = false, notify_locked_until = now() + make_interval(secs => $3)
       where id = $1 and user_id = $2 and resync_pending
       returning id`,
      [calendarId, actor.userId, lockSeconds(until)],
    ),
  );
  return (result.rowCount ?? 0) > 0;
}

async function releaseCalendar(actor: UserActor, calendarId: string) {
  await withActor(actor, (db) =>
    db.query("update crm.calendars set notify_locked_until = null where id = $1 and user_id = $2", [calendarId, actor.userId]),
  ).catch((error) => console.error("Couldn't release the calendar lock", error instanceof Error ? error.message : error));
}

export async function requestCalendarResync(actor: UserActor, calendarId: string) {
  await withActor(actor, (db) =>
    db.query("update crm.calendars set resync_pending = true where id = $1 and user_id = $2", [calendarId, actor.userId]),
  );
}

async function runPasses(actor: UserActor, calendarId: string, state: CalendarState, deadline: number, fetchImpl?: typeof fetch) {
  const source = state.account_id ? { kind: "account" as const, id: state.account_id } : state.connection_id ? { kind: "connection" as const, id: state.connection_id } : null;
  if (!source) return { passes: 0, ran: false };
  let passes = 0;
  let ran = false;
  for (;;) {
    passes += 1;
    const result = await syncCalendar(actor, { force: true, fetchImpl, deadline, source, calendarIds: [calendarId] });
    if (result.ran) ran = true;
    if (result.error) console.error("Calendar notification sync failed", result.error);
    if (passes >= MAX_PASSES || deadline - Date.now() < SHORTEST_SYNC_MS) break;
    if (!(await changedAgain(actor, calendarId, deadline))) break;
  }
  return { passes, ran };
}

export async function syncNotifiedCalendar(actor: UserActor, calendarId: string, options: { deadline: number; fetchImpl?: typeof fetch; pollMs?: number }) {
  const pollMs = options.pollMs ?? POLL_MS;
  let passes = 0;
  let syncs = 0;
  await requestCalendarResync(actor, calendarId);
  for (;;) {
    const state = await readState(actor, calendarId);
    if (!state?.pending) return { passes, unreached: false };
    const left = options.deadline - Date.now();
    if (!state.held && syncs < SYNC_LIMIT && left >= SHORTEST_SYNC_MS) {
      const until = Math.min(options.deadline, Date.now() + CALENDAR_SYNC_MS);
      if (!(await claimCalendar(actor, calendarId, until))) continue;
      syncs += 1;
      try {
        const outcome = await runPasses(actor, calendarId, state, until, options.fetchImpl);
        passes += outcome.passes;
        if (outcome.ran) await signalSynced(actor.userId, "calendar");
      } finally {
        await releaseCalendar(actor, calendarId);
      }
      continue;
    }
    if (left < pollMs + SHORTEST_SYNC_MS || syncs >= SYNC_LIMIT) return { passes, unreached: true };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function processCalendarTargets(targets: CalendarTarget[], deadline: number, options: Options = {}) {
  for (const target of targets) {
    if (deadline - Date.now() < SHORTEST_SYNC_MS) break;
    try {
      await prepareForRenewal(target);
      const outcome = await syncNotifiedCalendar(target.actor, target.calendarId, { deadline, fetchImpl: options.fetchImpl, pollMs: options.pollMs });
      if (outcome.unreached) console.error("Calendar webhook couldn't reach a calendar");
    } catch (error) {
      console.error("Calendar webhook sync failed", error);
    }
  }
}

function background(task: () => Promise<unknown>) {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error("Calendar webhook sync failed", error);
    }
  });
}

export async function handleCalendarNotifications(request: Request, options: Options = {}) {
  const validation = graphValidation(request);
  if (validation) return validation;
  const notices = await graphNotices(request);
  if (notices === null) return new Response(null, { status: 400 });
  if (notices.length > 0) {
    const deadline = options.deadline ?? Date.now() + BUDGET_MS;
    (options.schedule ?? background)(async () => processCalendarTargets(await calendarTargets(notices), deadline, options));
  }
  return new Response(null, { status: 202 });
}
