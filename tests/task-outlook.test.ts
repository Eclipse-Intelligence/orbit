import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { calendarAlerts } from "@/lib/calendar-alerts";
import { isPersonalEvent, storeGrantedScopes, syncCalendar } from "@/lib/crm/calendar";
import { listCalendarGroups, listCalendarItems } from "@/lib/crm/calendars";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import { cancelInvite, rescheduleInvite, TASK_BLOCK_EVENT } from "@/lib/crm/invites";
import { readPlanContext } from "@/lib/crm/plan-schedule";
import { collectSpreadInDb } from "@/lib/crm/schedule-preferences";
import { busyFor } from "@/lib/crm/task-due";
import {
  blockTransactionId,
  CALENDAR_SYNC,
  outlookMinutes,
  noteTaskBlocksWrite,
  planBlock,
  queueOwnTaskBlocks,
  syncTaskBlocks,
  taskBlocksReach,
  type BlockRow,
} from "@/lib/crm/task-outlook";
import { archiveTask, completeTask, createTask, getTask, OWNER_SETS_LENGTH, placeTask, reopenTask, updateTask } from "@/lib/crm/tasks";
import { undoAuditEvent } from "@/lib/crm/undo";
import type { UserActor } from "@/lib/crm/types";
import { applyMigrationSql, migrationBatches } from "@/lib/db/migration-sql";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { refreshTimes, offerTimes } from "@/lib/mail/scheduling";
import { TASK_BLOCK_NOTE, taskBlockDraft, taskBlockPatch, type GraphEvent } from "@/lib/microsoft/calendar";
import { dropZoneNote } from "@/lib/task-blocks";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

const WRITE_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read offline_access";
const READ_SCOPES = "https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Mail.Read offline_access";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Call = { url: string; method: string; body: Record<string, unknown> | null };
type Stored = { subject: string; start: string; end: string; transactionId?: string };

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
  failPatchWith: number | null = null;
  failCreateWith: number | null = null;
  failDeleteWith: number | null = null;
  hidden = new Set<string>();
  nextLink: string | null = null;
  scope = WRITE_SCOPES;

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
      return json({ access_token: "fresh-token", refresh_token: "refresh-token", expires_in: 3600, scope: this.scope });
    }
    if (parsed.hostname !== "graph.microsoft.com") throw new Error(`Unexpected host ${parsed.hostname}`);
    if (method === "POST" && parsed.pathname === "/v1.0/me/events") {
      if (this.failCreate > 0) {
        this.failCreate -= 1;
        return json({ error: { code: "ServiceUnavailable", message: "Busy" } }, 503);
      }
      if (this.failCreateWith) return json({ error: { code: "Nope", message: "Nope" } }, this.failCreateWith);
      const existing = [...this.events.entries()].find(([, event]) => event.transactionId && event.transactionId === body?.transactionId);
      if (existing) return json(this.graphEvent(existing[0]), 201);
      this.created += 1;
      const id = `block-${this.created}`;
      this.events.set(id, { subject: String(body!.subject), start: fromGraph(body!.start), end: fromGraph(body!.end), transactionId: String(body!.transactionId) });
      return json(this.graphEvent(id), 201);
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
      return json({ value: inside.map(([id]) => this.graphEvent(id)), ...(this.nextLink ? { "@odata.nextLink": this.nextLink } : {}) });
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
      organizer: { emailAddress: { name: "Mark", address: "mark@outlook-blocks.test" } },
      attendees: [],
    };
  }

  graphCalls() {
    return this.calls.filter((call) => new URL(call.url).hostname === "graph.microsoft.com" && call.method !== "GET");
  }

  reset() {
    this.calls = [];
  }
}

const admin = () => getAdminPool();

async function connect(actor: UserActor, scopes: string | null = WRITE_SCOPES) {
  await saveMailbox(actor, {
    email: "mark@outlook-blocks.test",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const connection = await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [actor.userId]);
  const id = connection.rows[0].id;
  if (scopes) await withActor(actor, (db) => storeGrantedScopes(db, actor, id, scopes));
  await admin().query(
    `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
     values ($1, $2, $3, 'cal-main', 'Calendar', '#4f9be8', true, true, true, true)`,
    [actor.workspaceId, actor.userId, id],
  );
  return id;
}

function minuteAt(at: number) {
  return new Date(Math.floor(at / MINUTE) * MINUTE).toISOString();
}

async function timed(actor: UserActor, title: string, at: number, durationMinutes = 30, extra: Record<string, unknown> = {}) {
  const created = await createTask(actor, { title, dueAt: minuteAt(at), durationMinutes, ...extra }, { provenance: { operation: "create_task", source: "mcp" } });
  return created.body.task;
}

async function queued(taskId: string) {
  const row = await admin().query<{ pending_at: Date; claimed_at: Date | null }>("select pending_at, claimed_at from crm.task_outlook_queue where task_id = $1", [taskId]);
  return row.rows[0] ?? null;
}

async function blockRow(taskId: string) {
  const row = await admin().query<{ id: string; provider_event_id: string; starts_at: Date; ends_at: Date; subject: string; contact_ids: string[]; workspace_id: string; user_id: string }>(
    "select id, provider_event_id, starts_at, ends_at, subject, contact_ids, workspace_id, user_id from crm.calendar_events where task_id = $1",
    [taskId],
  );
  return row.rows[0] ?? null;
}

async function ref(taskId: string) {
  const row = await admin().query<{ calendar_event_ref: string | null }>("select calendar_event_ref from crm.tasks where id = $1", [taskId]);
  return row.rows[0]?.calendar_event_ref ?? null;
}

async function addMember(workspaceId: string, userId: string, role = "member") {
  await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, userId, role]);
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
  await getAdminPool().query("delete from crm.task_outlook_queue");
  seq += 1;
  mark = await createUser(`mark${seq}@outlook-blocks.test`, "Mark Ridgeon");
  outlook = new FakeOutlook();
});

function row(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    task_id: "00000000-0000-4000-8000-000000000001",
    workspace_id: "00000000-0000-4000-8000-000000000002",
    title: "Call Jane",
    due_at: "2026-11-20T10:00:00.000Z",
    due_has_time: true,
    duration_minutes: 30,
    owner_id: "00000000-0000-4000-8000-000000000003",
    completed_at: null,
    archived_at: null,
    calendar_event_ref: null,
    pending_at: "2026-11-13 09:00:00.123456+00",
    attempts: 0,
    create_key: null,
    create_user_id: null,
    create_sent_at: null,
    event_id: null,
    event_user_id: null,
    provider_event_id: null,
    event_starts_at: null,
    event_ends_at: null,
    event_subject: null,
    event_workspace_id: null,
    block_starts_at: null,
    block_ends_at: null,
    ...overrides,
  };
}

describe("the migration", () => {
  it("runs again over itself", async () => {
    const sql = readFileSync("supabase/migrations/20270124100000_task_blocks_outlook.sql", "utf8");
    await applyMigrationSql(getAdminPool(), sql);
    await applyMigrationSql(getAdminPool(), sql);
    assert.deepEqual(migrationBatches("set x = 1;\ncreate index concurrently if not exists a on b (c);\nselect 1;"), [
      "set x = 1;",
      "create index concurrently if not exists a on b (c);",
      "select 1;",
    ]);
  });
});

describe("task block event shape", () => {
  it("is Busy, Private, with no reminder, no guests and a From Orbit link", () => {
    const draft = taskBlockDraft({
      title: "Call Jane",
      start: new Date("2026-11-20T10:00:00.000Z"),
      end: new Date("2026-11-20T10:30:00.000Z"),
      timeZone: "Europe/London",
      link: "https://orbit.example/open?workspace=w&to=%2Ftasks%3Ftask%3Dt",
      transactionId: "tx",
      key: "key",
    });
    assert.equal(draft.subject, "Call Jane");
    assert.equal(draft.showAs, "busy");
    assert.equal(draft.sensitivity, "private");
    assert.equal(draft.isReminderOn, false);
    assert.deepEqual(draft.attendees, []);
    assert.equal(draft.responseRequested, false);
    assert.equal("contact_ids" in draft, false);
    assert.match(draft.body.content, new RegExp(`^<p>${TASK_BLOCK_NOTE} <a href="https://orbit.example/open\\?workspace=w&amp;to=%2Ftasks%3Ftask%3Dt">Open the task</a></p>$`));
    assert.deepEqual(draft.start, { dateTime: "2026-11-20T10:00:00", timeZone: "GMT Standard Time" });
    const patch = taskBlockPatch({ title: "Call Jane", start: new Date("2026-11-20T10:00:00.000Z"), end: new Date("2026-11-20T11:00:00.000Z"), timeZone: "Europe/London", link: null });
    assert.equal(patch.body.content, `<p>${TASK_BLOCK_NOTE}</p>`);
    assert.equal(patch.sensitivity, "private");
    assert.equal(patch.isReminderOn, false);
    assert.deepEqual(patch.end, { dateTime: "2026-11-20T11:00:00", timeZone: "GMT Standard Time" });
  });

  it("keeps one transaction id per pending change", () => {
    const first = blockTransactionId("t1", "2026-11-13 09:00:00.123456+00");
    assert.equal(first, blockTransactionId("t1", "2026-11-13 09:00:00.123456+00"));
    assert.notEqual(first, blockTransactionId("t1", "2026-11-13 09:00:00.123457+00"));
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("says the event goes from Outlook only when the block is there", () => {
    assert.equal(dropZoneNote("Fri 13 Nov", true), "Stays on Fri 13 Nov, off the calendar and out of Outlook.");
    assert.equal(dropZoneNote("Fri 13 Nov", false), "Stays on Fri 13 Nov, off the calendar.");
  });

  it("reads Outlook durations inside the task limits", () => {
    assert.equal(outlookMinutes("2026-11-20T10:00:00Z", "2026-11-20T10:45:00Z"), 45);
    assert.equal(outlookMinutes("2026-11-20T10:00:00Z", "2026-11-20T10:01:00Z"), 5);
    assert.equal(outlookMinutes("2026-11-20T10:00:00Z", "2026-11-20T22:00:00Z"), 480);
  });
});

describe("planBlock", () => {
  const now = Date.parse("2026-11-20T09:00:00.000Z");
  const owner = "00000000-0000-4000-8000-000000000003";
  const existing = { calendar_event_ref: "evt", event_id: "e", event_user_id: owner, provider_event_id: "evt" };

  it("creates a block for an owned timed task that hasn't ended", () => {
    assert.deepEqual(planBlock(row(), now), { kind: "write", userId: owner, start: new Date("2026-11-20T10:00:00.000Z"), end: new Date("2026-11-20T10:30:00.000Z"), create: true });
    assert.deepEqual(planBlock(row({ due_at: "2026-11-19T10:00:00.000Z" }), now), { kind: "settle" });
  });

  it("never writes date-only, unowned or archived tasks", () => {
    assert.deepEqual(planBlock(row({ due_has_time: false }), now), { kind: "settle" });
    assert.deepEqual(planBlock(row({ owner_id: null }), now), { kind: "settle" });
    assert.deepEqual(planBlock(row({ due_has_time: false, ...existing }), now), { kind: "remove", userId: owner, requeue: false });
    assert.deepEqual(planBlock(row({ archived_at: "2026-11-20T08:00:00Z", ...existing }), now), { kind: "remove", userId: owner, requeue: false });
  });

  it("removes, shortens or leaves the event when the task is done", () => {
    assert.deepEqual(planBlock(row({ completed_at: "2026-11-20T09:59:30.000Z", ...existing }), now), { kind: "remove", userId: owner, requeue: false });
    assert.deepEqual(planBlock(row({ completed_at: "2026-11-20T10:12:40.000Z", ...existing }), now), {
      kind: "write",
      userId: owner,
      start: new Date("2026-11-20T10:00:00.000Z"),
      end: new Date("2026-11-20T10:12:00.000Z"),
      create: false,
    });
    assert.deepEqual(planBlock(row({ completed_at: "2026-11-20T10:30:00.000Z", ...existing }), now), { kind: "settle" });
    assert.deepEqual(planBlock(row({ completed_at: "2026-11-20T09:00:00.000Z" }), now), { kind: "settle" });
  });

  it("moves an existing event by its stored id, even when it is long overdue", () => {
    const plan = planBlock(row({ due_at: "2026-08-01T10:00:00.000Z", ...existing }), now);
    assert.equal(plan.kind, "write");
    assert.equal(plan.kind === "write" && plan.create, false);
  });

  it("takes the event out of someone else's Outlook before anything else", () => {
    const colleague = "00000000-0000-4000-8000-000000000009";
    assert.deepEqual(planBlock(row({ ...existing, event_user_id: colleague }), now), { kind: "remove", userId: colleague, requeue: true });
    assert.deepEqual(planBlock(row({ ...existing, owner_id: null }), now), { kind: "remove", userId: owner, requeue: true });
    assert.deepEqual(planBlock(row({ calendar_event_ref: "evt", owner_id: null }), now), { kind: "forget" });
  });
});

describe("Outlook lifecycle", () => {
  it("creates one Busy, Private event for a timed task and links it", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    assert.ok(await queued(task.id));
    const run = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(run.created, 1);
    const [post] = outlook.graphCalls();
    assert.equal(post.method, "POST");
    assert.equal(new URL(post.url).pathname, "/v1.0/me/events");
    assert.equal(post.body!.sensitivity, "private");
    assert.equal(post.body!.showAs, "busy");
    assert.equal(post.body!.isReminderOn, false);
    assert.deepEqual(post.body!.attendees, []);
    assert.equal(post.body!.subject, "Call Jane");
    assert.match(String((post.body!.body as { content: string }).content), new RegExp(`${task.id}`));
    const event = await blockRow(task.id);
    assert.equal(event?.provider_event_id, "block-1");
    assert.deepEqual(event?.contact_ids, []);
    assert.equal(new Date(event!.starts_at).toISOString(), task.dueAt);
    assert.equal(await ref(task.id), "block-1");
    assert.equal(await queued(task.id), null);
    assert.equal((await getTask(mark, task.id)).inOutlook, true);

    outlook.reset();
    const again = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(again.created + again.updated, 0);
    assert.equal(outlook.graphCalls().length, 0);
  });

  it("moves and resizes the event by its stored id, never creating a second one", async () => {
    await connect(mark);
    const task = await timed(mark, "Email Oliver", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    outlook.reset();
    const later = minuteAt(Date.now() + 3 * DAY);
    await placeTask(mark, task.id, { at: later, durationMinutes: 45 });
    const run = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(run.updated, 1);
    const calls = outlook.graphCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PATCH");
    assert.match(calls[0].url, /\/me\/events\/block-1$/);
    assert.equal(outlook.events.get("block-1")!.start, later);
    assert.equal(outlook.events.get("block-1")!.end, new Date(Date.parse(later) + 45 * MINUTE).toISOString());
    const event = await blockRow(task.id);
    assert.equal(new Date(event!.starts_at).toISOString(), later);

    outlook.reset();
    await updateTask(mark, task.id, { title: "Email Oliver the order form" });
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.get("block-1")!.subject, "Email Oliver the order form");
    assert.equal(outlook.created, 1);
  });

  it("recreates the event when Outlook lost it during a move", async () => {
    await connect(mark);
    const task = await timed(mark, "Price Q1", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    outlook.events.clear();
    await placeTask(mark, task.id, { at: minuteAt(Date.now() + 4 * DAY), durationMinutes: 30 });
    const run = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(run.created, 1);
    assert.equal(await ref(task.id), "block-2");
    assert.equal((await blockRow(task.id))?.provider_event_id, "block-2");
  });

  it("removes the event when done before the block starts, and Reopen brings it back", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Halden", Date.now() + DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    outlook.reset();
    await completeTask(mark, task.id, { provenance: { operation: "complete_task", source: "web" } });
    const done = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(done.removed, 1);
    assert.equal(outlook.graphCalls()[0].method, "DELETE");
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(task.id), null);
    assert.equal(await blockRow(task.id), null);

    outlook.reset();
    await reopenTask(mark, task.id);
    const reopened = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(reopened.created, 1);
    assert.equal(outlook.events.size, 1);
    assert.equal(await ref(task.id), "block-2");
  });

  it("shortens the event to the completion time when done during the block", async () => {
    await connect(mark);
    const start = Math.floor((Date.now() - 10 * MINUTE) / MINUTE) * MINUTE;
    const task = await timed(mark, "Write the proposal", start, 60);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    outlook.reset();
    await completeTask(mark, task.id);
    const completedAt = Date.parse((await getTask(mark, task.id)).completedAt!);
    const run = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(run.updated, 1);
    const event = outlook.events.get("block-1")!;
    assert.equal(event.start, new Date(start).toISOString());
    assert.equal(event.end, new Date(Math.floor(completedAt / MINUTE) * MINUTE).toISOString());
    assert.equal(await ref(task.id), "block-1");
  });

  it("leaves the event alone when done after the block ended", async () => {
    await connect(mark);
    const task = await timed(mark, "Board prep", Date.now() + DAY, 30);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.tasks set due_at = $2 where id = $1", [task.id, minuteAt(Date.now() - 3 * HOUR)]);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    outlook.reset();
    await completeTask(mark, task.id);
    const run = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(run.unchanged, 1);
    assert.equal(outlook.graphCalls().length, 0);
    assert.equal(outlook.events.size, 1);
  });

  it("removes the event when the task becomes date only or is deleted", async () => {
    await connect(mark);
    const dated = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    const archived = await timed(mark, "Call Sam", Date.now() + 2 * DAY + HOUR);
    await syncTaskBlocks({ taskIds: [dated.id, archived.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 2);
    await placeTask(mark, dated.id, { dateOnly: true });
    await archiveTask(mark, archived.id);
    const run = await syncTaskBlocks({ taskIds: [dated.id, archived.id], fetchImpl: outlook.fetch });
    assert.equal(run.removed, 2);
    assert.equal(outlook.events.size, 0);
    assert.equal((await getTask(mark, dated.id)).inOutlook, false);
  });

  it("makes a timed task date only and removes the event when it is handed to a colleague", async () => {
    await connect(mark);
    const priya = await createUser(`priya${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, priya.userId);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY, 30, { remindMinutes: 10 });
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    const handed = await updateTask(mark, task.id, { ownerId: priya.userId });
    assert.equal(handed.body.task.dueHasTime, false);
    assert.equal(handed.body.task.dueDate, task.dueDate);
    assert.equal(handed.body.task.remindMinutes, null);
    assert.equal(handed.body.task.scheduledBy, null);
    const run = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(run.removed, 1);
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(task.id), null);
    const audit = await admin().query<{ changes: { after: { dueHasTime: boolean } } }>(
      "select changes from crm.audit_events where entity_id = $1 and event_type = 'task.updated' order by created_at desc limit 1",
      [task.id],
    );
    assert.equal(audit.rows[0].changes.after.dueHasTime, false);

    const forPriya = await timed(mark, "Call Oliver", Date.now() + 2 * DAY, 30, { ownerId: priya.userId });
    assert.equal(forPriya.dueHasTime, false);
    assert.equal(await queued(forPriya.id), null);

    const mine = await timed(mark, "Call Ben", Date.now() + 2 * DAY);
    await updateTask(priya, mine.id, { ownerId: priya.userId }).catch(() => null);
    const taken = await updateTask(mark, mine.id, { ownerId: mark.userId });
    assert.equal(taken.body.task.dueHasTime, true);
  });

  it("is idempotent and retry safe", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    outlook.failCreate = 2;
    const failed = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(failed.deferred, 1);
    assert.equal(outlook.events.size, 0);
    const waiting = await admin().query<{ attempts: number; retry_at: Date; claimed_at: Date | null }>(
      "select attempts, retry_at, claimed_at from crm.task_outlook_queue where task_id = $1",
      [task.id],
    );
    assert.equal(waiting.rows[0].attempts, 1);
    assert.equal(waiting.rows[0].claimed_at, null);
    assert.ok(waiting.rows[0].retry_at.getTime() > Date.now());
    const firstTx = outlook.calls.find((call) => call.method === "POST" && call.body?.transactionId)!.body!.transactionId;

    const backedOff = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(backedOff.created + backedOff.deferred, 0);

    await admin().query("update crm.task_outlook_queue set retry_at = now() - interval '1 second' where task_id = $1", [task.id]);
    outlook.reset();
    const [one, two] = await Promise.all([
      syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch }),
      syncTaskBlocks({ fetchImpl: outlook.fetch }),
    ]);
    assert.equal(one.created + two.created, 1);
    assert.equal(outlook.events.size, 1);
    const posts = outlook.calls.filter((call) => call.method === "POST" && new URL(call.url).hostname === "graph.microsoft.com");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body!.transactionId, firstTx);
    assert.equal(await queued(task.id), null);
  });

  it("only writes a time the owner set, and agents never set one on an owned task", async () => {
    await connect(mark);
    const setter = await createUser(`setter${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, setter.userId, "admin");
    const priya: UserActor = { ...setter, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "admin" };
    const hers = (await createTask(priya, { title: "Priya's call", dueDate: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10) })).body.task;
    const set = await updateTask(mark, hers.id, { dueAt: minuteAt(Date.now() + 2 * DAY) });
    assert.equal(set.body.task.dueHasTime, false);
    const reassigned = await timed(mark, "Call Ben", Date.now() + 2 * DAY);
    const handed = await updateTask(mark, reassigned.id, { ownerId: priya.userId, dueAt: minuteAt(Date.now() + 3 * DAY) });
    assert.equal(handed.body.task.dueHasTime, false);
    const own = await updateTask(priya, hers.id, { dueAt: minuteAt(Date.now() + 2 * DAY) });
    assert.equal(own.body.task.dueHasTime, true);
    const agent = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"]);
    const owned = (await createTask(agent.actor, { title: "Agent call", dueAt: minuteAt(Date.now() + 2 * DAY), ownerId: mark.userId })).body.task;
    assert.equal(owned.dueHasTime, false);
    const unowned = (await createTask(agent.actor, { title: "Agent loose call", dueAt: minuteAt(Date.now() + 2 * DAY) })).body.task;
    assert.equal(unowned.dueHasTime, true);
    assert.equal(unowned.ownerId, null);
    const later = await updateTask(agent.actor, own.body.task.id, { dueAt: minuteAt(Date.now() + 4 * DAY) });
    assert.equal(later.body.task.dueHasTime, false);
  });

  it("never hands a colleague a time through undoing an owner change", async () => {
    const colleague = await createUser(`undo${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, colleague.userId);
    const priya: UserActor = { ...colleague, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "member" };
    const day = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
    const lastEvent = async (taskId: string, field: string) =>
      (
        await admin().query<{ id: string }>(
          "select id from crm.audit_events where entity_id = $1 and changes -> 'fields' ? $2 order by created_at desc limit 1",
          [taskId, field],
        )
      ).rows[0].id;

    const taken = (await createTask(priya, { title: "Priya's call", dueDate: day })).body.task;
    await updateTask(mark, taken.id, { ownerId: mark.userId });
    await updateTask(mark, taken.id, { dueAt: `${day}T14:00` });
    await undoAuditEvent(mark, await lastEvent(taken.id, "ownerId"), { operation: "undo", source: "web" });
    const back = await getTask(mark, taken.id);
    assert.equal(back.ownerId, priya.userId);
    assert.equal(back.dueHasTime, false);
    assert.equal(back.dueDate, day);

    const loose = (await createTask(priya, { title: "Priya's email", dueDate: day })).body.task;
    await updateTask(mark, loose.id, { ownerId: null });
    await updateTask(mark, loose.id, { dueAt: `${day}T15:00` });
    assert.equal((await getTask(mark, loose.id)).dueHasTime, true);
    await undoAuditEvent(mark, await lastEvent(loose.id, "ownerId"), { operation: "undo", source: "web" });
    const restored = await getTask(mark, loose.id);
    assert.equal(restored.ownerId, priya.userId);
    assert.equal(restored.dueHasTime, false);

    const mine = await timed(mark, "Call Ben", Date.now() + 2 * DAY);
    await updateTask(mark, mine.id, { ownerId: priya.userId });
    await undoAuditEvent(mark, await lastEvent(mine.id, "ownerId"), { operation: "undo", source: "web" });
    const handedBack = await getTask(mark, mine.id);
    assert.equal(handedBack.ownerId, mark.userId);
    assert.equal(handedBack.dueHasTime, true);
    assert.equal(handedBack.dueAt, mine.dueAt);
  });

  it("never hands a colleague a time by undoing an older time change after a hand-over", async () => {
    await connect(mark);
    const colleague = await createUser(`older${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, colleague.userId);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await placeTask(mark, task.id, { dateOnly: true });
    const dateOnlyEvent = (
      await admin().query<{ id: string }>(
        "select id from crm.audit_events where entity_id = $1 and changes -> 'fields' ? 'dueHasTime' order by created_at desc limit 1",
        [task.id],
      )
    ).rows[0].id;
    await updateTask(mark, task.id, { ownerId: colleague.userId });
    await undoAuditEvent(mark, dateOnlyEvent, { operation: "undo", source: "web" });
    const after = await getTask(mark, task.id);
    assert.equal(after.ownerId, colleague.userId);
    assert.equal(after.dueHasTime, false);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
  });

  it("takes a removed member's block out of their Outlook through their other workspace", async () => {
    const colleague = await createUser(`gone${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, colleague.userId);
    await connect(colleague);
    const priya: UserActor = { ...colleague, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "member" };
    const hers = (await createTask(priya, { title: "Priya's call", dueAt: minuteAt(Date.now() + 2 * DAY) })).body.task;
    await syncTaskBlocks({ taskIds: [hers.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 1);
    await getPool().query("select private.team_remove($1, $2, $3)", [mark.workspaceId, mark.userId, colleague.userId]);
    outlook.reset();
    await syncTaskBlocks({ taskIds: [hers.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.graphCalls()[0]?.method, "DELETE");
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(hers.id), null);
  });

  it("keeps retrying a create that failed many times, every six hours, rather than parking it", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await admin().query("update crm.task_outlook_queue set attempts = 12 where task_id = $1", [task.id]);
    outlook.failCreate = 2;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    const row = await admin().query<{ refused: boolean; attempts: number; retry_at: Date }>(
      "select refused, attempts, retry_at from crm.task_outlook_queue where task_id = $1",
      [task.id],
    );
    assert.equal(row.rows[0].refused, false);
    assert.equal(row.rows[0].attempts, 13);
    const wait = row.rows[0].retry_at.getTime() - Date.now();
    assert.ok(wait > 5.9 * HOUR && wait <= 6 * HOUR, String(wait));
  });

  it("only lets the owner change the length of a timed task", async () => {
    const colleague = await createUser(`length${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, colleague.userId);
    const priya: UserActor = { ...colleague, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "member" };
    const hers = (await createTask(priya, { title: "Priya's call", dueAt: minuteAt(Date.now() + 2 * DAY) })).body.task;
    assert.equal(hers.dueHasTime, true);
    const refused = (error: unknown) => error instanceof CrmError && error.message === OWNER_SETS_LENGTH;
    await assert.rejects(updateTask(mark, hers.id, { durationMinutes: 45 }), refused);
    await assert.rejects(placeTask(mark, hers.id, { at: hers.dueAt!, durationMinutes: 45 }), refused);
    const agent = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"]);
    await assert.rejects(updateTask(agent.actor, hers.id, { durationMinutes: 60 }), refused);
    assert.equal((await updateTask(priya, hers.id, { durationMinutes: 45 })).body.task.durationMinutes, 45);
    const dated = (await createTask(priya, { title: "Priya's day", dueDate: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10) })).body.task;
    assert.equal((await updateTask(mark, dated.id, { durationMinutes: 30 })).body.task.durationMinutes, 30);
  });

  it("hands a removed member's timed tasks to the remover date only", async () => {
    const colleague = await createUser(`removed${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, colleague.userId);
    const priya: UserActor = { ...colleague, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "member" };
    const hers = (await createTask(priya, { title: "Priya's call", dueAt: minuteAt(Date.now() + 2 * DAY), remindMinutes: 10 })).body.task;
    await getPool().query("select private.team_remove($1, $2, $3)", [mark.workspaceId, mark.userId, priya.userId]);
    const moved = await getTask(mark, hers.id);
    assert.equal(moved.ownerId, mark.userId);
    assert.equal(moved.dueHasTime, false);
    assert.equal(moved.dueDate, hers.dueDate);
    assert.equal(moved.remindMinutes, null);
    assert.equal(moved.scheduledBy, null);
  });

  it("never parks or backs off a newer change because an older attempt failed", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    const claimed = await getPool().query<{ pending_at: string }>("select pending_at from private.claim_task_blocks($1::uuid[], null, 5)", [[task.id]]);
    await updateTask(mark, task.id, { title: "Call Jane again" });
    await getPool().query("select private.defer_task_block($1, $2, true)", [task.id, claimed.rows[0].pending_at]);
    const row = await admin().query<{ refused: boolean; attempts: number; retry_at: Date | null; claimed_at: Date | null }>(
      "select refused, attempts, retry_at, claimed_at from crm.task_outlook_queue where task_id = $1",
      [task.id],
    );
    assert.deepEqual(row.rows[0], { refused: false, attempts: 0, retry_at: null, claimed_at: null });
  });

  it("backs off on a 403 create, and lets parked creates go again when write access is newly confirmed", async () => {
    const connection = await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    outlook.failCreateWith = 403;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    let row = await admin().query<{ refused: boolean; attempts: number }>("select refused, attempts from crm.task_outlook_queue where task_id = $1", [task.id]);
    assert.deepEqual(row.rows[0], { refused: false, attempts: 1 });
    await queueOwnTaskBlocks(mark.userId);
    row = await admin().query("select refused, attempts from crm.task_outlook_queue where task_id = $1", [task.id]);
    assert.deepEqual(row.rows[0], { refused: false, attempts: 1 });

    await admin().query("update crm.task_outlook_queue set retry_at = null where task_id = $1", [task.id]);
    outlook.failCreateWith = 400;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    row = await admin().query("select refused, attempts from crm.task_outlook_queue where task_id = $1", [task.id]);
    assert.equal(row.rows[0].refused, true);
    outlook.failCreateWith = null;
    assert.equal(await noteTaskBlocksWrite(connection, true), true);
    assert.equal(await noteTaskBlocksWrite(connection, true), false);
    await noteTaskBlocksWrite(connection, false);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal(await ref(task.id), "block-1");
  });

  it("keeps a mailbox's back-off across syncs while access stays the same", async () => {
    const connection = await connect(mark);
    await noteTaskBlocksWrite(connection, true);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    outlook.failCreate = 2;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    const before = await admin().query<{ retry_at: Date; attempts: number }>("select retry_at, attempts from crm.task_outlook_queue where task_id = $1", [task.id]);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    const after = await admin().query<{ retry_at: Date; attempts: number }>("select retry_at, attempts from crm.task_outlook_queue where task_id = $1", [task.id]);
    assert.deepEqual(after.rows[0], before.rows[0]);
    assert.equal(await ref(task.id), null);
  });

  it("keeps a move made while Outlook refuses it, so the next sync doesn't revert it", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where task_id = $1", [task.id]);
    const moved = minuteAt(Date.now() + 3 * DAY);
    await placeTask(mark, task.id, { at: moved, durationMinutes: 30 });
    outlook.failPatchWith = 403;
    const refused = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(refused.deferred, 1);
    assert.ok(await queued(task.id));
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getTask(mark, task.id)).dueAt, moved);
    outlook.failPatchWith = null;
    await admin().query("update crm.task_outlook_queue set retry_at = null where task_id = $1", [task.id]);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.get("block-1")!.start, moved);
    assert.equal(await queued(task.id), null);
  });

  it("keeps trying to remove an event Outlook refused to delete, and booking doesn't count it meanwhile", async () => {
    await connect(mark);
    await admin().query("insert into crm.booking_pages (workspace_id, user_id, slug, enabled) values ($1, $2, $3, true)", [mark.workspaceId, mark.userId, `refused-${seq}`]);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await placeTask(mark, task.id, { dateOnly: true });
    outlook.failDeleteWith = 403;
    const refused = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(refused.deferred, 1);
    assert.ok(await queued(task.id));
    assert.equal(outlook.events.size, 1);
    const busy = await admin().query("select * from private.booking_busy($1, now(), now() + interval '10 days')", [mark.userId]);
    assert.equal(busy.rowCount, 0);
    outlook.failDeleteWith = null;
    await admin().query("update crm.task_outlook_queue set retry_at = null where task_id = $1", [task.id]);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(task.id), null);
  });

  it("requeues blocks that drifted from their task when write access is back", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.tasks set due_at = due_at + interval '1 hour' where id = $1", [task.id]);
    await admin().query("delete from crm.task_outlook_queue where task_id = $1", [task.id]);
    assert.equal(await queueOwnTaskBlocks(mark.userId), 1);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.get("block-1")!.start, (await getTask(mark, task.id)).dueAt);
    assert.equal(await queueOwnTaskBlocks(mark.userId), 0);
  });

  it("keeps the event id even when saving the event row fails, so a retry never duplicates it", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await admin().query(`create or replace function public.refuse_block_rows() returns trigger language plpgsql as $$ begin raise exception 'no rows'; end; $$`);
    await admin().query("create trigger refuse_block_rows before insert on crm.calendar_events for each row when (new.task_id is not null) execute function public.refuse_block_rows()");
    try {
      const failed = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
      assert.equal(failed.deferred, 1);
    } finally {
      await admin().query("drop trigger refuse_block_rows on crm.calendar_events");
    }
    assert.equal(await ref(task.id), "block-1");
    await admin().query("update crm.task_outlook_queue set retry_at = null where task_id = $1", [task.id]);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1);
    assert.equal((await blockRow(task.id))?.provider_event_id, "block-1");
  });

  it("stops a mailbox's batch on throttling and parks refused creates until the task changes", async () => {
    await connect(mark);
    const first = await timed(mark, "Call one", Date.now() + 2 * DAY);
    const second = await timed(mark, "Call two", Date.now() + 2 * DAY + HOUR);
    outlook.failCreateWith = 429;
    const throttled = await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(throttled.throttled, 2);
    assert.equal(outlook.calls.filter((call) => call.method === "POST" && new URL(call.url).hostname === "graph.microsoft.com").length, 1);

    await admin().query("update crm.task_outlook_queue set retry_at = null");
    outlook.failCreateWith = 400;
    outlook.reset();
    await syncTaskBlocks({ taskIds: [first.id], fetchImpl: outlook.fetch });
    const parked = await admin().query<{ refused: boolean; retry_at: Date }>("select refused, retry_at from crm.task_outlook_queue where task_id = $1", [first.id]);
    assert.equal(parked.rows[0].refused, true);
    await queueOwnTaskBlocks(mark.userId);
    outlook.reset();
    await syncTaskBlocks({ taskIds: [first.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.graphCalls().length, 0);
    outlook.failCreateWith = null;
    await updateTask(mark, first.id, { title: "Call one again" });
    await syncTaskBlocks({ taskIds: [first.id, second.id], fetchImpl: outlook.fetch });
    assert.equal(await ref(first.id) !== null, true);
  });

  it("hands a block over when the old owner's Outlook can't be reached", async () => {
    await connect(mark);
    const taker = await createUser(`taker${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, taker.userId, "admin");
    const priya: UserActor = { ...taker, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "admin" };
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.mailbox_connections set status = 'disconnected', refresh_token = null where user_id = $1", [mark.userId]);
    const taken = await updateTask(priya, task.id, { ownerId: priya.userId });
    assert.equal(taken.body.task.dueHasTime, true);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(await ref(task.id), null);
    assert.equal(await blockRow(task.id), null);
    assert.equal(await queued(task.id), null);
  });

  it("points the Outlook link at the task's new workspace when it moves", async () => {
    await connect(mark);
    const ridgeon = await createUser(`moved${seq}@outlook-blocks.test`, "Ridgeon owner");
    await addMember(ridgeon.workspaceId, mark.userId, "admin");
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    outlook.reset();
    await admin().query("update crm.tasks set workspace_id = $2 where id = $1", [task.id, ridgeon.workspaceId]);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    const [patch] = outlook.graphCalls();
    assert.equal(patch.method, "PATCH");
    assert.match(String((patch.body!.body as { content: string }).content), new RegExp(`workspace=${ridgeon.workspaceId}`));
  });

  it("keeps blocks in Orbit only without write access", async () => {
    await connect(mark, READ_SCOPES);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    const run = await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(run.orbit_only, 1);
    assert.equal(outlook.graphCalls().length, 0);
    assert.equal(await queued(task.id), null);
    assert.equal(await ref(task.id), null);
    assert.equal(await withActor(mark, (db) => taskBlocksReach(db, mark)), "orbit");
    await admin().query("update crm.integration_state set granted_scopes = null where user_id = $1", [mark.userId]);
    assert.equal((await listCalendarGroups(mark))[0].taskBlocks, null);
    await admin().query("update crm.integration_state set granted_scopes = $2 where user_id = $1", [mark.userId, READ_SCOPES]);
    const [primary] = await listCalendarGroups(mark);
    assert.equal(primary.taskBlocks, "orbit");

    const loose = await createUser(`loose${seq}@outlook-blocks.test`, "No Mailbox");
    const looseTask = await timed(loose, "Call Sam", Date.now() + 2 * DAY);
    const without = await syncTaskBlocks({ taskIds: [looseTask.id], fetchImpl: outlook.fetch });
    assert.equal(without.orbit_only, 1);
    assert.equal(await withActor(loose, (db) => taskBlocksReach(db, loose)), null);
  });

  it("puts blocks in Outlook once write access arrives", async () => {
    const connection = await connect(mark, READ_SCOPES);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await withActor(mark, (db) => storeGrantedScopes(db, mark, connection, WRITE_SCOPES));
    assert.equal(await withActor(mark, (db) => taskBlocksReach(db, mark)), "outlook");
    assert.equal((await listCalendarGroups(mark))[0].taskBlocks, "outlook");
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal(await ref(task.id), "block-1");
  });

  it("acts in the task's own workspace for a person in two workspaces", async () => {
    await connect(mark);
    const ridgeon = await createUser(`ridgeon${seq}@outlook-blocks.test`, "Ridgeon owner");
    await addMember(ridgeon.workspaceId, mark.userId, "admin");
    const there: UserActor = { ...mark, workspaceId: ridgeon.workspaceId, workspaceName: "Ridgeon", role: "admin" };
    const task = await timed(there, "Call Ridgeon lead", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    const event = await blockRow(task.id);
    assert.equal(event?.user_id, mark.userId);
    const body = String((outlook.graphCalls()[0].body!.body as { content: string }).content);
    assert.match(body, new RegExp(`workspace=${ridgeon.workspaceId}`));
  });
});

describe("reading blocks back from Outlook", () => {
  async function linked(title: string, at: number, duration = 30) {
    await connect(mark);
    const task = await timed(mark, title, at, duration);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where task_id = $1", [task.id]);
    outlook.reset();
    return task;
  }

  it("moves and resizes the task when the block moves in Outlook, as calendar_sync", async () => {
    const task = await linked("Call Jane", Date.now() + 2 * DAY);
    const moved = minuteAt(Date.now() + 3 * DAY);
    outlook.events.set("block-1", { subject: "Call Jane", start: moved, end: new Date(Date.parse(moved) + 50 * MINUTE).toISOString() });
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    const after = await getTask(mark, task.id);
    assert.equal(after.dueAt, moved);
    assert.equal(after.durationMinutes, 50);
    assert.equal(after.scheduledBy, "person");
    assert.equal(after.inOutlook, true);
    assert.equal(outlook.graphCalls().length, 0);
    assert.equal(await queued(task.id), null);
    const audit = await admin().query<{ operation: string; source: string; actor_user_id: string }>(
      "select operation, source, actor_user_id from crm.audit_events where entity_id = $1 order by created_at desc limit 1",
      [task.id],
    );
    assert.deepEqual(audit.rows[0], { operation: CALENDAR_SYNC.operation, source: "microsoft", actor_user_id: mark.userId });
    const spread = await withActor(mark, (db) => collectSpreadInDb(db, mark.userId, [mark.workspaceId], Date.now() + MINUTE, new Date(Date.now() - DAY)));
    assert.equal(spread.call.placed, 0);
  });

  it("claims a block Plan placed for the person when it is resized in Outlook", async () => {
    const task = await linked("Email Oliver", Date.now() + 2 * DAY);
    await admin().query("update crm.tasks set scheduled_by = 'planner' where id = $1", [task.id]);
    const event = outlook.events.get("block-1")!;
    outlook.events.set("block-1", { ...event, end: new Date(Date.parse(event.end) + 15 * MINUTE).toISOString() });
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    const after = await getTask(mark, task.id);
    assert.equal(after.durationMinutes, 45);
    assert.equal(after.scheduledBy, "person");
  });

  it("makes the task date only when its block is deleted in Outlook", async () => {
    const task = await linked("Call Jane", Date.now() + 2 * DAY);
    outlook.events.clear();
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    const after = await getTask(mark, task.id);
    assert.equal(after.dueHasTime, false);
    assert.equal(after.dueDate, task.dueDate);
    assert.equal(after.inOutlook, false);
    assert.equal(await blockRow(task.id), null);
    assert.equal(outlook.graphCalls().length, 0);
  });

  it("counts a missing block as deleted only inside the window, after a full fetch, and once written before it", async () => {
    const far = await linked("Call far", Date.now() + 70 * DAY);
    const fresh = await timed(mark, "Call fresh", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [fresh.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.calendar_events set block_written_at = now() + interval '1 hour' where task_id = $1", [fresh.id]);
    outlook.events.clear();
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getTask(mark, far.id)).dueHasTime, true);
    assert.ok(await blockRow(far.id));
    assert.equal((await getTask(mark, fresh.id)).dueHasTime, true);
    assert.ok(await blockRow(fresh.id));

    const near = await timed(mark, "Call near", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [near.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where task_id = $1", [near.id]);
    outlook.events.clear();
    outlook.nextLink = "https://elsewhere.example/next";
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getTask(mark, near.id)).dueHasTime, true);
    assert.ok(await blockRow(near.id));
  });

  it("never deletes a row that carries a task, in either delete branch", async () => {
    const old = await linked("Call old", Date.now() + 2 * DAY);
    await admin().query("update crm.calendar_events set starts_at = now() - interval '40 days', ends_at = now() - interval '40 days' + interval '30 minutes' where task_id = $1", [old.id]);
    await admin().query("update crm.tasks set due_at = now() - interval '40 days' where id = $1", [old.id]);
    await admin().query("delete from crm.task_outlook_queue where task_id = $1", [old.id]);
    const longAgo = (await getTask(mark, old.id)).dueAt!;
    outlook.events.set("block-1", { subject: "Call old", start: longAgo, end: new Date(Date.parse(longAgo) + 30 * MINUTE).toISOString() });
    outlook.nextLink = "https://elsewhere.example/next";
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.ok(await blockRow(old.id));
    outlook.nextLink = null;
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.ok(await blockRow(old.id));
    assert.equal((await getTask(mark, old.id)).dueHasTime, true);
    assert.equal((await getTask(mark, old.id)).dueAt, longAgo);

    await placeTask(mark, old.id, { at: minuteAt(Date.now() + 2 * DAY), durationMinutes: 30 });
    await syncTaskBlocks({ taskIds: [old.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1);
    assert.equal(outlook.events.get("block-1")!.start, (await getTask(mark, old.id)).dueAt);
  });

  it("leaves a pending change alone, so Orbit's newer time wins", async () => {
    const task = await linked("Call Jane", Date.now() + 2 * DAY);
    const before = outlook.events.get("block-1")!.start;
    await admin().query("update crm.tasks set due_at = due_at + interval '1 hour' where id = $1", [task.id]);
    const wanted = (await getTask(mark, task.id)).dueAt;
    outlook.failPatchWith = 503;
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.ok(await queued(task.id));
    assert.equal(outlook.events.get("block-1")!.start, before);
    assert.equal((await getTask(mark, task.id)).dueAt, wanted);
    outlook.failPatchWith = null;
    await admin().query("update crm.task_outlook_queue set retry_at = null where task_id = $1", [task.id]);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal(outlook.events.get("block-1")!.start, wanted);
    assert.equal((await getTask(mark, task.id)).dueAt, wanted);
  });

  it("only counts a block as deleted when Outlook says it is gone", async () => {
    const task = await linked("Call Jane", Date.now() + 2 * DAY);
    outlook.hidden.add("block-1");
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getTask(mark, task.id)).dueHasTime, true);
    assert.ok(await blockRow(task.id));
    assert.ok(outlook.calls.some((call) => call.method === "GET" && /\/me\/events\/block-1\?/.test(call.url)));
  });

  it("needs the block written at least two minutes before the fetch, by the database clock", async () => {
    const recent = await linked("Call recent", Date.now() + 2 * DAY);
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '90 seconds' where task_id = $1", [recent.id]);
    outlook.events.clear();
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getTask(mark, recent.id)).dueHasTime, true);
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '150 seconds' where task_id = $1", [recent.id]);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getTask(mark, recent.id)).dueHasTime, false);
  });

  it("refuses to link an event to someone else's task", async () => {
    const task = await linked("Call Jane", Date.now() + 2 * DAY);
    const priya = await createUser(`guard${seq}@outlook-blocks.test`, "Priya");
    await addMember(mark.workspaceId, priya.userId);
    const hers = (await createTask(priya, { title: "Priya's own" })).body.task;
    const event = await blockRow(task.id);
    await assert.rejects(queryAsUser(mark.userId, "update crm.calendar_events set task_id = $2 where id = $1", [event!.id, hers.id]));
    const calendar = await admin().query<{ id: string; connection_id: string }>("select id, connection_id from crm.calendars where user_id = $1 limit 1", [mark.userId]);
    await assert.rejects(
      queryAsUser(
        mark.userId,
        `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, starts_at, ends_at, task_id)
         values ($1, $2, $3, $4, 'stolen', now(), now(), $5)`,
        [mark.workspaceId, calendar.rows[0].id, calendar.rows[0].connection_id, mark.userId, hers.id],
      ),
    );
    await queryAsUser(mark.userId, "update crm.calendar_events set show_as = 'busy' where id = $1", [event!.id]);
  });

  it("skips the task when its owner has left that workspace", async () => {
    await connect(mark);
    const ridgeon = await createUser(`left${seq}@outlook-blocks.test`, "Ridgeon owner");
    await addMember(ridgeon.workspaceId, mark.userId);
    const there: UserActor = { ...mark, workspaceId: ridgeon.workspaceId, workspaceName: "Ridgeon", role: "member" };
    const task = await timed(there, "Call Ridgeon lead", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where task_id = $1", [task.id]);
    const before = await getTask(ridgeon, task.id);
    await admin().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [ridgeon.workspaceId, mark.userId]);
    outlook.events.clear();
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    const after = await getTask(ridgeon, task.id);
    assert.equal(after.dueAt, before.dueAt);
    assert.equal(after.dueHasTime, true);
    const kept = await admin().query("select 1 from crm.calendar_events where task_id = $1", [task.id]);
    assert.equal(kept.rowCount, 1);
  });

  it("acts as the owner in the task's workspace", async () => {
    await connect(mark);
    const ridgeon = await createUser(`acting${seq}@outlook-blocks.test`, "Ridgeon owner");
    await addMember(ridgeon.workspaceId, mark.userId);
    const there: UserActor = { ...mark, workspaceId: ridgeon.workspaceId, workspaceName: "Ridgeon", role: "member" };
    const task = await timed(there, "Call Ridgeon lead", Date.now() + 2 * DAY);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where task_id = $1", [task.id]);
    const moved = minuteAt(Date.now() + 5 * DAY);
    outlook.events.set("block-1", { subject: "Call Ridgeon lead", start: moved, end: new Date(Date.parse(moved) + 30 * MINUTE).toISOString() });
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getTask(there, task.id)).dueAt, moved);
    const audit = await admin().query<{ workspace_id: string; actor_user_id: string; operation: string }>(
      "select workspace_id, actor_user_id, operation from crm.audit_events where entity_id = $1 order by created_at desc limit 1",
      [task.id],
    );
    assert.deepEqual(audit.rows[0], { workspace_id: ridgeon.workspaceId, actor_user_id: mark.userId, operation: "calendar_sync" });
  });
});

describe("other readers skip block events", () => {
  async function blockWithMeeting() {
    await connect(mark);
    const soon = Date.now() + 5 * MINUTE;
    const task = await timed(mark, "Call Jane", soon);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    const event = await blockRow(task.id);
    return { task, event: event! };
  }

  it("keeps blocks out of the meeting list, personal events and the meeting tools", async () => {
    const { task, event } = await blockWithMeeting();
    const items = await listCalendarItems(mark, { start: new Date(Date.now() - DAY), end: new Date(Date.now() + DAY) });
    assert.equal(items.some((item) => item.id === event.id), false);
    assert.equal(
      isPersonalEvent({ task_id: task.id, created_by_orbit: true, invite_identity_id: null, invite_uid: null, contact_ids: [], attendees: [] }, new Set()),
      false,
    );
    assert.equal(isPersonalEvent({ task_id: null, created_by_orbit: true, invite_identity_id: null, invite_uid: null, contact_ids: [], attendees: [] }, new Set()), true);
    for (const run of [
      () => cancelInvite(mark, event.id, null, { fetchImpl: outlook.fetch }),
      () => rescheduleInvite(mark, { eventId: event.id, startLocal: "2030-01-10T10:00", durationMinutes: 30 }, { fetchImpl: outlook.fetch }),
    ]) {
      await assert.rejects(run, (error: unknown) => error instanceof CrmError && error.message === TASK_BLOCK_EVENT);
    }
    assert.equal(outlook.events.size, 1);
  });

  it("sends no starting soon alert, and busy readers and Plan ignore block events", async () => {
    const { task, event } = await blockWithMeeting();
    await savePushSubscription(mark, { endpoint: `https://web.push.apple.com/${seq}`, keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    const sent: string[] = [];
    const send: PushSender = async (_subscription, payload) => {
      sent.push(String(JSON.parse(payload).title));
    };
    await calendarAlerts(mark, { send });
    assert.deepEqual(sent, []);
    await admin().query("update crm.calendar_events set task_id = null where id = $1", [event.id]);
    await calendarAlerts(mark, { send });
    assert.equal(sent.length, 1);
    await admin().query("update crm.calendar_events set task_id = $2 where id = $1", [event.id, task.id]);
    const busy = await busyFor(mark, mark.userId, new Date(Date.now() - HOUR), 1);
    assert.deepEqual(busy, []);
    const context = await readPlanContext(mark, Date.now(), { store: false });
    assert.equal(context.meetings.some((meeting) => Date.parse(meeting.startsAt) === new Date(event.starts_at).getTime()), false);
  });

  it("leaves Mail's offered times free over a block", async () => {
    await connect(mark);
    const offered = await offerTimes(mark, "Times: [[times]]");
    assert.ok(offered.slots.length > 0);
    const slot = offered.slots[0];
    const task = await timed(mark, "Email Oliver", slot, 60);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.ok(await blockRow(task.id));
    assert.equal(await refreshTimes(mark, "Times: [[times]]", [slot]), null);
  });
});

describe("booking slots", () => {
  async function bookable(actor: UserActor) {
    await admin().query("insert into crm.booking_pages (workspace_id, user_id, slug, enabled) values ($1, $2, $3, true)", [actor.workspaceId, actor.userId, `mark-${seq}`]);
  }

  async function busy(actor: UserActor) {
    const result = await admin().query<{ starts_at: Date; ends_at: Date }>(
      "select * from private.booking_busy($1, now() - interval '1 day', now() + interval '10 days')",
      [actor.userId],
    );
    return result.rows.map((row) => `${new Date(row.starts_at).toISOString()}/${new Date(row.ends_at).toISOString()}`);
  }

  it("counts open timed tasks from every workspace that aren't in Outlook yet, once each", async () => {
    await bookable(mark);
    const ridgeon = await createUser(`book${seq}@outlook-blocks.test`, "Ridgeon owner");
    await addMember(ridgeon.workspaceId, mark.userId);
    const there: UserActor = { ...mark, workspaceId: ridgeon.workspaceId, workspaceName: "Ridgeon", role: "member" };
    const here = await timed(mark, "Call Jane", Date.now() + 2 * DAY, 30);
    const away = await timed(there, "Call Ridgeon lead", Date.now() + 3 * DAY, 45);
    const done = await timed(mark, "Call done", Date.now() + 4 * DAY, 30);
    await completeTask(mark, done.id);
    await createTask(mark, { title: "Day only", dueDate: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10) });
    const span = (task: { dueAt: string | null; durationMinutes: number }) => `${task.dueAt}/${new Date(Date.parse(task.dueAt!) + task.durationMinutes * MINUTE).toISOString()}`;
    assert.deepEqual(await busy(mark), [span(here), span(away)]);

    await connect(mark);
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 2);
    assert.deepEqual(await busy(mark), [span(here), span(away)]);
  });
});
