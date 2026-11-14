import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { storeGrantedScopes, syncCalendar } from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { saveMailbox } from "@/lib/crm/inbox";
import { queueOwnTaskBlocks, syncTaskBlocks } from "@/lib/crm/task-outlook";
import { archiveTask, completeTask, createTask, getTask, placeTask, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { TASK_BLOCK_PROPERTY } from "@/lib/microsoft/calendar";
import { createUser, resetDatabase } from "./helpers";

const WRITE_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read offline_access";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Stored = { owner: string; subject: string; start: string; end: string; transactionId: string; key: string | null };

function json(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function utc(iso: string) {
  return { dateTime: iso.replace("Z", "").replace(/\.\d{3}$/, ".0000000"), timeZone: "UTC" };
}

function fromGraph(value: unknown) {
  const item = value as { dateTime: string; timeZone: string };
  if (item.timeZone === "UTC") return new Date(`${item.dateTime}Z`).toISOString();
  const local = new Date(`${item.dateTime}Z`);
  const offset = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" })
    .formatToParts(local)
    .find((part) => part.type === "timeZoneName")!.value;
  const hours = offset === "GMT" ? 0 : Number(offset.replace("GMT", ""));
  return new Date(local.getTime() - hours * HOUR).toISOString();
}

class FakeOutlook {
  events = new Map<string, Stored>();
  created = 0;
  loseCreateResponses = 0;
  onCreate: (() => Promise<void>) | null = null;
  patches: Record<string, unknown>[] = [];
  tokens = new Map<string, string>();

  token(owner: string) {
    const token = `token-${owner}`;
    this.tokens.set(token, owner);
    return token;
  }

  owned(owner: string) {
    return [...this.events.values()].filter((event) => event.owner === owner);
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {}
    }
    const parsed = new URL(url);
    if (parsed.hostname === "login.microsoftonline.com") {
      const refresh = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
      return json({ access_token: this.token(refresh.replace("refresh-", "")), refresh_token: refresh, expires_in: 3600, scope: WRITE_SCOPES });
    }
    const auth = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    const owner = this.tokens.get(auth) ?? auth.replace("access-", "");
    if (method === "POST" && parsed.pathname === "/v1.0/me/events") {
      const properties = (body!.singleValueExtendedProperties as { id: string; value: string }[] | undefined) ?? [];
      const key = properties.find((item) => item.id === TASK_BLOCK_PROPERTY)?.value ?? null;
      const existing = [...this.events.entries()].find(([, event]) => event.owner === owner && event.transactionId === body!.transactionId);
      let id: string;
      if (existing) {
        id = existing[0];
      } else {
        this.created += 1;
        id = `block-${this.created}`;
        if (this.onCreate) {
          const hook = this.onCreate;
          this.onCreate = null;
          await hook();
        }
        this.events.set(id, { owner, subject: String(body!.subject), start: fromGraph(body!.start), end: fromGraph(body!.end), transactionId: String(body!.transactionId), key });
      }
      if (this.loseCreateResponses > 0) {
        this.loseCreateResponses -= 1;
        return json({ error: { code: "GatewayTimeout", message: "Timeout" } }, 504);
      }
      return json(this.graphEvent(id), 201);
    }
    if (method === "GET" && parsed.pathname === "/v1.0/me/events") {
      const filter = parsed.searchParams.get("$filter") ?? "";
      const value = /ep\/value eq '([^']+)'/.exec(filter)?.[1];
      const matches = [...this.events.entries()].filter(([, event]) => event.owner === owner && value && event.key === value && filter.includes(TASK_BLOCK_PROPERTY));
      return json({ value: matches.map(([id]) => this.graphEvent(id)) });
    }
    const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(parsed.pathname);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const event = this.events.get(id);
      if (!event || event.owner !== owner) return json({ error: { code: "ErrorItemNotFound", message: "Not found" } }, 404);
      if (method === "PATCH") {
        this.patches.push(body!);
        this.events.set(id, {
          ...event,
          subject: body!.subject === undefined ? event.subject : String(body!.subject),
          start: body!.start === undefined ? event.start : fromGraph(body!.start),
          end: body!.end === undefined ? event.end : fromGraph(body!.end),
        });
        return json(this.graphEvent(id));
      }
      if (method === "DELETE") {
        this.events.delete(id);
        return json(null, 204);
      }
      return json({ id });
    }
    if (parsed.pathname === "/v1.0/me/calendars") {
      return json({ value: [{ id: "cal-main", name: "Calendar", isDefaultCalendar: true, canEdit: true }] });
    }
    if (parsed.pathname.endsWith("/calendarView")) {
      const from = Date.parse(parsed.searchParams.get("startDateTime")!);
      const to = Date.parse(parsed.searchParams.get("endDateTime")!);
      const inside = [...this.events.entries()].filter(([, event]) => event.owner === owner && Date.parse(event.start) < to && Date.parse(event.end) > from);
      return json({ value: inside.map(([id]) => this.graphEvent(id)) });
    }
    return json({ error: { code: "NotFound", message: `Unexpected ${method} ${url}` } }, 404);
  }) as typeof fetch;

  graphEvent(id: string) {
    const event = this.events.get(id)!;
    return {
      id,
      subject: event.subject,
      start: utc(event.start),
      end: utc(event.end),
      isAllDay: false,
      isCancelled: false,
      showAs: "busy",
      organizer: { emailAddress: { name: "Mark", address: "mark@outlook-moves.test" } },
      attendees: [],
    };
  }
}

const admin = () => getAdminPool();

async function connect(actor: UserActor) {
  await saveMailbox(actor, {
    email: actor.email,
    refreshToken: `refresh-${actor.userId}`,
    accessToken: `access-${actor.userId}`,
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

function minuteAt(at: number) {
  return new Date(Math.floor(at / MINUTE) * MINUTE).toISOString();
}

async function timed(actor: UserActor, title: string, at: number, durationMinutes = 30) {
  const created = await createTask(actor, { title, dueAt: minuteAt(at), durationMinutes }, { provenance: { operation: "create_task", source: "mcp" } });
  return created.body.task;
}

async function ref(taskId: string) {
  const row = await admin().query<{ calendar_event_ref: string | null }>("select calendar_event_ref from crm.tasks where id = $1", [taskId]);
  return row.rows[0]?.calendar_event_ref ?? null;
}

async function queued(taskId: string) {
  const row = await admin().query("select * from crm.task_outlook_queue where task_id = $1", [taskId]);
  return row.rows[0] ?? null;
}

async function retryNow() {
  await admin().query("update crm.task_outlook_queue set retry_at = null");
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
  await admin().query("delete from crm.task_outlook_queue");
  seq += 1;
  mark = await createUser(`mark${seq}@outlook-moves.test`, "Mark Ridgeon");
  outlook = new FakeOutlook();
});

describe("a lost create response", () => {
  it("ends with one Outlook event at the new time after an edit and a retry", async () => {
    await connect(mark);
    const at = Date.now() + 2 * DAY;
    const task = await timed(mark, "Call Jane", at);
    outlook.loseCreateResponses = 2;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 1);
    assert.equal(await ref(task.id), null);
    const moved = minuteAt(at + HOUR);
    await placeTask(mark, task.id, { at: moved, durationMinutes: 45 });
    await retryNow();
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 1);
    const [id, event] = [...outlook.events.entries()][0];
    assert.equal(event.start, moved);
    assert.equal(event.end, new Date(Date.parse(moved) + 45 * MINUTE).toISOString());
    assert.equal(await ref(task.id), id);
    assert.equal(await queued(task.id), null);
  });

  it("removes the event it couldn't confirm when the task became date only", async () => {
    await connect(mark);
    const at = Date.now() + 2 * DAY;
    const task = await timed(mark, "Call Jane", at);
    outlook.loseCreateResponses = 2;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 1);
    await placeTask(mark, task.id, { dateOnly: true });
    await retryNow();
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(task.id), null);
    assert.equal(await queued(task.id), null);
  });

  it("removes the event it couldn't confirm from the previous owner's Outlook after a reassignment", async () => {
    await connect(mark);
    const colleague = await createUser(`sam${seq}@outlook-moves.test`, "Sam Hill");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    outlook.loseCreateResponses = 2;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.owned(mark.userId).length, 1);
    await updateTask(mark, task.id, { ownerId: colleague.userId });
    await retryNow();
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(task.id), null);
    assert.equal(await queued(task.id), null);
  });
});

describe("the migration", () => {
  it("runs again over itself", async () => {
    const sql = readFileSync("supabase/migrations/20270129100000_tasks_outlook_moves.sql", "utf8");
    await applyMigrationSql(getAdminPool(), sql);
    await applyMigrationSql(getAdminPool(), sql);
  });
});

describe("a change while the block is being created", () => {
  it("removes the block when the task becomes date only", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    outlook.onCreate = async () => {
      await placeTask(mark, task.id, { dateOnly: true });
    };
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1);
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(task.id), null);
    assert.equal(await queued(task.id), null);
  });

  it("removes the block when the task is done before it starts", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Bob", Date.now() + 2 * DAY);
    outlook.onCreate = async () => {
      await completeTask(mark, task.id);
    };
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1);
    assert.equal(outlook.events.size, 0);
    assert.equal(await queued(task.id), null);
  });

  it("removes the block when the task is archived", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Ann", Date.now() + 2 * DAY);
    outlook.onCreate = async () => {
      await archiveTask(mark, task.id);
    };
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
    assert.equal(await queued(task.id), null);
  });

  it("takes the block out of the previous owner's Outlook when the task is reassigned", async () => {
    await connect(mark);
    const colleague = await createUser(`priya${seq}@outlook-moves.test`, "Priya Shah");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    outlook.onCreate = async () => {
      await updateTask(mark, task.id, { ownerId: colleague.userId });
    };
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await retryNow();
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1);
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(task.id), null);
    assert.equal(await queued(task.id), null);
    const events = await admin().query("select 1 from crm.calendar_events where task_id = $1", [task.id]);
    assert.equal(events.rowCount, 0);
  });

  it("moves the block when the task is moved", async () => {
    await connect(mark);
    const at = Date.now() + 2 * DAY;
    const task = await timed(mark, "Call Jane", at);
    const moved = minuteAt(at + 2 * HOUR);
    outlook.onCreate = async () => {
      await placeTask(mark, task.id, { at: moved, durationMinutes: 30 });
    };
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 1);
    assert.equal([...outlook.events.values()][0].start, moved);
    assert.equal(await queued(task.id), null);
  });
});

describe("a block moved in Outlook", () => {
  async function linked(title: string, at: number) {
    await connect(mark);
    const task = await timed(mark, title, at);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where task_id = $1", [task.id]);
    return task;
  }

  function drag(start: string, minutes: number) {
    const [id, event] = [...outlook.events.entries()][0];
    outlook.events.set(id, { ...event, start, end: new Date(Date.parse(start) + minutes * MINUTE).toISOString() });
  }

  it("keeps Outlook's time when only the title changes in Orbit before the next sync", async () => {
    const task = await linked("Call Jane", Date.now() + 2 * DAY);
    const dragged = minuteAt(Date.now() + 3 * DAY);
    drag(dragged, 50);
    await updateTask(mark, task.id, { title: "Call Jane Doe" });
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    const event = [...outlook.events.values()][0];
    assert.equal(event.subject, "Call Jane Doe");
    assert.equal(event.start, dragged);
    assert.equal("start" in outlook.patches.at(-1)!, false);
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where task_id = $1", [task.id]);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    const after = await getTask(mark, task.id);
    assert.equal(after.dueAt, dragged);
    assert.equal(after.durationMinutes, 50);
    assert.equal([...outlook.events.values()][0].start, dragged);
  });

  it("keeps Outlook's time when a sync stored it while the task was waiting to be written", async () => {
    const task = await linked("Call Jane", Date.now() + 2 * DAY);
    const dragged = minuteAt(Date.now() + 3 * DAY);
    drag(dragged, 30);
    await updateTask(mark, task.id, { title: "Call Jane Doe" });
    await admin().query("update crm.task_outlook_queue set retry_at = now() + interval '1 hour' where task_id = $1", [task.id]);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    await retryNow();
    await queueOwnTaskBlocks(mark.userId);
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal([...outlook.events.values()][0].start, dragged);
    assert.equal([...outlook.events.values()][0].subject, "Call Jane Doe");
  });

  it("lets Orbit's new time win when both sides moved the block", async () => {
    const at = Date.now() + 2 * DAY;
    const task = await linked("Call Jane", at);
    drag(minuteAt(Date.now() + 3 * DAY), 30);
    const moved = minuteAt(at + HOUR);
    await placeTask(mark, task.id, { at: moved, durationMinutes: 30 });
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal([...outlook.events.values()][0].start, moved);
    await admin().query("update crm.calendar_events set block_written_at = now() - interval '5 minutes' where task_id = $1", [task.id]);
    await syncCalendar(mark, { fetchImpl: outlook.fetch, force: true });
    assert.equal((await getTask(mark, task.id)).dueAt, moved);
  });
});
