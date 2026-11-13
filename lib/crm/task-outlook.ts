import { createHash } from "node:crypto";
import { taskPanelHref } from "@/lib/chat/discussions";
import { readGrantedScopes } from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { readStored } from "@/lib/crm/inbox";
import { type GraphSource, writableSourceToken } from "@/lib/crm/invite-senders";
import { ensureDefaultCalendar } from "@/lib/crm/invites";
import { scopesForRole } from "@/lib/crm/scopes";
import { taskDueDay } from "@/lib/crm/task-time";
import { scheduleTaskInDb, updateTaskInDb } from "@/lib/crm/tasks";
import type { Provenance, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { workspaceActors } from "@/lib/crm/workspaces";
import { query, type Db } from "@/lib/db/pool";
import {
  CalendarWriteError,
  CalendarWriteScopeError,
  createGraphEvent,
  deleteGraphEvent,
  patchGraphEvent,
  taskBlockDraft,
  taskBlockPatch,
  type CalendarEvent,
} from "@/lib/microsoft/calendar";
import { grantsCalendarWrite, MICROSOFT_REJECTED, MicrosoftError, microsoftConfigured, type MicrosoftToken } from "@/lib/microsoft/oauth";
import { openLink } from "@/lib/open-link";
import { siteOrigin } from "@/lib/site-url";
import { appTimeZone } from "@/lib/time";

const MINUTE_MS = 60_000;
const RUN_LIMIT = 50;
const RUN_ROUNDS = 4;
const RESERVE_MS = 4_000;
const MIN_MINUTES = 5;
const MAX_MINUTES = 480;

export const CALENDAR_SYNC: Provenance = { operation: "calendar_sync", source: "microsoft" };

export type BlockRow = {
  task_id: string;
  workspace_id: string;
  title: string;
  due_at: Date | string | null;
  due_has_time: boolean;
  duration_minutes: number;
  owner_id: string | null;
  completed_at: Date | string | null;
  archived_at: Date | string | null;
  calendar_event_ref: string | null;
  pending_at: string;
  event_id: string | null;
  event_user_id: string | null;
  provider_event_id: string | null;
  event_starts_at: Date | string | null;
  event_ends_at: Date | string | null;
  event_subject: string | null;
};

export type BlockPlan =
  | { kind: "settle" }
  | { kind: "forget" }
  | { kind: "remove"; userId: string; requeue: boolean }
  | { kind: "write"; userId: string; start: Date; end: Date; create: boolean };

export type BlockOutcome = "created" | "updated" | "removed" | "unchanged" | "retry" | "orbit_only";

export type BlockRun = Record<BlockOutcome, number>;

function time(value: Date | string | null | undefined) {
  return value ? new Date(value).getTime() : null;
}

function floorMinute(value: number) {
  return Math.floor(value / MINUTE_MS) * MINUTE_MS;
}

export function blockRef(row: Pick<BlockRow, "calendar_event_ref" | "provider_event_id">) {
  return row.calendar_event_ref ?? row.provider_event_id;
}

export function planBlock(row: BlockRow, now: number): BlockPlan {
  const ref = blockRef(row);
  const eventUser = ref ? (row.event_user_id ?? row.owner_id) : null;
  if (ref && !eventUser) return { kind: "forget" };
  if (ref && eventUser && eventUser !== row.owner_id) return { kind: "remove", userId: eventUser, requeue: true };
  const due = time(row.due_at);
  const eligible = Boolean(row.owner_id && row.due_has_time && due !== null && !row.archived_at);
  if (!eligible || due === null || !row.owner_id) return ref && eventUser ? { kind: "remove", userId: eventUser, requeue: false } : { kind: "settle" };
  const start = due;
  const end = start + row.duration_minutes * MINUTE_MS;
  const completed = time(row.completed_at);
  if (completed !== null) {
    if (!ref) return { kind: "settle" };
    const cut = floorMinute(completed);
    if (cut <= start) return { kind: "remove", userId: row.owner_id, requeue: false };
    if (cut < end) return { kind: "write", userId: row.owner_id, start: new Date(start), end: new Date(cut), create: false };
    return { kind: "settle" };
  }
  if (!ref) return end > now ? { kind: "write", userId: row.owner_id, start: new Date(start), end: new Date(end), create: true } : { kind: "settle" };
  return { kind: "write", userId: row.owner_id, start: new Date(start), end: new Date(end), create: false };
}

export function blockTransactionId(taskId: string, pendingAt: string) {
  const hex = createHash("sha256").update(`${taskId}|${pendingAt}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function taskBlockLink(taskId: string, workspaceId: string) {
  const origin = siteOrigin();
  return origin ? `${origin}${openLink(workspaceId, taskPanelHref(taskId))}` : null;
}

type Outlook = { token: MicrosoftToken; connectionId: string; email: string; actor: UserActor };
type Access = Outlook | "orbit_only" | "retry";

async function actingActor(userId: string, preferredWorkspace: string): Promise<UserActor | null> {
  const memberships = await query<{ workspace_id: string; workspace_name: string; role: WorkspaceRole }>(
    "select workspace_id, workspace_name, role from private.memberships_for($1)",
    [userId],
  );
  const row = memberships.rows.find((item) => item.workspace_id === preferredWorkspace) ?? memberships.rows[0];
  if (!row) return null;
  const base: UserActor = {
    type: "user",
    userId,
    email: "",
    fullName: null,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    role: row.role,
    scopes: scopesForRole(row.role),
  };
  const profile = await withActor(base, (db) =>
    db.query<{ email: string | null; full_name: string | null }>("select email, full_name from crm.profiles where id = $1", [userId]),
  );
  return { ...base, email: profile.rows[0]?.email ?? "", fullName: profile.rows[0]?.full_name ?? null };
}

async function mainSource(db: Db, actor: UserActor): Promise<GraphSource | null> {
  if (!microsoftConfigured()) return null;
  const stored = await readStored(db, actor);
  if (!stored || stored.status !== "connected" || !stored.refreshTokenCipher) return null;
  return { kind: "connection", id: stored.id, email: stored.email.toLowerCase(), tokens: stored, scopes: await readGrantedScopes(db, stored.id) };
}

export async function taskBlocksReach(db: Db, actor: UserActor): Promise<"outlook" | "orbit" | null> {
  const source = await mainSource(db, actor);
  if (!source) return null;
  return grantsCalendarWrite(source.scopes) === false ? "orbit" : "outlook";
}

function stopped(error: unknown) {
  return error instanceof MicrosoftError && (error.stopsRun || error.message === MICROSOFT_REJECTED);
}

async function openOutlook(actor: UserActor, fetchImpl: typeof fetch): Promise<Access> {
  const source = await withActor(actor, (db) => mainSource(db, actor));
  if (!source) return "orbit_only";
  try {
    const token = await writableSourceToken(actor, source, fetchImpl, (error) =>
      new CrmError(stopped(error) ? "not_connected" : "unavailable", "Couldn't reach Outlook. Try again.", 503),
    );
    return { token, connectionId: source.id, email: source.email, actor };
  } catch (error) {
    if (error instanceof CrmError && (error.code === "scope_missing" || error.code === "not_connected")) return "orbit_only";
    return "retry";
  }
}

function graphFailure(error: unknown): "orbit_only" | "gone" | "refused" | "retry" {
  if (error instanceof CalendarWriteScopeError) return "orbit_only";
  if (error instanceof CalendarWriteError) {
    if (error.status === 404) return "gone";
    if (error.status === 401 || error.status === 403) return "orbit_only";
    if (error.status === 400) return "refused";
  }
  return "retry";
}

async function settle(row: BlockRow, ref: string | null | undefined, options: { requeue?: boolean } = {}) {
  await query("select private.settle_task_block($1, $2, $3, $4)", [
    row.task_id,
    options.requeue ? null : row.pending_at,
    ref ?? null,
    ref !== undefined,
  ]);
}

async function release(row: BlockRow) {
  await query("select private.release_task_block($1)", [row.task_id]).catch((error) => console.error("Releasing a task block failed", error));
}

async function forgetEvent(outlook: Pick<Outlook, "actor">, row: BlockRow) {
  await withActor(outlook.actor, (db) =>
    db.query("delete from crm.calendar_events where task_id = $1 and user_id = $2", [row.task_id, outlook.actor.userId]),
  );
}

async function storeEvent(outlook: Outlook, row: BlockRow, providerEventId: string, window: { start: Date; end: Date }) {
  await withActor(outlook.actor, async (db) => {
    const calendarId = await ensureDefaultCalendar(db, outlook.actor, outlook.connectionId);
    await db.query("delete from crm.calendar_events where task_id = $1 and not (provider_event_id = $2 and calendar_id = $3)", [
      row.task_id,
      providerEventId,
      calendarId,
    ]);
    await db.query(
      `insert into crm.calendar_events (
         workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at,
         is_all_day, is_cancelled, organizer, attendees, show_as, response_status, created_by_orbit, task_id, block_written_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, false, false, $9::jsonb, '[]'::jsonb, 'busy', 'organizer', true, $10, clock_timestamp())
       on conflict (calendar_id, provider_event_id) do update set
         subject = excluded.subject,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         is_cancelled = false,
         task_id = excluded.task_id,
         block_written_at = excluded.block_written_at`,
      [
        outlook.actor.workspaceId,
        calendarId,
        outlook.connectionId,
        outlook.actor.userId,
        providerEventId,
        row.title,
        window.start.toISOString(),
        window.end.toISOString(),
        JSON.stringify({ name: outlook.actor.fullName, email: outlook.email }),
        row.task_id,
      ],
    );
  });
}

function sameWrite(row: BlockRow, plan: Extract<BlockPlan, { kind: "write" }>) {
  return (
    row.event_id !== null &&
    time(row.event_starts_at) === plan.start.getTime() &&
    time(row.event_ends_at) === plan.end.getTime() &&
    row.event_subject === row.title
  );
}

async function createBlock(outlook: Outlook, row: BlockRow, plan: Extract<BlockPlan, { kind: "write" }>, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  let created;
  try {
    created = await createGraphEvent(
      outlook.token.accessToken,
      taskBlockDraft({
        title: row.title,
        start: plan.start,
        end: plan.end,
        timeZone: appTimeZone(),
        link: taskBlockLink(row.task_id, row.workspace_id),
        transactionId: blockTransactionId(row.task_id, row.pending_at),
      }),
      { fetchImpl },
    );
  } catch (error) {
    const failure = graphFailure(error);
    if (failure === "retry") return "retry";
    await settle(row, null);
    return failure === "orbit_only" ? "orbit_only" : "unchanged";
  }
  const id = created.id?.trim();
  if (!id || id.length > 400) {
    await settle(row, null);
    return "unchanged";
  }
  await storeEvent(outlook, row, id, plan);
  await settle(row, id);
  return "created";
}

async function writeBlock(outlook: Outlook, row: BlockRow, plan: Extract<BlockPlan, { kind: "write" }>, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  const ref = blockRef(row);
  if (plan.create || !ref) return createBlock(outlook, row, plan, fetchImpl);
  if (sameWrite(row, plan)) {
    await settle(row, ref);
    return "unchanged";
  }
  try {
    await patchGraphEvent(
      outlook.token.accessToken,
      ref,
      taskBlockPatch({ title: row.title, start: plan.start, end: plan.end, timeZone: appTimeZone() }),
      fetchImpl,
    );
  } catch (error) {
    const failure = graphFailure(error);
    if (failure === "retry") return "retry";
    if (failure === "gone") {
      await forgetEvent(outlook, row);
      if (row.completed_at) {
        await settle(row, null);
        return "removed";
      }
      return createBlock(outlook, { ...row, calendar_event_ref: null, provider_event_id: null, event_id: null }, { ...plan, create: true }, fetchImpl);
    }
    await settle(row, ref);
    return failure === "orbit_only" ? "orbit_only" : "unchanged";
  }
  await storeEvent(outlook, row, ref, plan);
  await settle(row, ref);
  return "updated";
}

async function removeBlock(outlook: Outlook, row: BlockRow, requeue: boolean, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  const ref = blockRef(row)!;
  try {
    await deleteGraphEvent(outlook.token.accessToken, ref, fetchImpl);
  } catch (error) {
    const failure = graphFailure(error);
    if (failure === "retry") return "retry";
    if (failure !== "gone") {
      await settle(row, ref);
      return failure === "orbit_only" ? "orbit_only" : "unchanged";
    }
  }
  await forgetEvent(outlook, row);
  await settle(row, null, { requeue });
  return "removed";
}

async function runRow(row: BlockRow, plan: BlockPlan, access: Access, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  if (plan.kind === "settle") {
    await settle(row, undefined);
    return "unchanged";
  }
  if (plan.kind === "forget") {
    await settle(row, null);
    return "unchanged";
  }
  if (access === "retry") return "retry";
  if (access === "orbit_only") {
    await settle(row, plan.kind === "write" && plan.create ? null : undefined);
    return "orbit_only";
  }
  if (plan.kind === "remove") return removeBlock(access, row, plan.requeue, fetchImpl);
  return writeBlock(access, row, plan, fetchImpl);
}

function emptyRun(): BlockRun {
  return { created: 0, updated: 0, removed: 0, unchanged: 0, retry: 0, orbit_only: 0 };
}

export async function syncTaskBlocks(
  options: { taskIds?: string[]; userId?: string; fetchImpl?: typeof fetch; now?: number; deadline?: number; limit?: number } = {},
): Promise<BlockRun> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = options.deadline ?? Date.now() + 25_000;
  const result = emptyRun();
  if (options.taskIds && options.taskIds.length === 0) return result;
  for (let round = 0; round < RUN_ROUNDS; round += 1) {
    if (deadline - Date.now() < RESERVE_MS) break;
    const claimed = await query<BlockRow>("select * from private.claim_task_blocks($1::uuid[], $2::uuid, $3)", [
      options.taskIds ?? null,
      options.userId ?? null,
      options.limit ?? RUN_LIMIT,
    ]);
    if (claimed.rows.length === 0) break;
    const now = options.now ?? Date.now();
    const groups = new Map<string, { row: BlockRow; plan: BlockPlan }[]>();
    for (const row of claimed.rows) {
      const plan = planBlock(row, now);
      const key = plan.kind === "write" || plan.kind === "remove" ? plan.userId : "";
      groups.set(key, [...(groups.get(key) ?? []), { row, plan }]);
    }
    let requeued = false;
    for (const [userId, items] of groups) {
      let access: Access = "orbit_only";
      if (userId) {
        const actor = await actingActor(userId, items[0].row.workspace_id).catch(() => null);
        access = actor ? await openOutlook(actor, fetchImpl) : "orbit_only";
      }
      for (const { row, plan } of items) {
        if (deadline - Date.now() < RESERVE_MS) {
          await release(row);
          continue;
        }
        let outcome: BlockOutcome;
        try {
          outcome = await runRow(row, plan, access, fetchImpl);
        } catch (error) {
          console.error("Outlook task block failed", error);
          outcome = "retry";
        }
        if (plan.kind === "remove" && plan.requeue && outcome === "removed") requeued = true;
        result[outcome] += 1;
      }
    }
    if (!requeued && !options.taskIds) continue;
    if (!requeued) break;
  }
  return result;
}

export async function queueOwnTaskBlocks(userId: string, now = Date.now()) {
  const result = await query<{ added: number }>("select private.queue_task_blocks($1, $2) as added", [userId, new Date(now).toISOString()]);
  return result.rows[0]?.added ?? 0;
}

export async function flushTaskBlocks(actor: UserActor, scope: string | null, options: { fetchImpl?: typeof fetch; deadline?: number; now?: number } = {}) {
  if (grantsCalendarWrite(scope) === true) await queueOwnTaskBlocks(actor.userId, options.now);
  return syncTaskBlocks({ userId: actor.userId, fetchImpl: options.fetchImpl, deadline: options.deadline, now: options.now });
}

type ReadBackRow = {
  event_id: string;
  task_id: string;
  provider_event_id: string;
  starts_at: Date | string;
  block_written_at: Date | string | null;
  workspace_id: string;
  owner_id: string | null;
  due_at: Date | string | null;
  due_has_time: boolean;
  duration_minutes: number;
  completed_at: Date | string | null;
  archived_at: Date | string | null;
};

export function outlookMinutes(start: string, end: string) {
  const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / MINUTE_MS);
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes));
}

export async function readBackTaskBlocks(
  actor: UserActor,
  input: {
    calendarId: string;
    events: CalendarEvent[];
    complete: boolean;
    window: { start: Date; end: Date };
    fetchStartedAt: number;
    fetchImpl?: typeof fetch;
    pushClickUp?: (actor: UserActor, taskId: string) => Promise<unknown>;
  },
) {
  const rows = await withActor(actor, (db) =>
    db.query<ReadBackRow>(
      `select e.id as event_id, e.task_id, e.provider_event_id, e.starts_at, e.block_written_at,
              t.workspace_id, t.owner_id, t.due_at, t.due_has_time, t.duration_minutes, t.completed_at, t.archived_at
       from crm.calendar_events e
       join crm.tasks t on t.id = e.task_id
       where e.calendar_id = $1 and e.user_id = $2 and e.task_id is not null`,
      [input.calendarId, actor.userId],
    ),
  );
  const changed: { actor: UserActor; taskId: string }[] = [];
  if (rows.rows.length === 0) return changed;
  const pending = new Set(
    (await query<{ task_id: string }>("select task_id from private.task_blocks_pending($1::uuid[]) as task_id", [rows.rows.map((row) => row.task_id)])).rows.map(
      (row) => row.task_id,
    ),
  );
  const fetched = new Map(input.events.map((event) => [event.providerEventId, event]));
  const members = await workspaceActors(actor);
  for (const row of rows.rows) {
    if (pending.has(row.task_id) || row.owner_id !== actor.userId) continue;
    const member = members.find((item) => item.workspaceId === row.workspace_id);
    if (!member) continue;
    const written = time(row.block_written_at);
    const open = !row.completed_at && !row.archived_at && row.due_has_time && row.due_at !== null;
    const event = fetched.get(row.provider_event_id);
    try {
      if (event) {
        if (!open || event.isAllDay || event.isCancelled) continue;
        if (written !== null && written >= input.fetchStartedAt) continue;
        const minutes = outlookMinutes(event.startsAt, event.endsAt);
        if (time(row.due_at) === new Date(event.startsAt).getTime() && minutes === row.duration_minutes) continue;
        await withActor(member, (db) =>
          scheduleTaskInDb(db, member, row.task_id, { at: event.startsAt, durationMinutes: minutes, byHand: true }, CALENDAR_SYNC, () => null),
        );
        changed.push({ actor: member, taskId: row.task_id });
        continue;
      }
      if (!input.complete) continue;
      const startsAt = new Date(row.starts_at).getTime();
      if (startsAt < input.window.start.getTime() || startsAt >= input.window.end.getTime()) continue;
      if (written === null || written >= input.fetchStartedAt) continue;
      await withActor(member, async (db) => {
        if (open) {
          const day = taskDueDay(new Date(row.due_at!).toISOString());
          if (day) await updateTaskInDb(db, member, row.task_id, { dueDate: day }, CALENDAR_SYNC);
        }
        await db.query("delete from crm.calendar_events where id = $1 and user_id = $2", [row.event_id, actor.userId]);
        await db.query("update crm.tasks set calendar_event_ref = null where id = $1 and calendar_event_ref = $2", [row.task_id, row.provider_event_id]);
      });
      changed.push({ actor: member, taskId: row.task_id });
    } catch (error) {
      console.error("Reading a task block back from Outlook failed", error);
    }
  }
  for (const item of changed) {
    if (!input.pushClickUp) continue;
    await input.pushClickUp(item.actor, item.taskId).catch((error) => console.error("ClickUp push failed", error));
  }
  if (changed.length > 0) {
    await syncTaskBlocks({ taskIds: changed.map((item) => item.taskId), fetchImpl: input.fetchImpl }).catch((error) =>
      console.error("Outlook task blocks failed", error),
    );
  }
  return changed;
}
