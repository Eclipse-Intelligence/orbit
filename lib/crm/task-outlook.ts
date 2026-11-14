import { createHash } from "node:crypto";
import { taskPanelHref } from "@/lib/chat/discussions";
import { BLOCK_WRITE_MARGIN_MS, readGrantedScopes } from "@/lib/crm/calendar";
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
  findTaskBlockEvents,
  graphInstant,
  patchGraphEvent,
  taskBlockDraft,
  taskBlockPatch,
  type CalendarEvent,
  type GraphEvent,
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
const CREATE_GRACE_MS = 2 * MINUTE_MS;
const SURPLUS_ATTEMPTS = 5;

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
  attempts: number;
  create_key: string | null;
  create_user_id: string | null;
  create_sent_at: Date | string | null;
  event_id: string | null;
  event_user_id: string | null;
  provider_event_id: string | null;
  event_starts_at: Date | string | null;
  event_ends_at: Date | string | null;
  event_subject: string | null;
  event_workspace_id: string | null;
  block_starts_at: Date | string | null;
  block_ends_at: Date | string | null;
};

export type BlockPlan =
  | { kind: "settle" }
  | { kind: "forget" }
  | { kind: "remove"; userId: string; requeue: boolean }
  | { kind: "write"; userId: string; start: Date; end: Date; create: boolean };

export type BlockOutcome = "created" | "updated" | "removed" | "unchanged" | "deferred" | "throttled" | "orbit_only";

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
  const eventUser = ref ? (row.event_user_id ?? (row.create_key ? row.create_user_id : null) ?? row.owner_id) : null;
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

export function blockTransactionId(taskId: string, createKey: string) {
  const hex = createHash("sha256").update(`${taskId}|${createKey}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function taskBlockLink(taskId: string, workspaceId: string) {
  const origin = siteOrigin();
  return origin ? `${origin}${openLink(workspaceId, taskPanelHref(taskId))}` : null;
}

type Outlook = { token: MicrosoftToken; connectionId: string; email: string; actor: UserActor };
type Access = Outlook | "orbit_only" | "retry";

async function actingActor(userId: string, workspaceId: string, anyWorkspace = false): Promise<UserActor | null> {
  const memberships = await query<{ workspace_id: string; workspace_name: string; role: WorkspaceRole }>(
    "select workspace_id, workspace_name, role from private.memberships_for($1)",
    [userId],
  );
  const row = memberships.rows.find((item) => item.workspace_id === workspaceId) ?? (anyWorkspace ? memberships.rows[0] : undefined);
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
  const writes = grantsCalendarWrite(source.scopes);
  return writes === true ? "outlook" : writes === false ? "orbit" : null;
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

type Failure = "orbit_only" | "gone" | "refused" | "denied" | "throttled" | "retry";

function graphFailure(error: unknown): Failure {
  if (error instanceof CalendarWriteScopeError) return "orbit_only";
  if (error instanceof CalendarWriteError) {
    if (error.status === 404) return "gone";
    if (error.status === 401) return "orbit_only";
    if (error.status === 429) return "throttled";
    if (error.status === 400) return "refused";
    if (error.status === 403) return "denied";
  }
  return "retry";
}

async function settle(row: BlockRow, ref: string | null | undefined, options: { requeue?: boolean; dropEvent?: boolean } = {}) {
  await query("select private.settle_task_block($1, $2, $3, $4, $5)", [
    row.task_id,
    options.requeue ? null : row.pending_at,
    ref ?? null,
    ref !== undefined,
    Boolean(options.dropEvent),
  ]);
}

async function defer(row: BlockRow, refused = false) {
  await query("select private.defer_task_block($1, $2, $3)", [row.task_id, row.pending_at, refused]).catch((error) => console.error("Deferring a task block failed", error));
}

async function release(row: BlockRow) {
  await query("select private.release_task_block($1)", [row.task_id]).catch((error) => console.error("Releasing a task block failed", error));
}

type Window = { start: Date; end: Date };

async function storeEvent(outlook: Outlook, row: BlockRow, providerEventId: string, window: Window, planned: Window) {
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
         is_all_day, is_cancelled, organizer, attendees, show_as, response_status, created_by_orbit, task_id, block_written_at,
         block_workspace_id, block_starts_at, block_ends_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, false, false, $9::jsonb, '[]'::jsonb, 'busy', 'organizer', true, $10, clock_timestamp(), $11, $12, $13)
       on conflict (calendar_id, provider_event_id) do update set
         subject = excluded.subject,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         is_cancelled = false,
         task_id = excluded.task_id,
         block_written_at = excluded.block_written_at,
         block_workspace_id = excluded.block_workspace_id,
         block_starts_at = excluded.block_starts_at,
         block_ends_at = excluded.block_ends_at`,
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
        row.workspace_id,
        planned.start.toISOString(),
        planned.end.toISOString(),
      ],
    );
  });
}

function sameWindow(start: Date | string | null, end: Date | string | null, window: Window) {
  return time(start) === window.start.getTime() && time(end) === window.end.getTime();
}

function eventWindow(event: Pick<GraphEvent, "start" | "end"> | null | undefined): Window | null {
  const start = graphInstant(event?.start);
  const end = graphInstant(event?.end);
  return start && end ? { start: new Date(start), end: new Date(end) } : null;
}

function failed(failure: Failure): BlockOutcome {
  if (failure === "throttled") return "throttled";
  if (failure === "orbit_only") return "orbit_only";
  return "deferred";
}

function ownerChanged(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42501";
}

async function dropCreated(outlook: Outlook, row: BlockRow, id: string, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  try {
    await deleteGraphEvent(outlook.token.accessToken, id, fetchImpl);
  } catch (error) {
    const failure = graphFailure(error);
    if (failure !== "gone") {
      await query("select private.link_task_block($1, null)", [row.task_id]);
      await defer(row);
      return failed(failure);
    }
  }
  await settle(row, null, { requeue: true, dropEvent: true });
  await defer(row);
  return "removed";
}

async function createBlock(outlook: Outlook, row: BlockRow, plan: Extract<BlockPlan, { kind: "write" }>, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  const begun = await query<{ key: string | null }>("select private.begin_task_block_create($1, $2)::text as key", [row.task_id, plan.userId]);
  const key = begun.rows[0]?.key;
  if (!key) {
    await defer(row);
    return "deferred";
  }
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
        transactionId: blockTransactionId(row.task_id, key),
        key,
      }),
      { fetchImpl },
    );
  } catch (error) {
    const failure = graphFailure(error);
    if (failure === "orbit_only") {
      await settle(row, null);
      return "orbit_only";
    }
    await defer(row, failure === "refused");
    return failed(failure);
  }
  const id = created.id?.trim();
  if (!id || id.length > 400) {
    await defer(row, true);
    return "deferred";
  }
  await query("select private.link_task_block($1, $2)", [row.task_id, id]);
  const written = eventWindow(created);
  if (written && !sameWindow(written.start, written.end, plan)) {
    return writeBlock(
      outlook,
      { ...row, calendar_event_ref: id, provider_event_id: id, event_id: null, event_starts_at: written.start, event_ends_at: written.end, block_starts_at: null, block_ends_at: null },
      { ...plan, create: false },
      fetchImpl,
    );
  }
  try {
    await storeEvent(outlook, row, id, plan, plan);
  } catch (error) {
    if (!ownerChanged(error)) throw error;
    return dropCreated(outlook, row, id, fetchImpl);
  }
  await settle(row, id);
  return "created";
}

async function writeBlock(outlook: Outlook, row: BlockRow, plan: Extract<BlockPlan, { kind: "write" }>, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  const ref = blockRef(row);
  if (plan.create || !ref) return createBlock(outlook, row, plan, fetchImpl);
  const agreed = row.block_starts_at && row.block_ends_at ? sameWindow(row.block_starts_at, row.block_ends_at, plan) : false;
  const inOutlook = sameWindow(row.event_starts_at, row.event_ends_at, plan);
  const moveTimes = !agreed && !inOutlook;
  if (row.event_id !== null && !moveTimes && row.event_subject === row.title && row.event_workspace_id === row.workspace_id) {
    if (!agreed) await agreeWindow(outlook, row, plan);
    await settle(row, ref);
    return "unchanged";
  }
  let patched;
  try {
    patched = await patchGraphEvent(
      outlook.token.accessToken,
      ref,
      taskBlockPatch({
        title: row.title,
        ...(moveTimes ? { start: plan.start, end: plan.end } : {}),
        timeZone: appTimeZone(),
        link: taskBlockLink(row.task_id, row.workspace_id),
      }),
      fetchImpl,
    );
  } catch (error) {
    const failure = graphFailure(error);
    if (failure === "gone") {
      if (row.completed_at) {
        await settle(row, null, { dropEvent: true });
        return "removed";
      }
      await query("select private.settle_task_block($1, null, null, true, true)", [row.task_id]);
      return createBlock(outlook, { ...row, calendar_event_ref: null, provider_event_id: null, event_id: null }, { ...plan, create: true }, fetchImpl);
    }
    await defer(row);
    return failed(failure);
  }
  const shown = moveTimes ? plan : (eventWindow(patched) ?? (row.event_starts_at && row.event_ends_at ? { start: new Date(row.event_starts_at), end: new Date(row.event_ends_at) } : plan));
  try {
    await storeEvent(outlook, row, ref, shown, plan);
  } catch (error) {
    if (!ownerChanged(error)) throw error;
    return dropCreated(outlook, row, ref, fetchImpl);
  }
  await settle(row, ref);
  return "updated";
}

async function agreeWindow(outlook: Outlook, row: BlockRow, plan: Window) {
  await withActor(outlook.actor, (db) =>
    db.query("update crm.calendar_events set block_starts_at = $3, block_ends_at = $4 where id = $1 and user_id = $2", [
      row.event_id,
      outlook.actor.userId,
      plan.start.toISOString(),
      plan.end.toISOString(),
    ]),
  );
}

async function removeBlock(outlook: Outlook, row: BlockRow, requeue: boolean, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  const ref = blockRef(row)!;
  try {
    await deleteGraphEvent(outlook.token.accessToken, ref, fetchImpl);
  } catch (error) {
    const failure = graphFailure(error);
    if (failure !== "gone") return unreachable(row, requeue, failure);
  }
  await settle(row, null, { requeue, dropEvent: true });
  return "removed";
}

async function unreachable(row: BlockRow, requeue: boolean, failure: Failure): Promise<BlockOutcome> {
  if (requeue && failure !== "throttled" && failure !== "retry") {
    await settle(row, null, { requeue: true, dropEvent: true });
    return "orbit_only";
  }
  await defer(row);
  return failed(failure);
}

async function runRow(row: BlockRow, plan: BlockPlan, access: Access, fetchImpl: typeof fetch): Promise<BlockOutcome> {
  if (plan.kind === "settle") {
    await settle(row, undefined);
    return "unchanged";
  }
  if (plan.kind === "forget") {
    await settle(row, null, { dropEvent: true });
    return "unchanged";
  }
  if (access === "retry") {
    await defer(row);
    return "deferred";
  }
  if (access === "orbit_only") {
    if (plan.kind === "write" && (plan.create || !blockRef(row))) {
      await settle(row, null);
      return "orbit_only";
    }
    return unreachable(row, plan.kind === "remove" && plan.requeue, "orbit_only");
  }
  if (plan.kind === "remove") return removeBlock(access, row, plan.requeue, fetchImpl);
  return writeBlock(access, row, plan, fetchImpl);
}

async function hold(row: BlockRow) {
  await query("select private.hold_task_block($1, $2::interval)", [row.task_id, `${CREATE_GRACE_MS / 1000} seconds`]).catch((error) =>
    console.error("Holding a task block failed", error),
  );
}

function recently(row: BlockRow, now: number) {
  const sent = time(row.create_sent_at);
  return sent !== null && now - sent < CREATE_GRACE_MS;
}

async function recoverCreates(
  rows: BlockRow[],
  fetchImpl: typeof fetch,
  result: BlockRun,
  deadline: number,
  throttledUsers: Set<string>,
): Promise<BlockRow[]> {
  const uncertain = new Map<string, BlockRow[]>();
  for (const row of rows) {
    if (!row.create_key || !row.create_user_id || blockRef(row)) continue;
    uncertain.set(row.create_user_id, [...(uncertain.get(row.create_user_id) ?? []), row]);
  }
  if (uncertain.size === 0) return rows;
  const recovered = new Map<string, BlockRow | null>();
  const skip = async (row: BlockRow, outcome: "deferred" | "throttled" | null) => {
    if (outcome) {
      await defer(row);
      result[outcome] += 1;
    } else {
      await release(row);
    }
    recovered.set(row.task_id, null);
  };
  for (const [userId, items] of uncertain) {
    if (deadline - Date.now() < RESERVE_MS) {
      for (const row of items) await skip(row, null);
      continue;
    }
    if (throttledUsers.has(userId)) {
      for (const row of items) await skip(row, "throttled");
      continue;
    }
    let access: Access = "retry";
    try {
      const actor = await actingActor(userId, items[0].workspace_id, true);
      access = actor ? await openOutlook(actor, fetchImpl) : "orbit_only";
    } catch (error) {
      console.error("Opening Outlook for task blocks failed", error);
    }
    if (access === "orbit_only" || access === "retry") {
      console.error("Couldn't look up an unconfirmed Outlook block", { userId, access });
      for (const row of items) {
        if (access === "orbit_only" && row.owner_id !== userId) {
          await settle(row, null, { requeue: true, dropEvent: true });
          result.orbit_only += 1;
          recovered.set(row.task_id, null);
          continue;
        }
        await skip(row, "deferred");
      }
      continue;
    }
    for (const row of items) {
      if (deadline - Date.now() < RESERVE_MS) {
        await skip(row, null);
        continue;
      }
      if (throttledUsers.has(userId)) {
        await skip(row, "throttled");
        continue;
      }
      let events: GraphEvent[];
      try {
        events = await findTaskBlockEvents(access.token.accessToken, row.create_key!, fetchImpl);
      } catch (error) {
        console.error("Looking up an unconfirmed Outlook block failed", error);
        const failure = graphFailure(error);
        if (failure === "throttled") throttledUsers.add(userId);
        await skip(row, failure === "throttled" ? "throttled" : "deferred");
        continue;
      }
      const [found, ...extra] = events;
      if (!found) {
        if (recently(row, Date.now())) {
          await hold(row);
          result.deferred += 1;
          recovered.set(row.task_id, null);
        }
        continue;
      }
      let surplusLeft = false;
      for (const event of extra) {
        if (throttledUsers.has(userId)) {
          surplusLeft = true;
          break;
        }
        await deleteGraphEvent(access.token.accessToken, event.id!.trim(), fetchImpl).catch((error) => {
          console.error("Removing a second Outlook block failed", error);
          surplusLeft = true;
          if (graphFailure(error) === "throttled") throttledUsers.add(userId);
        });
      }
      if (surplusLeft && row.attempts < SURPLUS_ATTEMPTS) {
        await skip(row, throttledUsers.has(userId) ? "throttled" : "deferred");
        continue;
      }
      const id = found.id!.trim();
      const shown = eventWindow(found);
      if (userId === row.owner_id) await query("select private.link_task_block($1, $2)", [row.task_id, id]);
      recovered.set(row.task_id, {
        ...row,
        calendar_event_ref: id,
        provider_event_id: id,
        event_id: null,
        event_user_id: userId,
        event_starts_at: shown?.start ?? null,
        event_ends_at: shown?.end ?? null,
        event_subject: found.subject ?? null,
        block_starts_at: null,
        block_ends_at: null,
      });
    }
  }
  return rows.flatMap((row) => {
    if (!recovered.has(row.task_id)) return [row];
    const next = recovered.get(row.task_id);
    return next ? [next] : [];
  });
}

function emptyRun(): BlockRun {
  return { created: 0, updated: 0, removed: 0, unchanged: 0, deferred: 0, throttled: 0, orbit_only: 0 };
}

export async function syncTaskBlocks(
  options: { taskIds?: string[]; userId?: string; fetchImpl?: typeof fetch; now?: number; deadline?: number; limit?: number } = {},
): Promise<BlockRun> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = options.deadline ?? Date.now() + 25_000;
  const result = emptyRun();
  if (options.taskIds && options.taskIds.length === 0) return result;
  const throttledUsers = new Set<string>();
  for (let round = 0; round < RUN_ROUNDS; round += 1) {
    if (deadline - Date.now() < RESERVE_MS) break;
    const claimed = await query<BlockRow>("select * from private.claim_task_blocks($1::uuid[], $2::uuid, $3)", [
      options.taskIds ?? null,
      options.userId ?? null,
      options.limit ?? RUN_LIMIT,
    ]);
    if (claimed.rows.length === 0) break;
    const now = options.now ?? Date.now();
    const rows = await recoverCreates(claimed.rows, fetchImpl, result, deadline, throttledUsers);
    const groups = new Map<string, { row: BlockRow; plan: BlockPlan }[]>();
    for (const row of rows) {
      const plan = planBlock(row, now);
      const key = plan.kind === "write" || plan.kind === "remove" ? `${plan.kind}:${plan.userId}` : "";
      groups.set(key, [...(groups.get(key) ?? []), { row, plan }]);
    }
    for (const [key, items] of groups) {
      let access: Access = "orbit_only";
      const [kind, userId] = key ? key.split(":") : [null, null];
      if (kind && userId && !throttledUsers.has(userId)) {
        try {
          const actor = await actingActor(userId, items[0].row.workspace_id, kind === "remove");
          access = actor ? await openOutlook(actor, fetchImpl) : "orbit_only";
        } catch (error) {
          console.error("Opening Outlook for task blocks failed", error);
          access = "retry";
        }
      }
      for (const { row, plan } of items) {
        if (deadline - Date.now() < RESERVE_MS) {
          await release(row);
          continue;
        }
        if (userId && throttledUsers.has(userId)) {
          await defer(row);
          result.throttled += 1;
          continue;
        }
        let outcome: BlockOutcome;
        try {
          outcome = await runRow(row, plan, access, fetchImpl);
        } catch (error) {
          console.error("Outlook task block failed", error);
          await defer(row);
          outcome = "deferred";
        }
        if (outcome === "throttled" && userId) throttledUsers.add(userId);
        result[outcome] += 1;
      }
    }
  }
  return result;
}

export async function queueOwnTaskBlocks(userId: string, now = Date.now(), fresh = false) {
  const result = await query<{ added: number }>("select private.queue_task_blocks($1, $2, $3) as added", [userId, new Date(now).toISOString(), fresh]);
  return result.rows[0]?.added ?? 0;
}

export async function noteTaskBlocksWrite(connectionId: string, write: boolean) {
  const result = await query<{ fresh: boolean }>("select private.note_task_blocks_write($1, $2) as fresh", [connectionId, write]);
  return Boolean(result.rows[0]?.fresh);
}

export async function flushTaskBlocks(
  actor: UserActor,
  connectionId: string,
  scope: string | null,
  options: { fetchImpl?: typeof fetch; deadline?: number; now?: number } = {},
) {
  const writes = grantsCalendarWrite(scope);
  if (writes !== null) {
    const fresh = await noteTaskBlocksWrite(connectionId, writes);
    if (writes) await queueOwnTaskBlocks(actor.userId, options.now, fresh);
  }
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

export function writtenBeforeFetch(written: number | null, fetchStartedAt: number) {
  return written !== null && written < fetchStartedAt - BLOCK_WRITE_MARGIN_MS;
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
    isGone: (providerEventId: string) => Promise<boolean>;
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
    if (!writtenBeforeFetch(written, input.fetchStartedAt)) continue;
    const open = !row.completed_at && !row.archived_at && row.due_has_time && row.due_at !== null;
    const event = fetched.get(row.provider_event_id);
    try {
      if (event) {
        if (!open || event.isAllDay || event.isCancelled) continue;
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
      if (!(await input.isGone(row.provider_event_id))) continue;
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
