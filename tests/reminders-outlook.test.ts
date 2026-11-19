import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { calendarAlerts } from "@/lib/calendar-alerts";
import { storeGrantedScopes, syncCalendar } from "@/lib/crm/calendar";
import { listCalendarItems } from "@/lib/crm/calendars";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import { cancelInvite, REMINDER_BLOCK_EVENT } from "@/lib/crm/invites";
import { addPadTask } from "@/lib/crm/pad-task";
import { readPlanContext } from "@/lib/crm/plan-schedule";
import { planReminderBlock, syncReminderBlocks, type ReminderBlockRow } from "@/lib/crm/reminder-outlook";
import { completeReminder, createReminder, deleteReminder, getReminder, reopenReminder, updateReminder } from "@/lib/crm/reminders";
import { busyFor } from "@/lib/crm/task-due";
import type { UserActor } from "@/lib/crm/types";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { TASK_BLOCK_NOTE, TASK_BLOCK_PROPERTY, type GraphEvent } from "@/lib/microsoft/calendar";
import { createUser, queryAsUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const WRITE_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read offline_access";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Call = { url: string; method: string; body: Record<string, unknown> | null };
type Stored = { subject: string; start: string; end: string; transactionId?: string; key?: string | null; body?: unknown; showAs?: unknown; sensitivity?: unknown };

function json(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function utc(iso: string) {
  return { dateTime: iso.replace("Z", "").replace(/\.\d{3}$/, ".0000000"), timeZone: "UTC" };
}

function londonOffset(at: number) {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" })
    .formatToParts(new Date(at))
    .find((part) => part.type === "timeZoneName")!.value;
  return name === "GMT" ? 0 : Number(name.replace("GMT", "")) * HOUR;
}

function fromGraph(value: unknown) {
  const item = value as { dateTime: string; timeZone: string };
  if (item.timeZone === "UTC") return new Date(`${item.dateTime}Z`).toISOString();
  const wall = Date.parse(`${item.dateTime}Z`);
  return new Date(wall - londonOffset(wall - londonOffset(wall))).toISOString();
}

class FakeOutlook {
  calls: Call[] = [];
  events = new Map<string, Stored>();
  created = 0;
  failCreate = 0;
  loseCreateResponses = 0;
  failPatchWith: number | null = null;
  failDeleteWith: number | null = null;
  hidden = new Set<string>();

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {}
    }
    this.calls.push({ url, method, body });
    const parsed = new URL(url);
    if (parsed.hostname === "login.microsoftonline.com") {
      return json({ access_token: "fresh-token", refresh_token: "refresh-token", expires_in: 3600, scope: WRITE_SCOPES });
    }
    if (parsed.hostname !== "graph.microsoft.com") throw new Error(`Unexpected host ${parsed.hostname}`);
    if (method === "POST" && parsed.pathname === "/v1.0/me/events") {
      if (this.failCreate > 0) {
        this.failCreate -= 1;
        return json({ error: { code: "ServiceUnavailable", message: "Busy" } }, 503);
      }
      const existing = [...this.events.entries()].find(([, event]) => event.transactionId && event.transactionId === body?.transactionId);
      if (existing) {
        if (this.loseCreateResponses > 0) {
          this.loseCreateResponses -= 1;
          throw new Error("socket hang up");
        }
        return json(this.graphEvent(existing[0]), 201);
      }
      this.created += 1;
      const id = `block-${this.created}`;
      const properties = (body!.singleValueExtendedProperties as { id: string; value: string }[] | undefined) ?? [];
      const key = properties.find((item) => item.id === TASK_BLOCK_PROPERTY)?.value ?? null;
      this.events.set(id, {
        subject: String(body!.subject),
        start: fromGraph(body!.start),
        end: fromGraph(body!.end),
        transactionId: String(body!.transactionId),
        key,
        body: body!.body,
        showAs: body!.showAs,
        sensitivity: body!.sensitivity,
      });
      if (this.loseCreateResponses > 0) {
        this.loseCreateResponses -= 1;
        throw new Error("socket hang up");
      }
      return json(this.graphEvent(id), 201);
    }
    if (method === "GET" && parsed.pathname === "/v1.0/me/events") {
      const filter = parsed.searchParams.get("$filter") ?? "";
      const value = /ep\/value eq '([^']+)'/.exec(filter)?.[1];
      const matches = [...this.events.entries()].filter(([, event]) => value && event.key === value && filter.includes(TASK_BLOCK_PROPERTY));
      return json({ value: matches.map(([id]) => this.graphEvent(id)) });
    }
    const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(parsed.pathname);
    if (one && method === "PATCH") {
      const id = decodeURIComponent(one[1]);
      if (this.failPatchWith) return json({ error: { code: "Nope", message: "Nope" } }, this.failPatchWith);
      const event = this.events.get(id);
      if (!event) return json({ error: { code: "ErrorItemNotFound", message: "Not found" } }, 404);
      this.events.set(id, {
        ...event,
        subject: String(body!.subject),
        start: body!.start === undefined ? event.start : fromGraph(body!.start),
        end: body!.end === undefined ? event.end : fromGraph(body!.end),
      });
      return json(this.graphEvent(id));
    }
    if (one && method === "GET") {
      const id = decodeURIComponent(one[1]);
      return this.events.has(id) ? json({ id }) : json({ error: { code: "ErrorItemNotFound", message: "Not found" } }, 404);
    }
    if (one && method === "DELETE") {
      const id = decodeURIComponent(one[1]);
      if (this.failDeleteWith) return json({ error: { code: "Nope", message: "Nope" } }, this.failDeleteWith);
      if (!this.events.delete(id)) return json({ error: { code: "ErrorItemNotFound", message: "Not found" } }, 404);
      return json(null, 204);
    }
    if (parsed.pathname === "/v1.0/me/calendars") {
      return json({ value: [{ id: "cal-main", name: "Calendar", isDefaultCalendar: true, canEdit: true }] });
    }
    if (parsed.pathname.endsWith("/calendarView")) {
      const from = Date.parse(parsed.searchParams.get("startDateTime")!);
      const to = Date.parse(parsed.searchParams.get("endDateTime")!);
      const inside = [...this.events.entries()].filter(([id, event]) => !this.hidden.has(id) && Date.parse(event.start) < to && Date.parse(event.end) > from);
      return json({ value: inside.map(([id]) => this.graphEvent(id)) });
    }
    return json({ error: { code: "NotFound", message: `Unexpected ${method} ${url}` } }, 404);
  }) as typeof fetch;

  graphEvent(id: string): GraphEvent {
    const event = this.events.get(id)!;
    return {
      id,
      subject: event.subject,
      start: utc(event.start),
      end: utc(event.end),
      isAllDay: false,
      isCancelled: false,
      showAs: "busy",
      organizer: { emailAddress: { name: "Mark", address: "mark@reminder-blocks.test" } },
      attendees: [],
    };
  }

  writes() {
    return this.calls.filter((call) => new URL(call.url).hostname === "graph.microsoft.com" && call.method !== "GET" && !new URL(call.url).pathname.startsWith("/v1.0/subscriptions"));
  }

  only() {
    assert.equal(this.events.size, 1, "one event in Outlook");
    return [...this.events.values()][0];
  }
}

const admin = () => getAdminPool();

async function connect(actor: UserActor) {
  await saveMailbox(actor, {
    email: "mark@reminder-blocks.test",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const connection = await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [actor.userId]);
  const id = connection.rows[0].id;
  await withActor(actor, (db) => storeGrantedScopes(db, actor, id, WRITE_SCOPES));
  await admin().query(
    `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
     values ($1, $2, $3, 'cal-main', 'Calendar', '#4f9be8', true, true, true, true)`,
    [actor.workspaceId, actor.userId, id],
  );
  return id;
}

function dayAhead(days: number) {
  return shiftDay(dayKeyAt(new Date()), days);
}

async function blocked(actor: UserActor, title: string, days = 3, clock = "10:00", extra: Record<string, unknown> = {}) {
  return (await createReminder(actor, { title, dueAt: `${dayAhead(days)}T${clock}`, blocksTime: true, durationMinutes: 30, ...extra })).reminder;
}

async function mirror(reminderId: string) {
  const row = await admin().query<{ id: string; provider_event_id: string; starts_at: Date; ends_at: Date; subject: string; user_id: string; show_as: string }>(
    "select id, provider_event_id, starts_at, ends_at, subject, user_id, show_as from crm.calendar_events where reminder_id = $1",
    [reminderId],
  );
  return row.rows[0] ?? null;
}

async function queued(reminderId: string) {
  const row = await admin().query<{ pending_at: Date; event_ref: string | null; create_key: string | null; retry_at: Date | null }>(
    "select pending_at, event_ref, create_key, retry_at from crm.reminder_outlook_queue where reminder_id = $1",
    [reminderId],
  );
  return row.rows[0] ?? null;
}

async function readyNow(reminderId: string) {
  await admin().query("update crm.reminder_outlook_queue set retry_at = null, create_sent_at = create_sent_at - interval '3 minutes' where reminder_id = $1", [reminderId]);
}

async function writtenEarlier(reminderId: string) {
  await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where reminder_id = $1", [reminderId]);
}

let mark: UserActor;
let outlook: FakeOutlook;
let seq = 0;

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
  process.env.SITE_URL = "https://orbit.example";
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

beforeEach(async () => {
  await admin().query("delete from crm.reminder_outlook_queue");
  seq += 1;
  mark = await createUser(`mark${seq}@reminder-blocks.test`, "Mark Ridgeon");
  outlook = new FakeOutlook();
});

function row(overrides: Partial<ReminderBlockRow> = {}): ReminderBlockRow {
  return {
    reminder_id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    present: true,
    title: "Boiler service",
    due_at: "2030-11-20T10:00:00.000Z",
    duration_minutes: 30,
    blocks_time: true,
    completed_at: null,
    pending_at: "2030-11-13 09:00:00.123456+00",
    attempts: 0,
    event_ref: null,
    create_key: null,
    create_sent_at: null,
    event_id: null,
    provider_event_id: null,
    event_starts_at: null,
    event_ends_at: null,
    event_subject: null,
    ...overrides,
  };
}

describe("the migration", () => {
  it("runs again over itself", async () => {
    await reapplyMigrationsFrom("20270222100000_reminders_outlook.sql");
    await reapplyMigrationsFrom("20270222100000_reminders_outlook.sql");
    const index = await admin().query("select 1 from pg_indexes where schemaname = 'crm' and indexname = 'calendar_events_reminder_key'");
    assert.equal(index.rowCount, 1);
    const grants = await admin().query<{ grantee: string }>(
      `select distinct grantee from information_schema.routine_privileges
       where routine_schema = 'private' and routine_name like '%reminder_block%' and privilege_type = 'EXECUTE'`,
    );
    assert.ok(grants.rows.some((item) => item.grantee === "crm_app"));
    assert.equal(grants.rows.some((item) => ["authenticated", "anon", "crm_agent", "PUBLIC"].includes(item.grantee)), false);
    await assert.rejects(queryAsUser(mark.userId, "select * from crm.reminder_outlook_queue"), /permission denied/);
  });
});

describe("planning a reminder block", () => {
  it("writes an open Block time reminder and removes anything else that has an event", () => {
    const now = Date.parse("2030-11-13T09:00:00Z");
    assert.deepEqual(planReminderBlock(row(), now), {
      kind: "write",
      ref: null,
      title: "Boiler service",
      start: new Date("2030-11-20T10:00:00.000Z"),
      end: new Date("2030-11-20T10:30:00.000Z"),
    });
    assert.deepEqual(planReminderBlock(row({ blocks_time: false }), now), { kind: "settle" });
    assert.deepEqual(planReminderBlock(row({ blocks_time: false, provider_event_id: "e1" }), now), { kind: "remove", ref: "e1" });
    assert.deepEqual(planReminderBlock(row({ completed_at: "2030-11-13T08:00:00Z", event_ref: "e2" }), now), { kind: "remove", ref: "e2" });
    assert.deepEqual(planReminderBlock(row({ present: false, title: null, due_at: null, event_ref: "e3" }), now), { kind: "remove", ref: "e3" });
    assert.deepEqual(planReminderBlock(row({ due_at: "2030-11-01T10:00:00.000Z" }), now), { kind: "settle" }, "no new event for a block that has passed");
  });
});

describe("Block time in Outlook", () => {
  useServerlessPool();

  it("writes a busy, private event titled with the reminder, for its length", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    const run = await syncReminderBlocks({ reminderIds: [reminder.id], fetchImpl: outlook.fetch });
    assert.equal(run.created, 1);
    const event = outlook.only();
    assert.equal(event.subject, "Boiler service");
    assert.equal(event.start, reminder.dueAt);
    assert.equal(event.end, new Date(Date.parse(reminder.dueAt!) + 30 * MINUTE).toISOString());
    assert.equal(event.showAs, "busy");
    assert.equal(event.sensitivity, "private");
    assert.deepEqual(event.body, { contentType: "HTML", content: `<p>${TASK_BLOCK_NOTE}</p>` });
    const stored = await mirror(reminder.id);
    assert.equal(stored?.provider_event_id, "block-1");
    assert.equal(stored?.user_id, mark.userId);
    assert.equal(await queued(reminder.id), null);
    const again = await syncReminderBlocks({ reminderIds: [reminder.id], fetchImpl: outlook.fetch });
    assert.equal(again.created + again.updated, 0);
  });

  it("writes nothing for a reminder without Block time or without a time", async () => {
    await connect(mark);
    const plain = (await createReminder(mark, { title: "Call mum", dueAt: `${dayAhead(2)}T09:00` })).reminder;
    const dated = (await createReminder(mark, { title: "Bins", dueOn: dayAhead(2) })).reminder;
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
    assert.equal(await queued(plain.id), null);
    assert.equal(await queued(dated.id), null);
  });

  it("moves the event when the date, time, length or title changes", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    const moved = (await updateReminder(mark, reminder.id, { dueAt: `${dayAhead(4)}T14:30`, durationMinutes: 60, title: "Boiler service, upstairs" })).reminder;
    const run = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.updated, 1);
    const event = outlook.only();
    assert.equal(event.subject, "Boiler service, upstairs");
    assert.equal(event.start, moved.dueAt);
    assert.equal(event.end, new Date(Date.parse(moved.dueAt!) + 60 * MINUTE).toISOString());
    const stored = await mirror(reminder.id);
    assert.equal(new Date(stored!.starts_at).toISOString(), moved.dueAt);
    assert.equal(outlook.created, 1);
  });

  it("removes the event on tick and puts it back on Undo", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    await completeReminder(mark, reminder.id);
    assert.equal((await syncReminderBlocks({ fetchImpl: outlook.fetch })).removed, 1);
    assert.equal(outlook.events.size, 0);
    assert.equal(await mirror(reminder.id), null);
    await reopenReminder(mark, reminder.id);
    assert.equal((await syncReminderBlocks({ fetchImpl: outlook.fetch })).created, 1);
    assert.equal(outlook.only().start, reminder.dueAt);
    assert.ok(await mirror(reminder.id));
  });

  it("removes the event when the reminder is deleted or Block time is turned off", async () => {
    await connect(mark);
    const first = await blocked(mark, "Boiler service");
    const second = await blocked(mark, "Dentist", 4);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 2);
    await deleteReminder(mark, first.id);
    await updateReminder(mark, second.id, { blocksTime: false });
    const run = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.removed, 2);
    assert.equal(outlook.events.size, 0);
    assert.equal((await admin().query("select 1 from crm.calendar_events where user_id = $1", [mark.userId])).rowCount, 0);
    assert.equal((await admin().query("select 1 from crm.reminder_outlook_queue where user_id = $1", [mark.userId])).rowCount, 0);
  });

  it("removes the event when the time is taken off", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    const dated = (await updateReminder(mark, reminder.id, { dueAt: null })).reminder;
    assert.equal(dated.blocksTime, false);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
  });

  it("writes only the current date of a repeating reminder and moves it on tick and back on Undo", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Stand-up prep", 2, "09:00", { repeat: { every: "day" } });
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.only().start, reminder.dueAt);
    const ticked = await completeReminder(mark, reminder.id, { dueOn: reminder.dueOn });
    assert.notEqual(ticked.reminder.dueOn, reminder.dueOn);
    const run = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.updated, 1);
    assert.equal(outlook.only().start, ticked.reminder.dueAt);
    assert.equal(outlook.created, 1);
    assert.equal((await admin().query("select 1 from crm.calendar_events where user_id = $1", [mark.userId])).rowCount, 1, "the done copy has no event");
    await reopenReminder(mark, ticked.doneId!);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.only().start, reminder.dueAt);
    assert.equal(outlook.created, 1);
  });

  it("removes the event when the reminder is turned into a task", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    const result = await addPadTask(mark, { title: "Boiler service", dueAt: reminder.dueAt, durationMinutes: 30, remindMinutes: null, clickupListId: null, fromReminderId: reminder.id });
    assert.equal(result.ok, true);
    await syncReminderBlocks({ reminderIds: [reminder.id], fetchImpl: outlook.fetch });
    assert.equal([...outlook.events.keys()].includes("block-1"), false);
    await assert.rejects(getReminder(mark, reminder.id), (error: unknown) => error instanceof CrmError && error.status === 404);
  });

  it("writes nothing and raises nothing for someone with no Microsoft connection", async () => {
    const reminder = await blocked(mark, "Boiler service");
    const run = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.orbit_only, 1);
    assert.equal(outlook.calls.length, 0);
    assert.equal(await queued(reminder.id), null);
    await updateReminder(mark, reminder.id, { durationMinutes: 45 });
    await completeReminder(mark, reminder.id);
    await deleteReminder(mark, reminder.id);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.calls.length, 0);
  });

  it("writes reminders made before Microsoft was connected on the next calendar sync", async () => {
    const reminder = await blocked(mark, "Boiler service");
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    await connect(mark);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal(outlook.only().subject, "Boiler service");
    assert.ok(await mirror(reminder.id));
  });

  it("puts an event moved in Outlook back on the next write", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    await writtenEarlier(reminder.id);
    const dragged = new Date(Date.parse(reminder.dueAt!) + 2 * HOUR).toISOString();
    outlook.events.set("block-1", { ...outlook.events.get("block-1")!, start: dragged, end: new Date(Date.parse(dragged) + 30 * MINUTE).toISOString() });
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    const after = (await getReminder(mark, reminder.id)).reminder;
    assert.equal(after.dueAt, reminder.dueAt, "the move is not read back");
    assert.equal(after.blocksTime, true);
    await updateReminder(mark, reminder.id, { title: "Boiler service at 10" });
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.only().start, reminder.dueAt);
  });

  it("turns Block time off when the event was deleted in Outlook and Orbit next writes it", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    outlook.events.clear();
    await updateReminder(mark, reminder.id, { durationMinutes: 45 });
    const run = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.turned_off, 1);
    assert.equal((await getReminder(mark, reminder.id)).reminder.blocksTime, false);
    assert.equal(await mirror(reminder.id), null);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1, "never written again");
    assert.equal(await queued(reminder.id), null);
  });

  it("turns Block time off when calendar sync finds the event deleted in Outlook", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    const kept = await blocked(mark, "Dentist", 4);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    await writtenEarlier(reminder.id);
    await writtenEarlier(kept.id);
    const keptRef = (await mirror(kept.id))!.provider_event_id;
    outlook.hidden.add(keptRef);
    outlook.events.delete((await mirror(reminder.id))!.provider_event_id);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getReminder(mark, reminder.id)).reminder.blocksTime, false);
    assert.equal(await mirror(reminder.id), null);
    assert.equal((await getReminder(mark, kept.id)).reminder.blocksTime, true, "an event missing from the list but still in Outlook stays");
    assert.ok(await mirror(kept.id), "calendar sync never prunes a reminder's event");
    assert.equal(outlook.created, 2);
  });
});

describe("retries and duplicates", () => {
  useServerlessPool();

  it("retries a failed create and writes one event", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    outlook.failCreate = 2;
    const failed = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(failed.deferred, 1);
    assert.ok((await queued(reminder.id))?.retry_at);
    await readyNow(reminder.id);
    const retried = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(retried.created, 1);
    assert.equal(outlook.events.size, 1);
  });

  it("finds an event whose create reply was lost instead of writing a second one", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    outlook.loseCreateResponses = 2;
    const lost = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(lost.deferred, 1);
    assert.equal(outlook.events.size, 1);
    assert.ok((await queued(reminder.id))?.create_key);
    await admin().query("update crm.reminder_outlook_queue set retry_at = null where reminder_id = $1", [reminder.id]);
    const early = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(early.created, 0);
    assert.equal(outlook.created, 1);
    await readyNow(reminder.id);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1);
    assert.equal(outlook.events.size, 1);
    assert.equal((await mirror(reminder.id))?.provider_event_id, "block-1");
    assert.equal(await queued(reminder.id), null);
  });

  it("removes an event whose create reply was lost after the reminder was deleted", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    outlook.loseCreateResponses = 2;
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    await deleteReminder(mark, reminder.id);
    await readyNow(reminder.id);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
    assert.equal(await queued(reminder.id), null);
  });

  it("writes one event when two runs race", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    await Promise.all([syncReminderBlocks({ fetchImpl: outlook.fetch }), syncReminderBlocks({ fetchImpl: outlook.fetch }), syncReminderBlocks({ reminderIds: [reminder.id], fetchImpl: outlook.fetch })]);
    assert.equal(outlook.created, 1);
    assert.equal((await admin().query("select 1 from crm.calendar_events where reminder_id = $1", [reminder.id])).rowCount, 1);
  });

  it("keeps trying to remove an event Outlook refused to delete", async () => {
    await connect(mark);
    const reminder = await blocked(mark, "Boiler service");
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    await deleteReminder(mark, reminder.id);
    outlook.failDeleteWith = 503;
    const refused = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(refused.deferred, 1);
    assert.equal((await queued(reminder.id))?.event_ref, "block-1");
    outlook.failDeleteWith = null;
    await readyNow(reminder.id);
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
    assert.equal(await queued(reminder.id), null);
  });
});

describe("whose reminder an event can point at", () => {
  it("never lets anyone link an event to another person's reminder, owners and admins included", async () => {
    const jane = await createUser(`jane${seq}@reminder-blocks.test`, "Jane");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [mark.workspaceId, jane.userId]);
    const janes = await blocked(jane, "Jane's dentist");
    const marks = await blocked(mark, "Mark's dentist");
    const calendar = async (actor: UserActor) => {
      await saveMailbox(actor, { email: actor.email, refreshToken: "refresh-token", accessToken: "access-token", expiresAt: new Date(Date.now() + HOUR).toISOString() });
      const connection = await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [actor.userId]);
      const created = await admin().query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
         values ($1, $2, $3, 'cal-main', 'Calendar', '#4f9be8', true, true, false, true) returning id`,
        [actor.workspaceId, actor.userId, connection.rows[0].id],
      );
      return created.rows[0].id;
    };
    const insert = (actor: UserActor, calendarId: string, reminderId: string) =>
      queryAsUser(
        actor.userId,
        `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, reminder_id)
         select $1, $2, c.connection_id, $3, $4, 'Block', now(), now() + interval '30 minutes', $5::uuid from crm.calendars c where c.id = $2 returning id`,
        [actor.workspaceId, calendarId, actor.userId, `p-${reminderId}`, reminderId],
      );
    const marksCalendar = await calendar(mark);
    const janesCalendar = await calendar(jane);
    await assert.rejects(insert(jane, janesCalendar, marks.id), /row-level security|own reminder/);
    await assert.rejects(insert(mark, marksCalendar, janes.id), /row-level security|own reminder/);
    assert.equal((await insert(mark, marksCalendar, marks.id)).length, 1);
    const own = await admin().query<{ id: string }>(
      `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at)
       select $1, $2, c.connection_id, $3, 'plain', 'Plain', now(), now() + interval '30 minutes' from crm.calendars c where c.id = $2 returning id`,
      [mark.workspaceId, marksCalendar, mark.userId],
    );
    await assert.rejects(queryAsUser(mark.userId, "update crm.calendar_events set reminder_id = $2 where id = $1", [own.rows[0].id, janes.id]), /own reminder/);
    await assert.rejects(
      admin().query(
        `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, reminder_id)
         select $1, $2, c.connection_id, $3, 'definer', 'Block', now(), now() + interval '30 minutes', $4::uuid from crm.calendars c where c.id = $2`,
        [mark.workspaceId, marksCalendar, mark.userId, janes.id],
      ),
      /own reminder/,
      "even a definer can only link an event to its owner's reminder",
    );
  });

  it("writes only to the reminder owner's Outlook", async () => {
    const jane = await createUser(`jane${seq}@reminder-blocks.test`, "Jane");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, jane.userId]);
    await connect(mark);
    const janes = await blocked(jane, "Jane's dentist");
    await syncReminderBlocks({ userId: mark.userId, fetchImpl: outlook.fetch });
    assert.ok(await queued(janes.id), "Mark's sync leaves Jane's reminder alone");
    const run = await syncReminderBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.orbit_only, 1);
    assert.equal(outlook.events.size, 0);
  });
});

describe("other readers skip a reminder's event", () => {
  it("keeps it out of Calendar, meeting alerts, Plan, busy times and the meeting tools", async () => {
    await connect(mark);
    await admin().query("insert into crm.booking_pages (workspace_id, user_id, slug, enabled) values ($1, $2, $3, true)", [mark.workspaceId, mark.userId, `reminders-${seq}`]);
    const soon = new Date(Date.now() + 5 * MINUTE);
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(soon);
    const reminder = (await createReminder(mark, { title: "Boiler service", dueAt: `${dayKeyAt(soon)}T${clock}`, blocksTime: true, durationMinutes: 30 })).reminder;
    await syncReminderBlocks({ fetchImpl: outlook.fetch });
    const event = (await mirror(reminder.id))!;
    assert.ok(event);
    const items = await listCalendarItems(mark, { start: new Date(Date.now() - DAY), end: new Date(Date.now() + DAY) });
    assert.equal(items.some((item) => item.id === event.id), false);
    await savePushSubscription(mark, { endpoint: `https://web.push.apple.com/r${seq}`, keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    const sent: string[] = [];
    const send: PushSender = async (_subscription, payload) => {
      sent.push(String(JSON.parse(payload).title));
    };
    await calendarAlerts(mark, { send });
    assert.deepEqual(sent, []);
    const context = await readPlanContext(mark, Date.now(), { store: false });
    assert.equal(context.meetings.some((meeting) => Date.parse(meeting.startsAt) === new Date(event.starts_at).getTime()), false);
    assert.equal(context.reminders.filter((item) => item.title === "Boiler service").length, 1);
    const busy = await admin().query<{ starts_at: Date }>("select * from private.booking_busy($1, now() - interval '1 hour', now() + interval '1 day')", [mark.userId]);
    assert.equal(busy.rowCount, 1, "booking counts the reminder once");
    assert.deepEqual(await busyFor(mark, mark.userId, new Date(Date.now() - HOUR), 1), []);
    await assert.rejects(cancelInvite(mark, event.id, null, { fetchImpl: outlook.fetch }), (error: unknown) => error instanceof CrmError && error.message === REMINDER_BLOCK_EVENT);
    await admin().query("update crm.calendar_events set reminder_id = null where id = $1", [event.id]);
    await calendarAlerts(mark, { send });
    assert.equal(sent.length, 1, "the same event without a reminder alerts");
  });
});
