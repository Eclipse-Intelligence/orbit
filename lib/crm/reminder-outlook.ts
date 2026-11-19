import { BLOCK_WRITE_MARGIN_MS } from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { ensureDefaultCalendar } from "@/lib/crm/invites";
import { actingActor, blockTransactionId, graphFailure, openOutlook, type Access, type Failure, type Outlook } from "@/lib/crm/task-outlook";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import {
  createGraphEvent,
  deleteGraphEvent,
  findTaskBlockEvents,
  patchGraphEvent,
  taskBlockDraft,
  taskBlockPatch,
  type CalendarEvent,
  type GraphEvent,
} from "@/lib/microsoft/calendar";
import { grantsCalendarWrite } from "@/lib/microsoft/oauth";
import { appTimeZone } from "@/lib/time";

const MINUTE_MS = 60_000;
const RUN_LIMIT = 50;
const RUN_ROUNDS = 4;
const RESERVE_MS = 4_000;
const CREATE_GRACE_MS = 2 * MINUTE_MS;

export type ReminderBlockRow = {
  reminder_id: string;
  user_id: string;
  present: boolean;
  title: string | null;
  due_at: Date | string | null;
  duration_minutes: number | null;
  blocks_time: boolean;
  completed_at: Date | string | null;
  pending_at: string;
  attempts: number;
  event_ref: string | null;
  create_key: string | null;
  create_sent_at: Date | string | null;
  event_id: string | null;
  provider_event_id: string | null;
  event_starts_at: Date | string | null;
  event_ends_at: Date | string | null;
  event_subject: string | null;
};

export type ReminderBlockPlan =
  | { kind: "settle" }
  | { kind: "remove"; ref: string }
  | { kind: "write"; ref: string | null; title: string; start: Date; end: Date };

export type ReminderBlockOutcome = "created" | "updated" | "removed" | "unchanged" | "deferred" | "throttled" | "orbit_only" | "turned_off";

export type ReminderBlockRun = Record<ReminderBlockOutcome, number>;

function time(value: Date | string | null | undefined) {
  return value ? new Date(value).getTime() : null;
}

export function reminderBlockRef(row: Pick<ReminderBlockRow, "event_ref" | "provider_event_id">) {
  return row.event_ref ?? row.provider_event_id;
}

export function planReminderBlock(row: ReminderBlockRow, now: number): ReminderBlockPlan {
  const ref = reminderBlockRef(row);
  const due = time(row.due_at);
  const wanted = row.present && row.blocks_time && due !== null && !row.completed_at && row.title !== null && row.duration_minutes !== null;
  if (!wanted || due === null) return ref ? { kind: "remove", ref } : { kind: "settle" };
  const start = due;
  const end = start + row.duration_minutes! * MINUTE_MS;
  if (!ref && end <= now) return { kind: "settle" };
  return { kind: "write", ref, title: row.title!, start: new Date(start), end: new Date(end) };
}

async function settle(row: ReminderBlockRow, ref: string | null, dropEvent = false) {
  await query("select private.settle_reminder_block($1, $2, $3, $4)", [row.reminder_id, row.pending_at, ref, dropEvent]);
}

async function defer(row: ReminderBlockRow, refused = false, refusedKey: string | null = null) {
  await query("select private.defer_reminder_block($1, $2, $3, $4)", [row.reminder_id, row.pending_at, refused, refusedKey]).catch((error) =>
    console.error("Deferring a reminder block failed", error),
  );
}

async function release(row: ReminderBlockRow) {
  await query("select private.release_reminder_block($1)", [row.reminder_id]).catch((error) => console.error("Releasing a reminder block failed", error));
}

async function hold(row: ReminderBlockRow) {
  await query("select private.hold_reminder_block($1, $2::interval)", [row.reminder_id, `${CREATE_GRACE_MS / 1000} seconds`]).catch((error) =>
    console.error("Holding a reminder block failed", error),
  );
}

function failed(failure: Failure): ReminderBlockOutcome {
  if (failure === "throttled") return "throttled";
  if (failure === "orbit_only") return "orbit_only";
  return "deferred";
}

type Window = { start: Date; end: Date };

async function storeEvent(outlook: Outlook, row: ReminderBlockRow, providerEventId: string, title: string, window: Window) {
  await withActor(outlook.actor, async (db) => {
    const calendarId = await ensureDefaultCalendar(db, outlook.actor, outlook.connectionId);
    await db.query("delete from crm.calendar_events where reminder_id = $1 and not (provider_event_id = $2 and calendar_id = $3)", [
      row.reminder_id,
      providerEventId,
      calendarId,
    ]);
    await db.query(
      `insert into crm.calendar_events (
         workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at,
         is_all_day, is_cancelled, organizer, attendees, show_as, response_status, created_by_orbit, reminder_id, block_written_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, false, false, $9::jsonb, '[]'::jsonb, 'busy', 'organizer', true, $10, clock_timestamp())
       on conflict (calendar_id, provider_event_id) do update set
         subject = excluded.subject,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         is_cancelled = false,
         reminder_id = excluded.reminder_id,
         block_written_at = excluded.block_written_at`,
      [
        outlook.actor.workspaceId,
        calendarId,
        outlook.connectionId,
        outlook.actor.userId,
        providerEventId,
        title,
        window.start.toISOString(),
        window.end.toISOString(),
        JSON.stringify({ name: outlook.actor.fullName, email: outlook.email }),
        row.reminder_id,
      ],
    );
  });
}

async function stored(outlook: Outlook, row: ReminderBlockRow, ref: string, title: string, window: Window, outcome: ReminderBlockOutcome) {
  try {
    await storeEvent(outlook, row, ref, title, window);
  } catch (error) {
    console.error("Saving a reminder block failed", error);
    await query("select private.link_reminder_block($1, $2)", [row.reminder_id, ref]);
    await defer(row);
    return "deferred" as const;
  }
  await settle(row, ref);
  return outcome;
}

async function createBlock(outlook: Outlook, row: ReminderBlockRow, plan: Extract<ReminderBlockPlan, { kind: "write" }>, fetchImpl: typeof fetch): Promise<ReminderBlockOutcome> {
  const begun = await query<{ key: string | null }>("select private.begin_reminder_block_create($1)::text as key", [row.reminder_id]);
  const key = begun.rows[0]?.key;
  if (!key) {
    await defer(row);
    return "deferred";
  }
  let created: GraphEvent;
  try {
    created = await createGraphEvent(
      outlook.token.accessToken,
      taskBlockDraft({
        title: plan.title,
        start: plan.start,
        end: plan.end,
        timeZone: appTimeZone(),
        link: null,
        transactionId: blockTransactionId(row.reminder_id, key),
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
    const madeNothing = failure === "refused" || failure === "denied";
    await defer(row, failure === "refused", madeNothing ? key : null);
    return failed(failure);
  }
  const id = created.id?.trim();
  if (!id || id.length > 400) {
    await defer(row, true);
    return "deferred";
  }
  await query("select private.link_reminder_block($1, $2)", [row.reminder_id, id]);
  return stored(outlook, row, id, plan.title, plan, "created");
}

async function writeBlock(outlook: Outlook, row: ReminderBlockRow, plan: Extract<ReminderBlockPlan, { kind: "write" }>, fetchImpl: typeof fetch): Promise<ReminderBlockOutcome> {
  const ref = plan.ref;
  if (!ref) return createBlock(outlook, row, plan, fetchImpl);
  const mirrored =
    row.event_id !== null &&
    row.provider_event_id === ref &&
    row.event_subject === plan.title &&
    time(row.event_starts_at) === plan.start.getTime() &&
    time(row.event_ends_at) === plan.end.getTime();
  if (mirrored) {
    await settle(row, ref);
    return "unchanged";
  }
  try {
    await patchGraphEvent(
      outlook.token.accessToken,
      ref,
      taskBlockPatch({ title: plan.title, start: plan.start, end: plan.end, timeZone: appTimeZone(), link: null }),
      fetchImpl,
    );
  } catch (error) {
    const failure = graphFailure(error);
    if (failure === "gone") {
      await query("select private.reminder_block_gone($1, $2)", [row.reminder_id, ref]);
      await settle(row, null);
      return "turned_off";
    }
    await defer(row);
    return failed(failure);
  }
  return stored(outlook, row, ref, plan.title, plan, "updated");
}

async function removeBlock(outlook: Outlook, row: ReminderBlockRow, ref: string, fetchImpl: typeof fetch): Promise<ReminderBlockOutcome> {
  try {
    await deleteGraphEvent(outlook.token.accessToken, ref, fetchImpl);
  } catch (error) {
    const failure = graphFailure(error);
    if (failure !== "gone") {
      await defer(row);
      return failed(failure);
    }
  }
  await settle(row, null, true);
  return "removed";
}

async function runRow(row: ReminderBlockRow, plan: ReminderBlockPlan, access: Access, fetchImpl: typeof fetch): Promise<ReminderBlockOutcome> {
  if (plan.kind === "settle") {
    await settle(row, null);
    return "unchanged";
  }
  if (access === "retry") {
    await defer(row);
    return "deferred";
  }
  if (access === "orbit_only") {
    if (plan.kind === "write" && !plan.ref) {
      await settle(row, null);
      return "orbit_only";
    }
    await defer(row);
    return "orbit_only";
  }
  if (plan.kind === "remove") return removeBlock(access, row, plan.ref, fetchImpl);
  return writeBlock(access, row, plan, fetchImpl);
}

async function recoverCreate(row: ReminderBlockRow, access: Outlook, fetchImpl: typeof fetch, throttled: Set<string>): Promise<ReminderBlockRow | "held" | "deferred" | "throttled"> {
  if (!row.create_key || reminderBlockRef(row)) return row;
  let events: GraphEvent[];
  try {
    events = await findTaskBlockEvents(access.token.accessToken, row.create_key, fetchImpl);
  } catch (error) {
    console.error("Looking up an unconfirmed reminder block failed", error);
    const failure = graphFailure(error);
    if (failure === "throttled") throttled.add(row.user_id);
    await defer(row);
    return failure === "throttled" ? "throttled" : "deferred";
  }
  const [found, ...extra] = events;
  if (!found) {
    const sent = time(row.create_sent_at);
    if (sent !== null && Date.now() - sent < CREATE_GRACE_MS) {
      await hold(row);
      return "held";
    }
    return row;
  }
  for (const event of extra) {
    const removed = await deleteGraphEvent(access.token.accessToken, event.id!.trim(), fetchImpl).then(
      () => true,
      (error) => {
        console.error("Removing a second reminder block failed", error);
        if (graphFailure(error) === "throttled") throttled.add(row.user_id);
        return false;
      },
    );
    if (!removed) {
      await defer(row);
      return throttled.has(row.user_id) ? "throttled" : "deferred";
    }
  }
  const id = found.id!.trim();
  await query("select private.link_reminder_block($1, $2)", [row.reminder_id, id]);
  return { ...row, event_ref: id };
}

function emptyRun(): ReminderBlockRun {
  return { created: 0, updated: 0, removed: 0, unchanged: 0, deferred: 0, throttled: 0, orbit_only: 0, turned_off: 0 };
}

async function accessFor(userId: string, fetchImpl: typeof fetch): Promise<Access> {
  try {
    const actor = await actingActor(userId, "", true);
    return actor ? await openOutlook(actor, fetchImpl) : "orbit_only";
  } catch (error) {
    console.error("Opening Outlook for reminder blocks failed", error);
    return "retry";
  }
}

export async function syncReminderBlocks(
  options: { reminderIds?: string[]; userId?: string; fetchImpl?: typeof fetch; now?: number; deadline?: number; limit?: number; throttled?: Set<string> } = {},
): Promise<ReminderBlockRun> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = options.deadline ?? Date.now() + 25_000;
  const result = emptyRun();
  if (options.reminderIds && options.reminderIds.length === 0) return result;
  const throttled = options.throttled ?? new Set<string>();
  for (let round = 0; round < RUN_ROUNDS; round += 1) {
    if (deadline - Date.now() < RESERVE_MS) break;
    const claimed = await query<ReminderBlockRow>("select * from private.claim_reminder_blocks($1::uuid[], $2::uuid, $3)", [
      options.reminderIds ?? null,
      options.userId ?? null,
      options.limit ?? RUN_LIMIT,
    ]);
    if (claimed.rows.length === 0) break;
    const byUser = new Map<string, ReminderBlockRow[]>();
    for (const row of claimed.rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
    for (const [userId, rows] of byUser) {
      const needsOutlook = rows.some((row) => planReminderBlock(row, options.now ?? Date.now()).kind !== "settle" || row.create_key);
      const access: Access = needsOutlook && !throttled.has(userId) ? await accessFor(userId, fetchImpl) : "orbit_only";
      for (const claimedRow of rows) {
        if (deadline - Date.now() < RESERVE_MS) {
          await release(claimedRow);
          continue;
        }
        if (throttled.has(userId)) {
          await defer(claimedRow);
          result.throttled += 1;
          continue;
        }
        let outcome: ReminderBlockOutcome;
        try {
          let row = claimedRow;
          if (typeof access === "object") {
            const recovered = await recoverCreate(claimedRow, access, fetchImpl, throttled);
            if (recovered === "held") {
              result.deferred += 1;
              continue;
            }
            if (recovered === "deferred" || recovered === "throttled") {
              result[recovered] += 1;
              continue;
            }
            row = recovered;
          } else if (access === "retry" && claimedRow.create_key && !reminderBlockRef(claimedRow)) {
            await defer(claimedRow);
            result.deferred += 1;
            continue;
          }
          outcome = await runRow(row, planReminderBlock(row, options.now ?? Date.now()), access, fetchImpl);
        } catch (error) {
          console.error("Outlook reminder block failed", error);
          await defer(claimedRow);
          outcome = "deferred";
        }
        if (outcome === "throttled") throttled.add(userId);
        result[outcome] += 1;
      }
    }
  }
  return result;
}

export async function flushReminderBlocks(actor: UserActor, scope: string | null, options: { fetchImpl?: typeof fetch; deadline?: number; now?: number } = {}) {
  if (grantsCalendarWrite(scope) === true) {
    await query("select private.queue_reminder_blocks($1, $2)", [actor.userId, new Date(options.now ?? Date.now()).toISOString()]);
  }
  return syncReminderBlocks({ userId: actor.userId, fetchImpl: options.fetchImpl, deadline: options.deadline, now: options.now });
}

type GoneRow = { reminder_id: string; provider_event_id: string; starts_at: Date | string; block_written_at: Date | string | null };

export async function readBackReminderBlocks(
  actor: UserActor,
  input: {
    calendarId: string;
    events: CalendarEvent[];
    complete: boolean;
    window: { start: Date; end: Date };
    fetchStartedAt: number;
    isGone: (providerEventId: string) => Promise<boolean>;
  },
) {
  if (!input.complete) return [];
  const rows = await withActor(actor, (db) =>
    db.query<GoneRow>(
      `select e.reminder_id, e.provider_event_id, e.starts_at, e.block_written_at
       from crm.calendar_events e
       where e.calendar_id = $1 and e.user_id = $2 and e.reminder_id is not null`,
      [input.calendarId, actor.userId],
    ),
  );
  const turnedOff: string[] = [];
  if (rows.rows.length === 0) return turnedOff;
  const fetched = new Set(input.events.map((event) => event.providerEventId));
  const missing = rows.rows.filter((row) => {
    if (fetched.has(row.provider_event_id)) return false;
    const startsAt = new Date(row.starts_at).getTime();
    if (startsAt < input.window.start.getTime() || startsAt >= input.window.end.getTime()) return false;
    const written = time(row.block_written_at);
    return written !== null && written < input.fetchStartedAt - BLOCK_WRITE_MARGIN_MS;
  });
  if (missing.length === 0) return turnedOff;
  const pending = new Set(
    (await query<{ reminder_id: string }>("select reminder_id from private.reminder_blocks_pending($1::uuid[]) as reminder_id", [missing.map((row) => row.reminder_id)])).rows.map(
      (row) => row.reminder_id,
    ),
  );
  for (const row of missing) {
    if (pending.has(row.reminder_id)) continue;
    try {
      if (!(await input.isGone(row.provider_event_id))) continue;
      const cleared = await withActor(actor, async (db) => {
        const removed = await db.query("delete from crm.calendar_events where reminder_id = $1 and user_id = $2 and provider_event_id = $3", [
          row.reminder_id,
          actor.userId,
          row.provider_event_id,
        ]);
        if ((removed.rowCount ?? 0) === 0) return false;
        await db.query("update crm.reminders set blocks_time = false where id = $1 and user_id = $2 and blocks_time", [row.reminder_id, actor.userId]);
        return true;
      });
      if (cleared) turnedOff.push(row.reminder_id);
    } catch (error) {
      console.error("Reading a reminder block back from Outlook failed", error);
    }
  }
  return turnedOff;
}
