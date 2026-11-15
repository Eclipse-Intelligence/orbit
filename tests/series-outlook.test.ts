import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { storeGrantedScopes, syncCalendar } from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { saveMailbox } from "@/lib/crm/inbox";
import { seriesRecurrence, syncSeriesOutlook } from "@/lib/crm/series-outlook";
import { createRepeatingTask, deleteSeries, endSeriesOn, setTaskRepeat, skipOccurrence, updateOccurrence } from "@/lib/crm/task-series";
import { syncTaskBlocks } from "@/lib/crm/task-outlook";
import { completeTask } from "@/lib/crm/tasks";
import type { Task, UserActor } from "@/lib/crm/types";
import { undoTaskEvents } from "@/lib/crm/undo";
import { moveUpcoming } from "@/lib/crm/upcoming";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import type { GraphEvent } from "@/lib/microsoft/calendar";
import { createUser, resetDatabase } from "./helpers";

const WRITE_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read offline_access";
const HOUR = 3_600_000;
const DRAG = { operation: "drag_task", source: "web" };

type Recurrence = {
  pattern: { type: string; interval: number; daysOfWeek?: string[] };
  range: { type: string; startDate: string; endDate?: string };
};
type Master = { subject: string; at: string; minutes: number; recurrence: Recurrence; transactionId: string; key: string | null; body: string };
type Plain = { subject: string; start: string; end: string; transactionId: string; key: string | null };
type Instance = { start: string; end: string; subject: string };

function json(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function londonOffset(at: number) {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" })
    .formatToParts(new Date(at))
    .find((part) => part.type === "timeZoneName")!.value;
  return name === "GMT" ? 0 : Number(name.replace("GMT", "")) * HOUR;
}

function fromGraph(value: unknown) {
  const item = value as { dateTime: string; timeZone: string };
  if (item.timeZone === "UTC") return new Date(`${item.dateTime.replace(/\.\d+$/, "")}Z`).toISOString();
  const wall = Date.parse(`${item.dateTime.replace(/\.\d+$/, "")}Z`);
  return new Date(wall - londonOffset(wall - londonOffset(wall))).toISOString();
}

function utc(iso: string) {
  return { dateTime: iso.replace("Z", "").replace(/\.\d{3}$/, ".0000000"), timeZone: "UTC" };
}

const WEEK_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function weekdayOf(day: string) {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
}

function expand(recurrence: Recurrence, limit = 400) {
  const days: string[] = [];
  const { pattern, range } = recurrence;
  const start = range.startDate;
  const anchor = shiftDay(start, -weekdayOf(start));
  for (let index = 0; index < 800 && days.length < limit; index += 1) {
    const day = shiftDay(start, index);
    if (range.endDate && day > range.endDate) break;
    if (pattern.type === "daily" && index % pattern.interval === 0) days.push(day);
    if (pattern.type === "weekly") {
      const weeks = Math.floor((Date.parse(`${shiftDay(day, -weekdayOf(day))}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / (7 * 24 * HOUR));
      if (weeks % pattern.interval === 0 && pattern.daysOfWeek?.includes(WEEK_NAMES[weekdayOf(day)])) days.push(day);
    }
  }
  return days;
}

class FakeGraph {
  masters = new Map<string, Master>();
  plains = new Map<string, Plain>();
  overrides = new Map<string, Instance>();
  deleted = new Set<string>();
  calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  refuseInstancePatch = false;
  created = 0;

  instancesOf(id: string) {
    const master = this.masters.get(id)!;
    return expand(master.recurrence)
      .map((day) => `${id}::${day}`)
      .filter((instance) => !this.deleted.has(instance))
      .map((instance) => {
        const day = instance.split("::")[1];
        const start = fromGraph({ dateTime: `${day}T${master.at}:00`, timeZone: "GMT Standard Time" });
        const own = this.overrides.get(instance);
        return { id: instance, start: own?.start ?? start, end: own?.end ?? new Date(Date.parse(start) + master.minutes * 60_000).toISOString(), subject: own?.subject ?? master.subject, seriesMasterId: id };
      });
  }

  everything() {
    const items: { id: string; start: string; end: string; subject: string; seriesMasterId?: string }[] = [];
    for (const id of this.masters.keys()) items.push(...this.instancesOf(id));
    for (const [id, plain] of this.plains) items.push({ id, start: plain.start, end: plain.end, subject: plain.subject });
    return items;
  }

  onDay(day: string) {
    return this.everything().filter((item) => dayKeyAt(new Date(item.start)) === day);
  }

  graph(item: { id: string; start: string; end: string; subject: string; seriesMasterId?: string }): GraphEvent {
    return { id: item.id, subject: item.subject, start: utc(item.start), end: utc(item.end), isAllDay: false, isCancelled: false, showAs: "busy", attendees: [], ...(item.seriesMasterId ? { seriesMasterId: item.seriesMasterId } : {}) };
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({ method, url, body });
    const parsed = new URL(url);
    if (parsed.hostname === "login.microsoftonline.com") return json({ access_token: "fresh", refresh_token: "refresh", expires_in: 3600, scope: WRITE_SCOPES });
    const property = (value: Record<string, unknown> | null) =>
      ((value?.singleValueExtendedProperties as { value: string }[] | undefined) ?? [])[0]?.value ?? null;
    if (method === "POST" && parsed.pathname === "/v1.0/me/events") {
      const same = [...this.masters, ...this.plains].find(([, item]) => item.transactionId === body!.transactionId);
      if (same) return json({ id: same[0] }, 201);
      this.created += 1;
      if (body!.recurrence) {
        const id = `master-${this.created}`;
        const start = body!.start as { dateTime: string };
        const end = fromGraph(body!.end);
        const minutes = (Date.parse(end) - Date.parse(fromGraph(body!.start))) / 60_000;
        this.masters.set(id, { subject: String(body!.subject), at: start.dateTime.slice(11, 16), minutes, recurrence: body!.recurrence as Recurrence, transactionId: String(body!.transactionId), key: property(body), body: String((body!.body as { content: string }).content) });
        return json({ id }, 201);
      }
      const id = `single-${this.created}`;
      this.plains.set(id, { subject: String(body!.subject), start: fromGraph(body!.start), end: fromGraph(body!.end), transactionId: String(body!.transactionId), key: property(body) });
      return json({ id }, 201);
    }
    if (method === "GET" && parsed.pathname === "/v1.0/me/events") {
      const filter = parsed.searchParams.get("$filter") ?? "";
      const value = /ep\/value eq '([^']+)'/.exec(filter)?.[1];
      const found = [...this.masters].filter(([, master]) => master.key === value).map(([id]) => ({ id }));
      return json({ value: found });
    }
    const instances = /^\/v1\.0\/me\/events\/([^/]+)\/instances$/.exec(parsed.pathname);
    if (instances && method === "GET") {
      const id = decodeURIComponent(instances[1]);
      if (!this.masters.has(id)) return json({ error: { code: "ErrorItemNotFound" } }, 404);
      const from = Date.parse(parsed.searchParams.get("startDateTime")!);
      const to = Date.parse(parsed.searchParams.get("endDateTime")!);
      return json({ value: this.instancesOf(id).filter((item) => Date.parse(item.start) < to && Date.parse(item.end) > from).map((item) => this.graph(item)) });
    }
    const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(parsed.pathname);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (method === "DELETE") {
        if (this.masters.delete(id)) return json(null, 204);
        if (this.plains.delete(id)) return json(null, 204);
        if (id.includes("::") && this.masters.has(id.split("::")[0]) && !this.deleted.has(id)) {
          this.deleted.add(id);
          return json(null, 204);
        }
        return json({ error: { code: "ErrorItemNotFound" } }, 404);
      }
      if (method === "PATCH") {
        const master = this.masters.get(id);
        if (master) {
          const startWall = body!.start as { dateTime: string } | undefined;
          const recurrence = (body!.recurrence as Recurrence | undefined) ?? master.recurrence;
          const minutes = body!.start && body!.end ? (Date.parse(fromGraph(body!.end)) - Date.parse(fromGraph(body!.start))) / 60_000 : master.minutes;
          this.masters.set(id, { ...master, subject: String(body!.subject ?? master.subject), at: startWall ? startWall.dateTime.slice(11, 16) : master.at, minutes, recurrence });
          for (const key of [...this.overrides.keys()]) if (key.startsWith(`${id}::`)) this.overrides.delete(key);
          for (const key of [...this.deleted]) if (key.startsWith(`${id}::`)) this.deleted.delete(key);
          return json({ id });
        }
        const plain = this.plains.get(id);
        if (plain) {
          this.plains.set(id, { ...plain, subject: String(body!.subject), start: fromGraph(body!.start), end: fromGraph(body!.end) });
          return json({ id });
        }
        if (id.includes("::") && this.masters.has(id.split("::")[0]) && !this.deleted.has(id)) {
          if (this.refuseInstancePatch) return json({ error: { code: "ErrorOccurrenceCrossingBoundary", message: "Can't move past a neighbour" } }, 400);
          this.overrides.set(id, { subject: String(body!.subject), start: fromGraph(body!.start), end: fromGraph(body!.end) });
          return json({ id });
        }
        return json({ error: { code: "ErrorItemNotFound" } }, 404);
      }
      return json({ id });
    }
    if (parsed.pathname === "/v1.0/me/calendars") return json({ value: [{ id: "cal-main", name: "Calendar", isDefaultCalendar: true, canEdit: true }] });
    if (parsed.pathname.endsWith("/calendarView")) {
      const from = Date.parse(parsed.searchParams.get("startDateTime")!);
      const to = Date.parse(parsed.searchParams.get("endDateTime")!);
      return json({ value: this.everything().filter((item) => Date.parse(item.start) < to && Date.parse(item.end) > from).map((item) => this.graph(item)) });
    }
    return json({ error: { code: "NotFound", message: `Unexpected ${method} ${url}` } }, 404);
  }) as typeof fetch;
}

const admin = () => getAdminPool();
let mark: UserActor;
let graph: FakeGraph;
let seq = 0;
const today = dayKeyAt(new Date());

function nextWeekday(index: number, from = shiftDay(today, 1)) {
  let day = from;
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== index) day = shiftDay(day, 1);
  return day;
}

function london(day: string, time: string) {
  return fromGraph({ dateTime: `${day}T${time}:00`, timeZone: "GMT Standard Time" });
}

async function connect(actor: UserActor) {
  await saveMailbox(actor, { email: `${actor.email}`, refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + HOUR).toISOString() });
  const connection = await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [actor.userId]);
  const id = connection.rows[0].id;
  await withActor(actor, (db) => storeGrantedScopes(db, actor, id, WRITE_SCOPES));
  await admin().query(
    `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
     values ($1, $2, $3, 'cal-main', 'Calendar', '#4f9be8', true, true, true, true)`,
    [actor.workspaceId, actor.userId, id],
  );
}

async function sync() {
  await syncTaskBlocks({ fetchImpl: graph.fetch, userId: mark.userId });
  return syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
}

async function repeating(title: string, day: string, time: string | null, repeat: Record<string, unknown>): Promise<Task> {
  const timing = time ? { dueAt: london(day, time) } : { dueDate: day };
  return (await createRepeatingTask(mark, { title, ...timing }, repeat)).body.task;
}

async function version(seriesId: string) {
  const rows = await admin().query<{ version: string; settled_version: string }>("select version, settled_version from crm.task_series_outlook where series_id = $1", [seriesId]);
  return rows.rows[0] ? { version: Number(rows.rows[0].version), settled: Number(rows.rows[0].settled_version) } : null;
}

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
  process.env.SITE_URL = "https://orbit.example";
  setLiveTesting({ batch: async () => undefined });
});

beforeEach(async () => {
  seq += 1;
  mark = await createUser(`mark${seq}@series-outlook.test`, "Mark Ridgeon");
  await connect(mark);
  graph = new FakeGraph();
});

after(async () => {
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("the recurrence Outlook gets", () => {
  it("maps every rule and end", () => {
    const tz = "Europe/London";
    assert.deepEqual(seriesRecurrence({ startsOn: "2027-01-04", at: "09:00", rule: { freq: "daily", interval: 3 }, ends: { never: true } }, "2027-01-07", null, tz), {
      pattern: { type: "daily", interval: 3 },
      range: { type: "noEnd", startDate: "2027-01-07", recurrenceTimeZone: "GMT Standard Time" },
    });
    assert.deepEqual(seriesRecurrence({ startsOn: "2027-01-04", at: "09:00", rule: { freq: "weekly", interval: 2, weekdays: ["th", "mo"] }, ends: { count: 5 } }, "2027-01-07", "2027-02-01", tz).pattern, {
      type: "weekly",
      interval: 2,
      daysOfWeek: ["monday", "thursday"],
      firstDayOfWeek: "monday",
    });
    assert.deepEqual(seriesRecurrence({ startsOn: "2027-01-31", at: "09:00", rule: { freq: "monthly", interval: 1 }, ends: { never: true } }, "2027-01-31", null, tz).pattern, { type: "absoluteMonthly", interval: 1, dayOfMonth: 31 });
    assert.deepEqual(seriesRecurrence({ startsOn: "2027-01-29", at: "09:00", rule: { freq: "monthly", interval: 3, monthWeek: { n: -1, weekday: "fr" } }, ends: { never: true } }, "2027-01-29", null, tz).pattern, {
      type: "relativeMonthly",
      interval: 3,
      daysOfWeek: ["friday"],
      index: "last",
    });
    assert.deepEqual(seriesRecurrence({ startsOn: "2028-02-29", at: "09:00", rule: { freq: "yearly", interval: 1 }, ends: { until: "2035-01-01" } }, "2028-02-29", "2034-02-28", tz), {
      pattern: { type: "absoluteYearly", interval: 1, month: 2, dayOfMonth: 29 },
      range: { type: "endDate", startDate: "2028-02-29", endDate: "2034-02-28", recurrenceTimeZone: "GMT Standard Time" },
    });
  });
});

describe("repeating tasks in Outlook", () => {
  it("writes one Busy, Private series from the date after the open one, so no date has two events", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating("Check in", tuesday, "14:00", { every: "week" });
    await sync();
    const [masterId, master] = [...graph.masters][0];
    assert.equal(graph.masters.size, 1);
    assert.equal(master.recurrence.range.startDate, shiftDay(tuesday, 7));
    assert.deepEqual(master.recurrence.pattern, { type: "weekly", interval: 1, daysOfWeek: ["tuesday"], firstDayOfWeek: "monday" });
    assert.equal(master.at, "14:00");
    assert.match(master.body, /From Orbit\./);
    const post = graph.calls.find((call) => call.method === "POST" && call.body?.recurrence)!;
    assert.equal(post.body!.showAs, "busy");
    assert.equal(post.body!.sensitivity, "private");
    assert.equal(post.body!.isReminderOn, false);
    assert.equal(graph.onDay(tuesday).length, 1);
    assert.equal(graph.onDay(shiftDay(tuesday, 7)).length, 1);

    const again = await sync();
    assert.equal(again.written, 0);
    assert.equal(graph.masters.size, 1);

    await completeTask(mark, task.id);
    await sync();
    assert.equal(graph.masters.get(masterId)!.recurrence.range.startDate, shiftDay(tuesday, 14));
    assert.equal(graph.onDay(shiftDay(tuesday, 7)).length, 1);
    assert.equal(graph.masters.size, 1);
  });

  it("patches This one, cancels a skip and writes a single event when Outlook refuses the move", async () => {
    const wednesday = nextWeekday(3);
    const task = await repeating("Walk", wednesday, "14:00", { every: "week" });
    await sync();
    const later = shiftDay(wednesday, 7);
    const moved = await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "16:00"), dueHasTime: true }, "this", [], DRAG);
    await sync();
    assert.deepEqual(graph.onDay(later).map((item) => item.start), [london(later, "16:00")]);

    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: shiftDay(wednesday, 14) });
    await sync();
    assert.equal(graph.onDay(shiftDay(wednesday, 14)).length, 0);

    graph.refuseInstancePatch = true;
    const third = shiftDay(wednesday, 21);
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: third }, { dueAt: london(third, "09:00"), dueHasTime: true }, "this", [], DRAG);
    await sync();
    const onThird = graph.onDay(third);
    assert.equal(onThird.length, 1);
    assert.equal(onThird[0].start, london(third, "09:00"));
    assert.equal(onThird[0].seriesMasterId, undefined);
    assert.equal([...graph.plains.values()].filter((plain) => plain.key?.startsWith("series:")).length, 1);

    await undoTaskEvents(mark, task.id, moved.undo, { operation: "undo_change", source: "web" });
    graph.refuseInstancePatch = false;
    await sync();
    assert.deepEqual(graph.onDay(later).map((item) => item.start), [london(later, "14:00")]);
    assert.equal(graph.onDay(third).length, 1);
    assert.equal(graph.onDay(shiftDay(wednesday, 14)).length, 0);
  });

  it("brings an undone skip back as an event", async () => {
    const thursday = nextWeekday(4);
    const task = await repeating("Read", thursday, "11:00", { every: "week" });
    await sync();
    const later = shiftDay(thursday, 7);
    const skipped = await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: later });
    await sync();
    assert.equal(graph.onDay(later).length, 0);
    await undoTaskEvents(mark, task.id, skipped.body.undo, { operation: "undo_change", source: "web" });
    await sync();
    assert.deepEqual(graph.onDay(later).map((item) => item.start), [london(later, "11:00")]);
  });

  it("keeps dates changed one at a time when every date moves, and splits for This and following", async () => {
    const monday = nextWeekday(1);
    const task = await repeating("Team call", monday, "10:00", { every: "week" });
    await sync();
    const second = shiftDay(monday, 14);
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: second });
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: london(monday, "11:00") }, "all", { provenance: DRAG });
    await sync();
    const master = [...graph.masters.values()][0];
    assert.equal(master.at, "11:00");
    assert.equal(graph.onDay(second).length, 0);
    assert.deepEqual(graph.onDay(shiftDay(monday, 7)).map((item) => item.start), [london(shiftDay(monday, 7), "11:00")]);

    const from = shiftDay(monday, 21);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: from }, { dueAt: london(from, "15:00") }, "following", { provenance: DRAG });
    await sync();
    assert.equal(graph.masters.size, 2);
    const [old, split] = [...graph.masters.values()];
    assert.equal(old.recurrence.range.endDate, shiftDay(from, -1));
    assert.equal(split.recurrence.range.startDate, from);
    assert.equal(split.at, "15:00");
    for (let week = 1; week <= 6; week += 1) assert.ok(graph.onDay(shiftDay(monday, week * 7)).length <= 1);
  });

  it("ends, stops and deletes the Outlook series with the task", async () => {
    const friday = nextWeekday(5);
    const ending = await repeating("Report", friday, "16:00", { every: "week" });
    await sync();
    await endSeriesOn(mark, ending.id, shiftDay(friday, 21));
    await sync();
    assert.equal([...graph.masters.values()][0].recurrence.range.endDate, shiftDay(friday, 21));
    await setTaskRepeat(mark, ending.id, null);
    await sync();
    assert.equal(graph.masters.size, 0);

    const deleting = await repeating("Gym", friday, "07:00", { every: "day" });
    await sync();
    assert.equal(graph.masters.size, 1);
    await deleteSeries(mark, deleting.id);
    await sync();
    assert.equal(graph.masters.size, 0);
  });

  it("leaves date-only series out of Outlook", async () => {
    await repeating("Invoice", nextWeekday(2), null, { every: "month", monthDay: 1 });
    await sync();
    assert.equal(graph.masters.size, 0);
  });

  it("keeps Orbit's own series events out of the synced calendar", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating("Check in", tuesday, "14:00", { every: "week" });
    await sync();
    graph.refuseInstancePatch = true;
    const third = shiftDay(tuesday, 14);
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: third }, { dueAt: london(third, "09:00"), dueHasTime: true }, "this", [], DRAG);
    await sync();
    await syncCalendar(mark, { fetchImpl: graph.fetch, force: true });
    const rows = await admin().query<{ provider_event_id: string; task_id: string | null }>("select provider_event_id, task_id from crm.calendar_events where user_id = $1", [mark.userId]);
    assert.deepEqual(rows.rows.filter((row) => !row.task_id), []);
    assert.equal(rows.rows.filter((row) => row.task_id === task.id).length, 1);
  });

  it("queues the series from every route that changes it", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating("Queue", tuesday, "12:00", { every: "week" });
    await sync();
    let seen = (await version(task.seriesId!))!;
    assert.equal(seen.version, seen.settled);
    const changed = async (label: string) => {
      const now = (await version(task.seriesId!))!;
      assert.ok(now.version > seen.version, label);
      seen = now;
    };
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: shiftDay(tuesday, 7) });
    await changed("skip a later date");
    await runTool(mark, "update_task", { seriesId: task.seriesId, occursOn: shiftDay(tuesday, 14), dueAt: london(shiftDay(tuesday, 14), "13:00"), repeatScope: "this" });
    await changed("assistant");
    await updateOccurrence(mark, { taskId: task.id }, { title: "Queue all" }, "all");
    await changed("all");
    await completeTask(mark, task.id);
    await changed("done");
    const open = (await admin().query<{ current_task_id: string }>("select current_task_id from crm.task_series where id = $1", [task.seriesId])).rows[0].current_task_id;
    await skipOccurrence(mark, { taskId: open });
    await changed("skip the open one");
  });

  it("removes the Outlook series when it goes to a teammate as date only", async () => {
    const sam = await createUser(`sam${seq}@series-outlook.test`, "Sam Okafor");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, sam.userId]);
    const tuesday = nextWeekday(2);
    const task = await repeating("Hand over", tuesday, "12:00", { every: "week" });
    await sync();
    assert.equal(graph.masters.size, 1);
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "all");
    await syncSeriesOutlook({ fetchImpl: graph.fetch });
    assert.equal(graph.masters.size, 0);
  });
});
