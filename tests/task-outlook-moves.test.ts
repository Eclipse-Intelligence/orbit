import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { storeGrantedScopes, syncCalendar } from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { disconnectMailbox, saveMailbox } from "@/lib/crm/inbox";
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
  events = new Map<string, Stored>();
  created = 0;
  loseCreateResponses = 0;
  onCreate: (() => Promise<void>) | null = null;
  patches: Record<string, unknown>[] = [];
  tokens = new Map<string, string>();
  searches: string[] = [];
  searchStatus: number | null = null;
  hiddenFromSearch = new Set<string>();
  failPatches = 0;
  failDeletes = new Set<string>();

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
      this.searches.push(url);
      if (this.searchStatus) return json({ error: { code: "Nope", message: "Nope" } }, this.searchStatus);
      const filter = parsed.searchParams.get("$filter") ?? "";
      const value = /ep\/value eq '([^']+)'/.exec(filter)?.[1];
      const matches = [...this.events.entries()].filter(
        ([id, event]) => !this.hiddenFromSearch.has(id) && event.owner === owner && value && event.key === value && filter.includes(TASK_BLOCK_PROPERTY),
      );
      return json({ value: matches.map(([id]) => this.graphEvent(id)) });
    }
    const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(parsed.pathname);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const event = this.events.get(id);
      if (!event || event.owner !== owner) return json({ error: { code: "ErrorItemNotFound", message: "Not found" } }, 404);
      if (method === "PATCH") {
        if (this.failPatches > 0) {
          this.failPatches -= 1;
          return json({ error: { code: "ServiceUnavailable", message: "Busy" } }, 503);
        }
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
        if (this.failDeletes.has(id)) return json({ error: { code: "ServiceUnavailable", message: "Busy" } }, 503);
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
    assert.equal(outlook.created, 1);
    assert.equal(outlook.events.size, 0);
    assert.equal(await ref(task.id), null);
    assert.equal(await queued(task.id), null);
    const events = await admin().query("select 1 from crm.calendar_events where task_id = $1", [task.id]);
    assert.equal(events.rowCount, 0);
  });

  it("removes the block on a later run when deleting it at once fails", async () => {
    await connect(mark);
    const colleague = await createUser(`pia${seq}@outlook-moves.test`, "Pia Shah");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    outlook.onCreate = async () => {
      await updateTask(mark, task.id, { ownerId: colleague.userId });
      outlook.failDeletes.add("block-1");
    };
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.equal(outlook.owned(mark.userId).length, 1);
    assert.equal(await ref(task.id), null);
    assert.ok((await queued(task.id))?.create_key);
    outlook.failDeletes.clear();
    await retryNow();
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 0);
    assert.equal(outlook.created, 1);
    assert.equal(await queued(task.id), null);
  });

  it("backs off instead of looping when the event row keeps being refused", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    await admin().query(
      `create or replace function public.refuse_block_owner() returns trigger language plpgsql as $$ begin raise exception 'task block must be your own task' using errcode = '42501'; end; $$`,
    );
    await admin().query("create trigger refuse_block_owner before insert on crm.calendar_events for each row when (new.task_id is not null) execute function public.refuse_block_owner()");
    try {
      await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    } finally {
      await admin().query("drop trigger refuse_block_owner on crm.calendar_events");
    }
    assert.equal(outlook.created, 1);
    assert.equal(outlook.events.size, 0);
    const row = await queued(task.id);
    assert.equal(row.attempts, 1);
    assert.ok(new Date(row.retry_at).getTime() > Date.now());
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

describe("looking up a block whose create never confirmed", () => {
  async function lost(count = 1) {
    await connect(mark);
    const at = Date.now() + 2 * DAY;
    const tasks = [];
    for (let index = 0; index < count; index += 1) tasks.push(await timed(mark, `Call ${index}`, at + index * HOUR));
    outlook.loseCreateResponses = 2 * count;
    await syncTaskBlocks({ taskIds: tasks.map((task) => task.id), fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, count);
    await retryNow();
    return { at, tasks };
  }

  async function key(taskId: string) {
    return ((await queued(taskId)) as { create_key: string | null } | null)?.create_key ?? null;
  }

  it("searches Outlook with an encoded filter on Orbit's own property", async () => {
    const { tasks } = await lost();
    const sent = await key(tasks[0].id);
    assert.ok(sent);
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.searches.length, 1);
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq 'String {6f1e3c52-8a4d-4b7e-9c21-5d0a7b3e8f14} Name OrbitTaskBlockKey' and ep/value eq '${sent}')`;
    assert.equal(
      outlook.searches[0],
      `https://graph.microsoft.com/v1.0/me/events?$filter=${filter.replace(/ /g, "%20").replace(/\//g, "%2F").replace(/:/g, "%3A").replace(/\{/g, "%7B").replace(/\}/g, "%7D")}&$select=id%2Csubject%2Cstart%2Cend&$top=10`,
    );
    assert.equal(outlook.searches[0].includes("+"), false);
    assert.equal(TASK_BLOCK_PROPERTY, "String {6f1e3c52-8a4d-4b7e-9c21-5d0a7b3e8f14} Name OrbitTaskBlockKey");
  });

  it("keeps one event when Outlook has two for the same key", async () => {
    const { tasks } = await lost();
    const [, first] = [...outlook.events.entries()][0];
    outlook.events.set("block-copy", { ...first });
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.size, 1);
    assert.equal(await ref(tasks[0].id), [...outlook.events.keys()][0]);
    assert.equal(await queued(tasks[0].id), null);
  });

  it("keeps the key and tries the second event again when removing it fails", async () => {
    const { tasks } = await lost();
    const [id, first] = [...outlook.events.entries()][0];
    outlook.events.set("block-copy", { ...first });
    outlook.failDeletes.add("block-copy");
    const sent = await key(tasks[0].id);
    const run = await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.deferred, 1);
    assert.equal(await key(tasks[0].id), sent);
    assert.equal(outlook.events.size, 2);
    outlook.failDeletes.clear();
    await retryNow();
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.deepEqual([...outlook.events.keys()], [id]);
    assert.equal(await ref(tasks[0].id), id);
    assert.equal(await queued(tasks[0].id), null);
    assert.equal(outlook.created, 1);
  });

  it("links the found event anyway once the second one has failed to go five times", async () => {
    const { tasks } = await lost();
    const [id, first] = [...outlook.events.entries()][0];
    outlook.events.set("block-copy", { ...first });
    outlook.failDeletes.add("block-copy");
    await admin().query("update crm.task_outlook_queue set attempts = 5 where task_id = $1", [tasks[0].id]);
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(await ref(tasks[0].id), id);
    assert.equal(await queued(tasks[0].id), null);
    assert.equal(outlook.created, 1);
  });

  it("trusts an empty search when it doesn't know when the create was sent", async () => {
    const { tasks } = await lost();
    const [id] = [...outlook.events.keys()];
    outlook.hiddenFromSearch.add(id);
    await admin().query("update crm.task_outlook_queue set create_sent_at = null");
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1);
    assert.equal(await ref(tasks[0].id), id);
    assert.equal(await queued(tasks[0].id), null);
  });

  it("holds without counting an attempt", async () => {
    const { tasks } = await lost();
    outlook.hiddenFromSearch.add([...outlook.events.keys()][0]);
    const before = ((await queued(tasks[0].id)) as { attempts: number }).attempts;
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(((await queued(tasks[0].id)) as { attempts: number }).attempts, before);
  });

  it("defers that person's other writes in the run after a 429 on a lookup", async () => {
    const { tasks } = await lost();
    const fresh = await timed(mark, "Call Zoe", Date.now() + 4 * DAY);
    outlook.searchStatus = 429;
    const run = await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.throttled, 2);
    assert.equal(outlook.created, 1);
    assert.ok(await key(tasks[0].id));
    assert.ok(await queued(fresh.id));
  });

  it("gives the new owner a block when the previous creator's Outlook is disconnected", async () => {
    const { at, tasks } = await lost();
    const colleague = await createUser(`kit${seq}@outlook-moves.test`, "Kit Moss");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const kit: UserActor = { ...mark, userId: colleague.userId, email: colleague.email, fullName: "Kit Moss", role: "member" };
    await connect(kit);
    await updateTask(mark, tasks[0].id, { ownerId: colleague.userId });
    await placeTask(kit, tasks[0].id, { at: minuteAt(at + HOUR), durationMinutes: 30 });
    await disconnectMailbox(mark);
    await retryNow();
    const run = await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.orbit_only, 1);
    assert.equal(outlook.owned(colleague.userId).length, 1);
    assert.equal(await queued(tasks[0].id), null);
    assert.equal(await key(tasks[0].id), null);
  });

  it("patches the event Graph returns for a repeated create to the task's new time", async () => {
    const { at, tasks } = await lost();
    const [id] = [...outlook.events.keys()];
    outlook.hiddenFromSearch.add(id);
    const moved = minuteAt(at + 3 * HOUR);
    await placeTask(mark, tasks[0].id, { at: moved, durationMinutes: 30 });
    await admin().query("update crm.task_outlook_queue set create_sent_at = now() - interval '3 minutes', retry_at = null");
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.created, 1);
    assert.equal(outlook.events.size, 1);
    assert.equal(outlook.events.get(id)!.start, moved);
    assert.equal(await ref(tasks[0].id), id);
    assert.equal(await queued(tasks[0].id), null);
  });

  it("waits before trusting an empty search straight after the create", async () => {
    const { tasks } = await lost();
    const [id] = [...outlook.events.keys()];
    outlook.hiddenFromSearch.add(id);
    const sent = await key(tasks[0].id);
    const run = await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.deferred, 1);
    assert.equal(outlook.created, 1);
    const row = (await queued(tasks[0].id)) as { create_key: string; create_sent_at: Date; retry_at: Date };
    assert.equal(row.create_key, sent);
    assert.ok(new Date(row.retry_at).getTime() >= new Date(row.create_sent_at).getTime() + 2 * MINUTE - 1000);
  });

  for (const status of [400, 401, 403, 500]) {
    it(`defers and keeps the key when the search answers ${status}`, async () => {
      const { tasks } = await lost();
      const sent = await key(tasks[0].id);
      outlook.searchStatus = status;
      const run = await syncTaskBlocks({ fetchImpl: outlook.fetch });
      assert.equal(run.deferred, 1);
      assert.equal(run.created, 0);
      assert.equal(outlook.created, 1);
      assert.equal(await key(tasks[0].id), sent);
      assert.equal(await ref(tasks[0].id), null);
    });
  }

  it("stops searching that person's Outlook after a 429 and defers the rest", async () => {
    const { tasks } = await lost(3);
    outlook.searchStatus = 429;
    const run = await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.searches.length, 1);
    assert.equal(run.throttled, 3);
    for (const task of tasks) assert.ok(await key(task.id));
    assert.equal(outlook.created, 3);
  });

  it("defers and keeps the key while the creator's Outlook is disconnected", async () => {
    const { tasks } = await lost();
    const sent = await key(tasks[0].id);
    await disconnectMailbox(mark);
    const run = await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(run.deferred, 1);
    assert.equal(outlook.searches.length, 0);
    assert.equal(await key(tasks[0].id), sent);
  });

  it("stops searching and leaves the rest queued when the run's time runs short", async () => {
    const { tasks } = await lost(5);
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("$filter=")) await new Promise((resolve) => setTimeout(resolve, 1_500));
      return outlook.fetch(input, init);
    }) as typeof fetch;
    const started = Date.now();
    await syncTaskBlocks({ fetchImpl: slow, deadline: Date.now() + 5_000 });
    assert.ok(Date.now() - started < 5_000);
    assert.equal(outlook.searches.length, 1);
    for (const task of tasks) {
      const row = (await queued(task.id)) as { create_key: string | null; claimed_at: Date | null } | null;
      if (task.id === tasks[0].id && !row) continue;
      assert.ok(row?.create_key);
      assert.equal(row?.claimed_at, null);
    }
    assert.equal(outlook.created, 5);
  });

  it("removes a linked event whose move failed when the task is then reassigned", async () => {
    await connect(mark);
    const colleague = await createUser(`sam${seq}@outlook-moves.test`, "Sam Hill");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const sam: UserActor = { ...mark, userId: colleague.userId, email: colleague.email, fullName: "Sam Hill", role: "member" };
    await connect(sam);
    const at = Date.now() + 2 * DAY;
    const task = await timed(mark, "Call Jane", at);
    outlook.loseCreateResponses = 2;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await placeTask(mark, task.id, { at: minuteAt(at + HOUR), durationMinutes: 45 });
    await retryNow();
    outlook.failPatches = 2;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    assert.ok(await ref(task.id));
    await updateTask(mark, task.id, { ownerId: colleague.userId });
    await retryNow();
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.owned(mark.userId).length, 0);
    assert.equal(outlook.owned(colleague.userId).length, 0);
    assert.equal(await queued(task.id), null);
  });

  it("gives the new owner their own block and clears the old one when they set a time", async () => {
    await connect(mark);
    const colleague = await createUser(`ann${seq}@outlook-moves.test`, "Ann Lee");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const ann: UserActor = { ...mark, userId: colleague.userId, email: colleague.email, fullName: "Ann Lee", role: "member" };
    await connect(ann);
    const at = Date.now() + 2 * DAY;
    const task = await timed(mark, "Call Jane", at);
    outlook.loseCreateResponses = 2;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: outlook.fetch });
    await updateTask(mark, task.id, { ownerId: colleague.userId });
    await placeTask(ann, task.id, { at: minuteAt(at + HOUR), durationMinutes: 30 });
    await retryNow();
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.owned(mark.userId).length, 0);
    assert.equal(outlook.owned(colleague.userId).length, 1);
    assert.equal(outlook.owned(colleague.userId)[0].start, minuteAt(at + HOUR));
    assert.equal(await ref(task.id), [...outlook.events.entries()].find(([, event]) => event.owner === colleague.userId)![0]);
    assert.equal(await queued(task.id), null);
  });

  it("puts an unconfirmed block that was moved in Outlook back at the task's time", async () => {
    const { at, tasks } = await lost();
    const [id, event] = [...outlook.events.entries()][0];
    const dragged = minuteAt(at + 5 * HOUR);
    outlook.events.set(id, { ...event, start: dragged, end: new Date(Date.parse(dragged) + 30 * MINUTE).toISOString() });
    await syncTaskBlocks({ fetchImpl: outlook.fetch });
    assert.equal(outlook.events.get(id)!.start, minuteAt(at));
    assert.equal((await getTask(mark, tasks[0].id)).dueAt, minuteAt(at));
  });
});

describe("a run", () => {
  it("stops after four rounds when the task keeps changing under it", async () => {
    await connect(mark);
    const task = await timed(mark, "Call Jane", Date.now() + 2 * DAY);
    let writes = 0;
    const editing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await outlook.fetch(input, init);
      const method = init?.method ?? "GET";
      if (String(input).startsWith("https://graph.microsoft.com/v1.0/me/events") && (method === "POST" || method === "PATCH")) {
        writes += 1;
        await updateTask(mark, task.id, { title: `Call Jane ${writes}` });
      }
      return response;
    }) as typeof fetch;
    await syncTaskBlocks({ taskIds: [task.id], fetchImpl: editing });
    assert.equal(writes, 4);
    assert.equal(outlook.events.size, 1);
    assert.ok(await queued(task.id));
  });
});
