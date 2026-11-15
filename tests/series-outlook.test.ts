import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { storeGrantedScopes, syncCalendar } from "@/lib/crm/calendar";
import { withActor } from "@/lib/crm/context";
import { disconnectMailbox, saveMailbox } from "@/lib/crm/inbox";
import { masterDraft, seriesRecurrence, syncSeriesOutlook } from "@/lib/crm/series-outlook";
import { createRepeatingTask, deleteSeries, endSeriesOn, rollDueSeries, setTaskRepeat, skipOccurrence, updateOccurrence } from "@/lib/crm/task-series";
import { flushTaskBlocks, syncTaskBlocks } from "@/lib/crm/task-outlook";
import { removeMember } from "@/lib/crm/team";
import { completeTask } from "@/lib/crm/tasks";
import type { Task, UserActor } from "@/lib/crm/types";
import { undoTaskEvents } from "@/lib/crm/undo";
import { moveUpcoming } from "@/lib/crm/upcoming";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import type { GraphEvent } from "@/lib/microsoft/calendar";
import { scopesForRole } from "@/lib/crm/scopes";
import { upcomingAfter, upcomingBetween, type OccurrenceChange, type RepeatEnds, type RepeatRule } from "@/lib/task-repeat";
import { readdirSync, readFileSync } from "node:fs";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { createUser, resetDatabase } from "./helpers";

const WRITE_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read offline_access";
const HOUR = 3_600_000;
const DRAG = { operation: "drag_task", source: "web" };

type Recurrence = {
  pattern: { type: string; interval: number; daysOfWeek?: string[]; dayOfMonth?: number; month?: number; index?: string };
  range: { type: string; startDate: string; endDate?: string };
};
type Master = { subject: string; at: string; minutes: number; recurrence: Recurrence; transactionId: string; key: string | null; body: string; owner?: string };
type Plain = { subject: string; start: string; end: string; transactionId: string; key: string | null; owner?: string };
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

function monthLength(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayOf(year: number, month: number, date: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

const INDEXES = ["first", "second", "third", "fourth"];

function monthlyDay(pattern: Recurrence["pattern"], year: number, month: number) {
  if (pattern.type === "absoluteMonthly" || pattern.type === "absoluteYearly") return dayOf(year, month, Math.min(pattern.dayOfMonth!, monthLength(year, month)));
  const wanted = WEEK_NAMES.indexOf(pattern.daysOfWeek![0]);
  const matches: string[] = [];
  for (let date = 1; date <= monthLength(year, month); date += 1) if (weekdayOf(dayOf(year, month, date)) === wanted) matches.push(dayOf(year, month, date));
  return pattern.index === "last" ? matches[matches.length - 1] : matches[INDEXES.indexOf(pattern.index ?? "first")];
}

function expand(recurrence: Recurrence, limit = 400) {
  const days: string[] = [];
  const { pattern, range } = recurrence;
  const start = range.startDate;
  if (pattern.type === "absoluteMonthly" || pattern.type === "relativeMonthly" || pattern.type === "absoluteYearly") {
    const [startYear, startMonth] = start.split("-").map(Number);
    const yearly = pattern.type === "absoluteYearly";
    for (let step = 0; step < 240 && days.length < limit; step += 1) {
      const offset = step * pattern.interval * (yearly ? 12 : 1);
      const monthIndex = (yearly ? (startYear + step * pattern.interval) * 12 + pattern.month! - 1 : startYear * 12 + startMonth - 1 + offset);
      const day = monthlyDay(pattern, Math.floor(monthIndex / 12), (monthIndex % 12) + 1);
      if (range.endDate && day > range.endDate) break;
      if (day >= start) days.push(day);
    }
    return days;
  }
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
  keepExceptions = false;
  failLogin = false;
  loseCreates = 0;
  losePatches = 0;
  refuseCreate = false;
  refuseTitles = new Set<string>();
  throttleDeletes = false;
  strict = false;
  faultRate = 0;
  faults = { throttled: 0, unavailable: 0, network: 0, afterWrite: 0 };
  random: () => number = Math.random;
  created = 0;
  everCreated = new Map<string, { id: string; at: number }>();
  clock = 0;
  dedupeFor = 40;

  instancesOf(id: string) {
    const master = this.masters.get(id)!;
    return expand(master.recurrence)
      .map((day) => `${id}::${day}`)
      .filter((instance) => !this.deleted.has(instance))
      .map((instance) => {
        const day = instance.split("::")[1];
        const start = fromGraph({ dateTime: `${day}T${master.at}:00`, timeZone: "GMT Standard Time" });
        const own = this.overrides.get(instance);
        return { id: instance, start: own?.start ?? start, end: own?.end ?? new Date(Date.parse(start) + master.minutes * 60_000).toISOString(), subject: own?.subject ?? master.subject, seriesMasterId: id, originalStart: start };
      });
  }

  everything() {
    const items: { id: string; start: string; end: string; subject: string; seriesMasterId?: string; originalStart?: string }[] = [];
    for (const id of this.masters.keys()) items.push(...this.instancesOf(id));
    for (const [id, plain] of this.plains) items.push({ id, start: plain.start, end: plain.end, subject: plain.subject });
    return items;
  }

  onDay(day: string) {
    return this.everything().filter((item) => dayKeyAt(new Date(item.start)) === day);
  }

  graph(item: { id: string; start: string; end: string; subject: string; seriesMasterId?: string; originalStart?: string }): GraphEvent {
    return { id: item.id, subject: item.subject, start: utc(item.start), end: utc(item.end), isAllDay: false, isCancelled: false, showAs: "busy", attendees: [], ...(item.seriesMasterId ? { seriesMasterId: item.seriesMasterId } : {}), ...(item.originalStart ? { originalStart: item.originalStart } : {}) };
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const graph = new URL(String(input)).hostname === "graph.microsoft.com";
    if (graph && this.faultRate > 0 && this.random() < this.faultRate) {
      if ((init?.method ?? "GET") !== "GET" && this.random() < 0.5) {
        this.faults.afterWrite += 1;
        await this.handle(input, init);
      }
      const pick = this.random();
      if (pick < 0.34) {
        this.faults.throttled += 1;
        return new Response(JSON.stringify({ error: { code: "TooManyRequests", message: "Slow down" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
      }
      if (pick < 0.67) {
        this.faults.unavailable += 1;
        return json({ error: { code: "ServiceUnavailable", message: "Busy" } }, 503);
      }
      this.faults.network += 1;
      throw new TypeError("fetch failed");
    }
    return this.handle(input, init);
  }) as typeof fetch;

  handle = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    this.calls.push({ method, url, body });
    const parsed = new URL(url);
    if (parsed.hostname === "login.microsoftonline.com") {
      if (this.failLogin) return json({ error: "temporarily_unavailable" }, 503);
      return json({ access_token: "fresh", refresh_token: "refresh", expires_in: 3600, scope: WRITE_SCOPES });
    }
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    const mine = (item: { owner?: string } | undefined) => Boolean(item) && (!this.strict || item!.owner === auth);
    this.clock += 1;
    const property = (value: Record<string, unknown> | null) =>
      ((value?.singleValueExtendedProperties as { value: string }[] | undefined) ?? [])[0]?.value ?? null;
    if (method === "POST" && parsed.pathname === "/v1.0/me/events" && (this.refuseCreate || this.refuseTitles.has(String(body?.subject)))) return json({ error: { code: "ErrorInvalidRequest", message: "No" } }, 400);
    if (method === "PATCH" && this.losePatches > 0) {
      this.losePatches -= 1;
      const held = this.losePatches;
      this.losePatches = 0;
      await this.handle(input, init);
      this.losePatches = held;
      throw new TypeError("fetch failed");
    }
    if (method === "POST" && parsed.pathname === "/v1.0/me/events" && this.loseCreates > 0) {
      this.loseCreates -= 1;
      const held = this.loseCreates;
      this.loseCreates = 0;
      await this.handle(input, init);
      this.loseCreates = held;
      throw new TypeError("fetch failed");
    }
    if (method === "POST" && parsed.pathname === "/v1.0/me/events") {
      const same = this.everCreated.get(`${this.strict ? auth : ""}|${String(body!.transactionId)}`);
      if (same && this.clock - same.at < this.dedupeFor) return json({ id: same.id }, 201);
      this.created += 1;
      if (body!.recurrence) {
        const id = `master-${this.created}`;
        const start = body!.start as { dateTime: string };
        const end = fromGraph(body!.end);
        const minutes = (Date.parse(end) - Date.parse(fromGraph(body!.start))) / 60_000;
        this.masters.set(id, { subject: String(body!.subject), at: start.dateTime.slice(11, 16), minutes, recurrence: body!.recurrence as Recurrence, transactionId: String(body!.transactionId), key: property(body), body: String((body!.body as { content: string }).content), owner: auth });
        this.everCreated.set(`${this.strict ? auth : ""}|${String(body!.transactionId)}`, { id, at: this.clock });
        return json({ id }, 201);
      }
      const id = `single-${this.created}`;
      this.plains.set(id, { subject: String(body!.subject), start: fromGraph(body!.start), end: fromGraph(body!.end), transactionId: String(body!.transactionId), key: property(body), owner: auth });
      this.everCreated.set(`${this.strict ? auth : ""}|${String(body!.transactionId)}`, { id, at: this.clock });
      return json({ id }, 201);
    }
    if (method === "GET" && parsed.pathname === "/v1.0/me/events") {
      const filter = parsed.searchParams.get("$filter") ?? "";
      const value = /ep\/value eq '([^']+)'/.exec(filter)?.[1];
      const found = [...this.masters, ...this.plains].filter(([, item]) => item.key === value && mine(item)).map(([id]) => ({ id }));
      return json({ value: found });
    }
    const instances = /^\/v1\.0\/me\/events\/([^/]+)\/instances$/.exec(parsed.pathname);
    if (instances && method === "GET") {
      const id = decodeURIComponent(instances[1]);
      if (!mine(this.masters.get(id))) return json({ error: { code: "ErrorItemNotFound" } }, 404);
      const from = Date.parse(parsed.searchParams.get("startDateTime")!);
      const to = Date.parse(parsed.searchParams.get("endDateTime")!);
      return json({ value: this.instancesOf(id).filter((item) => Date.parse(item.start) < to && Date.parse(item.end) > from).map((item) => this.graph(item)) });
    }
    const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(parsed.pathname);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const owned = mine(this.masters.get(id.split("::")[0])) || mine(this.plains.get(id));
      if (!owned && (method === "DELETE" || method === "PATCH")) return json({ error: { code: "ErrorItemNotFound" } }, 404);
      if (id.includes("::") && this.masters.has(id.split("::")[0]) && !expand(this.masters.get(id.split("::")[0])!.recurrence).includes(id.split("::")[1])) {
        return json({ error: { code: "ErrorItemNotFound", message: "Not an occurrence" } }, 404);
      }
      if (method === "DELETE") {
        if (this.throttleDeletes) return new Response(JSON.stringify({ error: { code: "TooManyRequests", message: "Slow down" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
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
          if (!this.keepExceptions) {
            for (const key of [...this.overrides.keys()]) if (key.startsWith(`${id}::`)) this.overrides.delete(key);
            for (const key of [...this.deleted]) if (key.startsWith(`${id}::`)) this.deleted.delete(key);
          }
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

async function connect(actor: UserActor, token = "access") {
  await saveMailbox(actor, { email: `${actor.email}`, refreshToken: "refresh", accessToken: token, expiresAt: new Date(Date.now() + HOUR).toISOString() });
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
    assert.deepEqual(seriesRecurrence({ startsOn: "2027-02-28", at: "09:00", rule: { freq: "yearly", interval: 1, monthDay: 29 }, ends: { never: true } }, "2027-02-28", null, tz).pattern, {
      type: "absoluteYearly",
      interval: 1,
      month: 2,
      dayOfMonth: 29,
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

  it("keeps the Outlook series while Microsoft can't be reached for now, and catches up once it can", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating("Kept", tuesday, "12:00", { every: "week" });
    await sync();
    const masterId = [...graph.masters.keys()][0];
    await admin().query("update crm.mailbox_connections set access_token_expires_at = now() - interval '1 hour' where user_id = $1", [mark.userId]);
    graph.failLogin = true;
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: london(tuesday, "13:00") }, "all");
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal(graph.masters.get(masterId)!.at, "12:00");
    const row = (await admin().query<{ master_id: string | null; version: string; settled_version: string }>("select master_id, version, settled_version from crm.task_series_outlook where series_id = $1", [task.seriesId])).rows[0];
    assert.equal(row.master_id, masterId);
    assert.ok(Number(row.version) > Number(row.settled_version));
    graph.failLogin = false;
    await admin().query("update crm.task_series_outlook set retry_at = null where series_id = $1", [task.seriesId]);
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal(graph.masters.get(masterId)!.at, "13:00");
  });

  it("writes a series made while Microsoft was disconnected once it is connected again", async () => {
    const first = (await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    await flushTaskBlocks(mark, first, WRITE_SCOPES, { fetchImpl: graph.fetch });
    await disconnectMailbox(mark);
    const tuesday = nextWeekday(2);
    await repeating("Made offline", tuesday, "12:00", { every: "week" });
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal(graph.masters.size, 0);
    await saveMailbox(mark, { email: mark.email, refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const connection = (await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    await flushTaskBlocks(mark, connection, WRITE_SCOPES, { fetchImpl: graph.fetch });
    assert.equal(graph.masters.size, 1);
  });

  it("gives the series to the new owner when the previous one disconnected Microsoft", async () => {
    const sam = await createUser(`sam-off${seq}@series-outlook.test`, "Sam Okafor");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, sam.userId]);
    await connect({ ...sam, workspaceId: mark.workspaceId });
    const task = await repeating("Disconnected", nextWeekday(3), "16:00", { every: "week" });
    await sync();
    await disconnectMailbox(mark);
    await admin().query("update crm.task_series set owner_id = $2 where id = $1", [task.seriesId, sam.userId]);
    await syncSeriesOutlook({ fetchImpl: graph.fetch });
    const row = (await admin().query<{ user_id: string | null; version: string; settled_version: string }>("select user_id, version, settled_version from crm.task_series_outlook where series_id = $1", [task.seriesId])).rows[0];
    assert.equal(row.user_id, sam.userId);
    assert.equal(Number(row.version), Number(row.settled_version));
  });

  it("writes a timed This one on a date-only series as its own event", async () => {
    const wednesday = nextWeekday(3);
    const task = await repeating("Plan the week", wednesday, null, { every: "week" });
    const later = shiftDay(wednesday, 7);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "09:30") }, "this", { provenance: DRAG });
    await sync();
    assert.equal(graph.masters.size, 0);
    assert.deepEqual(graph.onDay(later).map((item) => item.start), [london(later, "09:30")]);
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: later });
    await sync();
    assert.equal(graph.onDay(later).length, 0);
  });

  it("creates each plain event with a fresh key, so skip, undo, skip, undo always ends with one event", async () => {
    const thursday = nextWeekday(4);
    const task = await repeating("Again", thursday, "11:00", { every: "week" });
    await sync();
    const later = shiftDay(thursday, 7);
    for (let round = 0; round < 2; round += 1) {
      const skipped = await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: later });
      await sync();
      assert.equal(graph.onDay(later).length, 0);
      await undoTaskEvents(mark, task.id, skipped.body.undo, { operation: "undo_change", source: "web" });
      await sync();
      assert.deepEqual(graph.onDay(later).map((item) => item.start), [london(later, "11:00")]);
    }
  });

  it("patches a kept exception by its stored id after the series changes, so it never doubles", async () => {
    graph.keepExceptions = true;
    const monday = nextWeekday(1);
    const task = await repeating("Kept exception", monday, "10:00", { every: "week" });
    await sync();
    const later = shiftDay(monday, 7);
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(shiftDay(later, 1), "15:00"), dueHasTime: true }, "this", [], DRAG);
    await sync();
    assert.deepEqual(graph.onDay(shiftDay(later, 1)).map((item) => item.start), [london(shiftDay(later, 1), "15:00")]);
    await updateOccurrence(mark, { taskId: task.id }, { title: "Kept exception, renamed" }, "all");
    await sync();
    assert.equal(graph.onDay(later).length, 0);
    assert.equal(graph.onDay(shiftDay(later, 1)).length, 1);
    assert.equal([...graph.plains.values()].filter((plain) => plain.key?.startsWith("series:")).length, 0);
  });

  it("counts Graph writes against the run's budget and picks up the rest next run", async () => {
    const friday = nextWeekday(5);
    const task = await repeating("Budget", friday, "08:00", { every: "week" });
    for (const week of [1, 2, 3]) await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: shiftDay(friday, week * 7) });
    await syncTaskBlocks({ fetchImpl: graph.fetch, userId: mark.userId });
    graph.calls = [];
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId, limit: 2 });
    assert.ok(graph.calls.filter((call) => call.method !== "GET").length <= 2);
    const pending = (await version(task.seriesId!))!;
    assert.ok(pending.version > pending.settled);
    for (let run = 0; run < 5; run += 1) await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId, limit: 2 });
    for (const week of [1, 2, 3]) assert.equal(graph.onDay(shiftDay(friday, week * 7)).length, 0);
    assert.deepEqual(graph.onDay(shiftDay(friday, 28)).map((item) => item.start), [london(shiftDay(friday, 28), "08:00")]);
  });

  it("throttles the person whose mailbox answered 429, not the new owner", async () => {
    const sam = await createUser(`sam-throttle${seq}@series-outlook.test`, "Sam Okafor");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, sam.userId]);
    const tuesday = nextWeekday(2);
    const task = await repeating("Moving", tuesday, "16:00", { every: "week" });
    await sync();
    await admin().query("update crm.task_series set owner_id = $2 where id = $1", [task.seriesId, sam.userId]);
    graph.throttleDeletes = true;
    const throttled = new Set<string>();
    await syncSeriesOutlook({ fetchImpl: graph.fetch, throttled });
    assert.ok(throttled.has(mark.userId));
    assert.equal(throttled.has(sam.userId), false);
  });

  it("redoes every changed date after a series rewrite that a run couldn't finish", async () => {
    const monday = nextWeekday(1);
    const task = await repeating("Rewrite", monday, "09:00", { every: "week" });
    const skipped = [1, 2, 3].map((week) => shiftDay(monday, week * 7));
    for (const date of skipped) await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: date });
    await sync();
    for (const date of skipped) assert.equal(graph.onDay(date).length, 0);
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: london(monday, "09:30") }, "all");
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId, limit: 2 });
    for (let run = 0; run < 4; run += 1) {
      await admin().query("update crm.task_series_outlook set retry_at = null where series_id = $1", [task.seriesId]);
      await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId, limit: 2 });
    }
    for (const date of skipped) assert.equal(graph.onDay(date).length, 0, date);
    assert.deepEqual(graph.onDay(shiftDay(monday, 28)).map((item) => item.start), [london(shiftDay(monday, 28), "09:30")]);
  });

  it("redoes every changed date after a failure part way through a series rewrite", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating("Failing", tuesday, "09:00", { every: "week" });
    const skipped = [1, 2].map((week) => shiftDay(tuesday, week * 7));
    for (const date of skipped) await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: date });
    await sync();
    await updateOccurrence(mark, { taskId: task.id }, { title: "Failing, renamed" }, "all");
    graph.throttleDeletes = true;
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    graph.throttleDeletes = false;
    await admin().query("update crm.task_series_outlook set retry_at = null where series_id = $1", [task.seriesId]);
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    for (const date of skipped) assert.equal(graph.onDay(date).length, 0, date);
  });

  it("gives the series to the new owner when the previous holder removed their Microsoft account", async () => {
    const sam = await createUser(`sam-gone${seq}@series-outlook.test`, "Sam Okafor");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, sam.userId]);
    await connect({ ...sam, workspaceId: mark.workspaceId });
    const task = await repeating("Handed on", nextWeekday(3), "16:00", { every: "week" });
    await sync();
    await admin().query("update crm.task_series set owner_id = $2 where id = $1", [task.seriesId, sam.userId]);
    await admin().query("delete from crm.mailbox_connections where user_id = $1", [mark.userId]);
    await syncSeriesOutlook({ fetchImpl: graph.fetch });
    const row = (await admin().query<{ user_id: string | null; version: string; settled_version: string }>("select user_id, version, settled_version from crm.task_series_outlook where series_id = $1", [task.seriesId])).rows[0];
    assert.equal(row.user_id, sam.userId);
    assert.equal(Number(row.version), Number(row.settled_version));
  });

  it("takes the series out of the Outlook of someone removed from their only workspace", async () => {
    const sam = await createUser(`sam-removed${seq}@series-outlook.test`, "Sam Okafor");
    const samHere: UserActor = { ...sam, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "member", scopes: scopesForRole("member") };
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, sam.userId]);
    await admin().query("delete from crm.workspace_members where user_id = $1 and workspace_id <> $2", [sam.userId, mark.workspaceId]);
    await connect(samHere, `access-${sam.userId}`);
    graph.strict = true;
    await admin().query("update crm.mailbox_connections set access_token = $2 where user_id = $1", [mark.userId, "access-mark"]);
    const task = (await createRepeatingTask(samHere, { title: "Sam's call", dueAt: london(nextWeekday(4), "10:00") }, { every: "week" })).body.task;
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: sam.userId });
    assert.equal([...graph.masters.values()].filter((master) => master.owner === `Bearer access-${sam.userId}`).length, 1);
    await removeMember(mark, sam.userId, { operation: "remove_member" }, { fetchImpl: graph.fetch });
    assert.equal([...graph.masters.values()].filter((master) => master.owner === `Bearer access-${sam.userId}`).length, 0);
    assert.ok(task.seriesId);
  });

  it("queues a date-only series with a timed date when the migration runs", async () => {
    const thursday = nextWeekday(4);
    const task = await repeating("Backfill", thursday, null, { every: "week" });
    const later = shiftDay(thursday, 7);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "10:00") }, "this", { provenance: DRAG });
    await admin().query("delete from crm.task_series_outlook where series_id = $1", [task.seriesId]);
    for (const file of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql") && name >= "20270203200000").sort()) {
      await applyMigrationSql(admin(), readFileSync(`supabase/migrations/${file}`, "utf8"));
    }
    assert.ok(await version(task.seriesId!));
  });
});

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const SEQUENCES = Number(process.env.SERIES_SEQUENCES ?? 300);
const FIRST_SEED = Number(process.env.SERIES_SEED ?? 9100);
const HORIZON_DAYS = 70;

type SeriesTimingRow = {
  id: string;
  owner_id: string;
  title: string;
  starts_on: string;
  at: string | null;
  duration_minutes: number;
  rule: RepeatRule;
  ends: RepeatEnds;
  current_occurs_on: string | null;
  current_due_at: Date | null;
  changes: (OccurrenceChange & { dueAt: string | null })[];
};

function dayStartFor(day: string) {
  return Date.parse(fromGraph({ dateTime: `${day}T00:00:00`, timeZone: "GMT Standard Time" }));
}

async function expectedEvents(owners: string[]) {
  const rows = await admin().query<SeriesTimingRow>(
    `select s.id, s.owner_id, s.title, s.starts_on::text as starts_on, to_char(s.at, 'HH24:MI') as at, s.duration_minutes, s.rule, s.ends,
       t.occurs_on::text as current_occurs_on, t.due_at as current_due_at,
       coalesce((select jsonb_agg(jsonb_build_object('occursOn', c.occurs_on::text, 'skip', c.skip, 'dueAt', c.due_at, 'dueHasTime', c.due_has_time,
         'durationMinutes', c.duration_minutes, 'title', c.title) order by c.occurs_on)
         from crm.task_occurrence_changes c where c.series_id = s.id and (t.occurs_on is null or c.occurs_on > t.occurs_on)), '[]'::jsonb) as changes
     from crm.task_series s
     left join crm.tasks t on t.id = s.current_task_id
     where s.owner_id = any($1::uuid[]) and s.ended_at is null and s.archived_at is null
       and exists (select 1 from crm.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = s.owner_id)`,
    [owners],
  );
  const expected = new Map<string, string[]>(owners.map((person) => [person, []]));
  const horizon = shiftDay(today, HORIZON_DAYS);
  for (const row of rows.rows) {
    const dueAt = row.current_due_at ? new Date(row.current_due_at).toISOString() : null;
    const timing = {
      startsOn: row.starts_on,
      at: row.at,
      rule: row.rule,
      ends: row.ends,
      durationMinutes: row.duration_minutes,
      after: upcomingAfter(row.current_occurs_on, dueAt),
      afterOccurs: row.current_occurs_on,
      changes: row.changes.map((change) => ({ ...change, dueAt: change.dueAt ? new Date(change.dueAt).toISOString() : null })),
    };
    for (const occurrence of upcomingBetween(timing, today, horizon, today)) {
      if (!occurrence.dueHasTime) continue;
      const end = new Date(Date.parse(occurrence.dueAt) + occurrence.durationMinutes * 60_000).toISOString();
      expected.get(row.owner_id)!.push(`${occurrence.dueAt}|${end}|${occurrence.title ?? row.title}`);
    }
  }
  return expected;
}

function actualEvents(fake: FakeGraph, tokens: Map<string, string>) {
  const horizonEnd = dayStartFor(shiftDay(today, HORIZON_DAYS + 1));
  const todayStart = dayStartFor(today);
  const actual = new Map<string, string[]>([...tokens.keys()].map((person) => [person, []]));
  const ownerOf = new Map([...tokens].map(([person, token]) => [`Bearer ${token}`, person]));
  const push = (auth: string | undefined, start: string, end: string, subject: string) => {
    const person = ownerOf.get(auth ?? "");
    if (!person || Date.parse(start) >= horizonEnd || Date.parse(start) < todayStart) return;
    actual.get(person)!.push(`${start}|${end}|${subject}`);
  };
  for (const [id, master] of fake.masters) for (const item of fake.instancesOf(id)) push(master.owner, item.start, item.end, item.subject);
  for (const plain of fake.plains.values()) if (plain.key?.startsWith("series:")) push(plain.owner, plain.start, plain.end, plain.subject);
  return actual;
}

async function dueDayOf(taskId: string) {
  const row = await admin().query<{ due_at: Date | null }>("select due_at from crm.tasks where id = $1", [taskId]);
  const due = row.rows[0]?.due_at;
  return due ? dayKeyAt(new Date(due)) : today;
}

describe("repeating tasks in Outlook, random sequences", () => {
  it(`keeps each owner's Outlook exactly in step with their series across ${SEQUENCES} random sequences`, { timeout: 3_600_000 }, async () => {
    const owner = await createUser("random-owner@series-outlook.test", "Ola Owner");
    const teammate: UserActor = { ...(await createUser("random-mate@series-outlook.test", "Tom Mate")), workspaceId: owner.workspaceId, workspaceName: owner.workspaceName, role: "member", scopes: scopesForRole("member") };
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, teammate.userId]);
    const people = [owner, teammate];
    const tokens = new Map(people.map((person) => [person.userId, `access-${person.userId}`]));
    const totals = { afterWrite: 0, throttled: 0, unavailable: 0, network: 0, budgetCuts: 0, timeStops: 0, operations: 0, refused: 0, workerRuns: 0, keptExceptions: 0 };
    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      const seed = FIRST_SEED + sequence;
      const random = seeded(seed);
      const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
      const fake = new FakeGraph();
      fake.strict = true;
      fake.random = random;
      fake.keepExceptions = random() < 0.5;
      if (fake.keepExceptions) totals.keptExceptions += 1;
      await admin().query("update crm.task_series set archived_at = now() where archived_at is null");
      await admin().query("update crm.tasks set archived_at = now() where archived_at is null");
      await admin().query("delete from crm.task_series_outlook");
      await admin().query("delete from crm.calendars where user_id = any($1::uuid[])", [[...tokens.keys()]]);
      await admin().query("delete from crm.mailbox_connections where user_id = any($1::uuid[])", [[...tokens.keys()]]);
      for (const person of people) await connect(person, tokens.get(person.userId)!);
      const log: string[] = [];
      const series: { id: string; creator: UserActor }[] = [];
      const undo: { actor: UserActor; taskId: string; events: string[] }[] = [];
      const stateOf = async (id: string) =>
        (await admin().query<{ current_task_id: string | null; owner_id: string | null }>("select current_task_id, owner_id from crm.task_series where id = $1", [id])).rows[0];
      const laterDate = () => shiftDay(today, 1 + Math.floor(random() * 30));
      const hour = () => `${String(8 + Math.floor(random() * 9)).padStart(2, "0")}:${random() < 0.5 ? "00" : "30"}`;
      const runWorker = async () => {
        totals.workerRuns += 1;
        fake.faultRate = random() < 0.7 ? 0.05 + random() * 0.35 : 0;
        const limit = random() < 0.4 ? 1 + Math.floor(random() * 4) : 50;
        if (limit < 50) totals.budgetCuts += 1;
        const short = random() < 0.15;
        if (short) totals.timeStops += 1;
        await syncSeriesOutlook({ fetchImpl: fake.fetch, limit, deadline: Date.now() + (short ? 4_000 + Math.floor(random() * 15) : 20_000) });
        fake.faultRate = 0;
      };
      const steps = 5 + Math.floor(random() * 11);
      for (let step = 0; step < steps; step += 1) {
        totals.operations += 1;
        const live = series.length > 0 ? pick(series) : null;
        const choice = !live ? "create" : pick(["create", "move", "move", "skip", "skip", "undo", "all", "following", "stop", "end", "delete", "done", "roll", "owner", "unlink", "worker", "worker"]);
        let note: string = choice;
        try {
          if (choice === "create") {
            if (series.length >= 3) note = "create (enough)";
            else {
              const actor = pick(people);
              const timed = random() < 0.75;
              const start = shiftDay(today, Math.floor(random() * 5));
              const interval = random() < 0.3 ? { interval: 2 } : {};
              const kind = random();
              const repeat =
                kind < 0.35
                  ? { every: "day", ...interval }
                  : kind < 0.7
                    ? { every: "week", days: [...new Set([pick(["mo", "tu", "we", "th", "fr"]), pick(["sa", "su", "we"])])], ...interval }
                    : kind < 0.8
                      ? { every: "month", monthDay: pick([1, 15, 29, 30, 31]) }
                      : kind < 0.9
                        ? { every: "month", monthWeek: { n: pick([1, 2, -1]), weekday: pick(["mo", "fr"]) } }
                        : { every: "year" };
              const ends = random() < 0.25 ? { ends: { after: 3 + Math.floor(random() * 6) } } : random() < 0.2 ? { ends: { on: shiftDay(today, 10 + Math.floor(random() * 20)) } } : {};
              const at = hour();
              const made = (await createRepeatingTask(actor, { title: `S${series.length} ${seed}`, ...(timed ? { dueAt: london(start, at) } : { dueDate: start }) }, { ...repeat, ...ends })).body.task;
              series.push({ id: made.seriesId!, creator: actor });
              note = `create ${actor === owner ? "owner" : "mate"} ${timed ? at : "date only"} ${JSON.stringify({ ...repeat, ...ends })} from ${start}`;
            }
          } else if (live) {
            const state = await stateOf(live.id);
            const actor = people.find((person) => person.userId === state?.owner_id) ?? live.creator;
            const current = state?.current_task_id ?? null;
            note = `${choice} on ${series.indexOf(live)}`;
            if (choice === "move") {
              const date = laterDate();
              const target = random() < 0.4 ? shiftDay(date, random() < 0.5 ? 1 : 2) : date;
              const at = hour();
              note += ` ${date} to ${target} ${at}`;
              const result = await updateOccurrence(actor, { seriesId: live.id, occursOn: date }, { dueAt: london(target, at) }, "this");
              undo.push({ actor, taskId: result.body.task.id, events: result.body.undo });
            } else if (choice === "skip") {
              const date = laterDate();
              note += ` ${date}`;
              const result = await skipOccurrence(actor, { seriesId: live.id, occursOn: date });
              undo.push({ actor, taskId: result.body.task.id, events: result.body.undo });
            } else if (choice === "undo") {
              const last = undo.pop();
              if (last) await undoTaskEvents(last.actor, last.taskId, last.events, { operation: "undo_change", source: "web" });
              else note += " (nothing)";
            } else if (choice === "all" && current) {
              const kind = pick(["time", "title", "pattern"]);
              note += ` ${kind}`;
              if (kind === "time") await updateOccurrence(actor, { taskId: current }, { dueAt: london(await dueDayOf(current), hour()) }, "all");
              else if (kind === "title") await updateOccurrence(actor, { taskId: current }, { title: `R${step} ${seed}` }, "all");
              else await setTaskRepeat(actor, current, random() < 0.5 ? { every: "day" } : { every: "week", days: [pick(["mo", "we", "fr"])] });
            } else if (choice === "following") {
              const date = laterDate();
              note += ` ${date}`;
              await updateOccurrence(actor, { seriesId: live.id, occursOn: date }, { dueAt: london(date, hour()) }, "following");
              const split = (await admin().query<{ id: string }>("select id from crm.task_series where split_from_id = $1 and archived_at is null order by created_at desc limit 1", [live.id])).rows[0];
              if (split && !series.some((item) => item.id === split.id)) series.push({ id: split.id, creator: actor });
            } else if (choice === "stop" && current) await setTaskRepeat(actor, current, null);
            else if (choice === "end" && current) {
              const date = laterDate();
              note += ` ${date}`;
              await endSeriesOn(actor, current, date);
            } else if (choice === "delete" && current) {
              const result = await deleteSeries(actor, current);
              undo.push({ actor, taskId: result.body.task.id, events: result.body.undo });
            } else if (choice === "done" && current) await completeTask(actor, current);
            else if (choice === "roll") {
              const days = 1 + Math.floor(random() * 3);
              note += ` +${days}d`;
              await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.now() + days * 86_400_000 });
            } else if (choice === "owner") {
              const next = people.find((person) => person.userId !== state?.owner_id)!;
              note += ` to ${next === owner ? "owner" : "mate"}`;
              await admin().query("update crm.task_series set owner_id = $2 where id = $1", [live.id, next.userId]);
            } else if (choice === "unlink") {
              const person = pick(people);
              note += ` ${person === owner ? "owner" : "mate"}`;
              await disconnectMailbox(person);
            } else if (choice === "worker") await runWorker();
            else note += " (nothing)";
          }
        } catch (error) {
          totals.refused += 1;
          note += ` refused: ${(error as Error).message.slice(0, 70)}`;
        }
        log.push(note);
        if (random() < 0.6) await runWorker();
      }
      for (let round = 0; round < 40; round += 1) {
        await admin().query("update crm.task_series_outlook set retry_at = null, claimed_at = null, create_sent_at = create_sent_at - interval '10 minutes'");
        await syncSeriesOutlook({ fetchImpl: fake.fetch, limit: 500, deadline: Date.now() + 60_000 });
        const left = await admin().query("select 1 from crm.task_series_outlook where version > settled_version");
        if (left.rows.length === 0) break;
      }
      const pending = await admin().query("select series_id from crm.task_series_outlook where version > settled_version");
      const linked = (await admin().query<{ user_id: string }>("select user_id from crm.mailbox_connections where user_id = any($1::uuid[]) and status = 'connected'", [[...tokens.keys()]])).rows.map((row) => row.user_id);
      const expected = await expectedEvents(linked);
      const actual = actualEvents(fake, tokens);
      const failure: string[] = [];
      if (pending.rows.length > 0) failure.push(`${pending.rows.length} series never settled`);
      for (const person of linked) {
        const want = [...(expected.get(person) ?? [])].sort();
        const have = [...(actual.get(person) ?? [])].sort();
        if (JSON.stringify(want) !== JSON.stringify(have)) {
          const missing = want.filter((item) => !have.includes(item));
          const extra = have.filter((item) => !want.includes(item));
          failure.push(`${person === owner.userId ? "owner" : "mate"}: missing ${JSON.stringify(missing.slice(0, 4))} extra ${JSON.stringify(extra.slice(0, 4))} (${missing.length}/${extra.length})${missing.length + extra.length === 0 ? ` want ${JSON.stringify(want)} have ${JSON.stringify(have)}` : ""}`);
        }
      }
      totals.throttled += fake.faults.throttled;
      totals.unavailable += fake.faults.unavailable;
      totals.network += fake.faults.network;
      totals.afterWrite += fake.faults.afterWrite;
      const state = failure.length > 0 ? (await admin().query("select o.series_id, s.owner_id, s.at, s.archived_at, s.ended_at, o.user_id, o.master_id, o.create_key, o.version, o.settled_version, o.waiting, o.retry_at, o.dates from crm.task_series_outlook o join crm.task_series s on s.id = o.series_id")).rows : [];
      assert.deepEqual(failure, [], `seed ${seed} (keep exceptions ${fake.keepExceptions}):\n${log.join("\n")}\n${JSON.stringify(state)}\nmasters ${JSON.stringify([...fake.masters].map(([id, master]) => [id, master.owner, master.subject]))}\ncalls ${process.env.SERIES_DEBUG ? JSON.stringify(fake.calls.filter((call) => call.url.includes(process.env.SERIES_DEBUG!) || call.method === "POST").map((call) => `${call.method} ${call.url.slice(40, 100)}`)) : ""}`);
    }
    console.log(`series sequences ${SEQUENCES}`, JSON.stringify(totals));
  });
});

describe("Outlook review fixes", () => {
  it("finishes a rewrite with more changed dates than one run can write", async () => {
    const monday = nextWeekday(1);
    const task = await repeating("Many moves", monday, "09:00", { every: "week" });
    await sync();
    const dates = [1, 2, 3, 4, 5].map((week) => shiftDay(monday, week * 7));
    for (const date of dates) await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: date }, { dueAt: london(date, "16:00"), dueHasTime: true }, "this", [], DRAG);
    await sync();
    await completeTask(mark, task.id);
    for (let run = 0; run < 30; run += 1) {
      await admin().query("update crm.task_series_outlook set retry_at = null where series_id = $1", [task.seriesId]);
      await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId, limit: 3 });
    }
    for (const date of dates.slice(1)) assert.deepEqual(graph.onDay(date).map((item) => item.start), [london(date, "16:00")], date);
    const settled = (await version(task.seriesId!))!;
    assert.equal(settled.version, settled.settled);
  });

  it("finds and removes an event Graph made but Orbit never heard back about", async () => {
    const wednesday = nextWeekday(3);
    const task = await repeating("Lost answer", wednesday, "14:00", { every: "week" });
    await sync();
    const later = shiftDay(wednesday, 7);
    graph.refuseInstancePatch = true;
    graph.loseCreates = 2;
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "09:00"), dueHasTime: true }, "this", [], DRAG);
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal(graph.plains.size > 0, true);
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: later });
    await admin().query("update crm.task_series_outlook set retry_at = null where series_id = $1", [task.seriesId]);
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal(graph.onDay(later).length, 0);

    graph.loseCreates = 2;
    const lost = await repeating("Lost master", nextWeekday(4), "11:00", { every: "week" });
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal([...graph.masters.values()].filter((master) => master.subject === "Lost master").length, 1);
    await deleteSeries(mark, lost.id);
    await admin().query("update crm.task_series_outlook set retry_at = null, create_sent_at = create_sent_at - interval '10 minutes' where series_id = $1", [lost.seriesId]);
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal([...graph.masters.values()].filter((master) => master.subject === "Lost master").length, 0);
  });

  it("stops retrying a series Outlook refuses until it changes again", async () => {
    graph.refuseCreate = true;
    const task = await repeating("Refused", nextWeekday(2), "10:00", { every: "week" });
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    const row = (await admin().query<{ version: string; settled_version: string; retry_at: Date | null }>("select version, settled_version, retry_at from crm.task_series_outlook where series_id = $1", [task.seriesId])).rows[0];
    assert.equal(Number(row.version), Number(row.settled_version));
    assert.equal(row.retry_at, null);
  });

  it("counts every Graph request against the run's budget", async () => {
    const friday = nextWeekday(5);
    const task = await repeating("Budgeted", friday, "08:00", { every: "week" });
    for (const week of [1, 2, 3]) await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: shiftDay(friday, week * 7) });
    graph.calls = [];
    const run = await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId, limit: 3 });
    assert.ok(graph.calls.filter((call) => new URL(call.url).hostname === "graph.microsoft.com").length <= 3);
    assert.ok(run.requests <= 3);
  });

  it("claims a row held only by a pending creation for that person", async () => {
    const task = await repeating("Pending key", nextWeekday(2), "10:00", { every: "week" });
    await admin().query("update crm.task_series_outlook set create_key = gen_random_uuid(), create_user_id = $2, user_id = null where series_id = $1", [task.seriesId, mark.userId]);
    const sam = await createUser(`sam-claim${seq}@series-outlook.test`, "Sam Okafor");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, sam.userId]);
    await admin().query("update crm.task_series set owner_id = $2 where id = $1", [task.seriesId, sam.userId]);
    const claimed = await getPool().query("select series_id from private.claim_series_outlook(null, $1::uuid, 10)", [mark.userId]);
    assert.ok(claimed.rows.some((row: { series_id: string }) => row.series_id === task.seriesId));
  });

  it("writes a time zone Graph can't name in UTC rather than as a wrong wall time", () => {
    const draft = masterDraft("00000000-0000-4000-8000-000000000001", {
      startDay: "2027-01-04",
      at: "09:00",
      durationMinutes: 30,
      title: "Zone",
      link: null,
      recurrence: seriesRecurrence({ startsOn: "2027-01-04", at: "09:00", rule: { freq: "daily", interval: 1 }, ends: { never: true } }, "2027-01-04", null, "Antarctica/Troll"),
    }, "key", "Antarctica/Troll");
    assert.equal(draft.start.timeZone, "UTC");
    assert.equal(draft.recurrence.range.recurrenceTimeZone, "UTC");
  });
});

describe("Outlook whole-review fixes", () => {
  async function soleMember(name: string, role: "member" | "admin") {
    const person = await createUser(`${name}${seq}@series-outlook.test`, "Sam Okafor");
    const here: UserActor = { ...person, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, person.userId, role]);
    await admin().query("delete from crm.workspace_members where user_id = $1 and workspace_id <> $2", [person.userId, mark.workspaceId]);
    await connect(here, `access-${person.userId}`);
    await admin().query("update crm.mailbox_connections set access_token = $2 where user_id = $1", [mark.userId, "access-mark"]);
    graph.strict = true;
    return here;
  }

  const mastersOf = (actor: UserActor) => [...graph.masters.values()].filter((master) => master.owner === `Bearer access-${actor.userId}`);

  it("keeps the series' Outlook ids through a disconnect, so reconnecting never doubles it and a delete made meanwhile still reaches Outlook", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating("Reconnected", tuesday, "12:00", { every: "week" });
    const gone = await repeating("Deleted offline", nextWeekday(3), "15:00", { every: "week" });
    await sync();
    await disconnectMailbox(mark);
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: london(tuesday, "13:00") }, "all");
    await deleteSeries(mark, gone.id);
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    await saveMailbox(mark, { email: mark.email, refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const connection = (await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    await flushTaskBlocks(mark, connection, WRITE_SCOPES, { fetchImpl: graph.fetch });
    assert.deepEqual([...graph.masters.values()].map((master) => [master.subject, master.at]), [["Reconnected", "13:00"]]);
  });

  it("sends nothing to Outlook when a removal is refused", async () => {
    const sam = await soleMember("sam-refused", "admin");
    const rita = await createUser(`rita-refused${seq}@series-outlook.test`, "Rita Gomez");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [mark.workspaceId, rita.userId]);
    const ritaHere: UserActor = { ...rita, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "admin", scopes: scopesForRole("admin") };
    const task = (await createRepeatingTask(sam, { title: "Sam's review", dueAt: london(nextWeekday(4), "10:00") }, { every: "week" })).body.task;
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: sam.userId });
    await assert.rejects(removeMember(ritaHere, sam.userId, { operation: "remove_member" }, { fetchImpl: graph.fetch }), /Only the owner can remove an admin/);
    assert.equal(mastersOf(sam).length, 1);
    const row = (await admin().query<{ claimed_at: Date | null }>("select claimed_at from crm.task_series_outlook where series_id = $1", [task.seriesId])).rows[0];
    assert.equal(row.claimed_at, null);
  });

  it("puts the master and a moved date back when a change whose answer was lost is undone", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating("Lost patch", tuesday, "14:00", { every: "week" });
    const later = shiftDay(tuesday, 7);
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "16:00"), dueHasTime: true }, "this", [], DRAG);
    await sync();
    const masterId = [...graph.masters.keys()][0];
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: london(tuesday, "15:00") }, "all");
    graph.losePatches = 2;
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal(graph.masters.get(masterId)!.at, "15:00");
    await updateOccurrence(mark, { taskId: task.id }, { dueAt: london(tuesday, "14:00") }, "all");
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.equal(graph.masters.get(masterId)!.at, "14:00");
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "17:00"), dueHasTime: true }, "this", [], DRAG);
    graph.losePatches = 2;
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "16:00"), dueHasTime: true }, "this", [], DRAG);
    await admin().query("update crm.task_series_outlook set retry_at = null where series_id = $1", [task.seriesId]);
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: mark.userId });
    assert.deepEqual(graph.onDay(later).map((item) => item.start), [london(later, "16:00")]);
  });

  it("doesn't park a change made during a failing run behind the back-off", async () => {
    const task = await repeating("Changed meanwhile", nextWeekday(5), "10:00", { every: "week" });
    let changed = false;
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname !== "graph.microsoft.com") return graph.fetch(input, init);
      if (!changed) {
        changed = true;
        await updateOccurrence(mark, { taskId: task.id }, { title: "Changed meanwhile, renamed" }, "all");
      }
      return json({ error: { code: "ServiceUnavailable", message: "Busy" } }, 503);
    }) as typeof fetch;
    await syncSeriesOutlook({ fetchImpl: failing, userId: mark.userId });
    const row = (await admin().query<{ retry_at: Date | null; attempts: number }>("select retry_at, attempts from crm.task_series_outlook where series_id = $1", [task.seriesId])).rows[0];
    assert.equal(row.retry_at, null);
    assert.equal(row.attempts, 0);
  });

  it("hands a series to the new owner while the previous holder's Outlook is read only", async () => {
    const sam = await createUser(`sam-read${seq}@series-outlook.test`, "Sam Okafor");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, sam.userId]);
    await connect({ ...sam, workspaceId: mark.workspaceId });
    const task = await repeating("Read only", nextWeekday(3), "16:00", { every: "week" });
    await sync();
    const connection = (await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    await withActor(mark, (db) => storeGrantedScopes(db, mark, connection, "https://graph.microsoft.com/Calendars.Read offline_access"));
    await admin().query("update crm.task_series set owner_id = $2 where id = $1", [task.seriesId, sam.userId]);
    await syncSeriesOutlook({ fetchImpl: graph.fetch });
    const row = (await admin().query<{ user_id: string | null; version: string; settled_version: string }>("select user_id, version, settled_version from crm.task_series_outlook where series_id = $1", [task.seriesId])).rows[0];
    assert.equal(row.user_id, sam.userId);
    assert.equal(Number(row.version), Number(row.settled_version));
  });

  it("takes a master whose create answer was lost out of the Outlook of someone removed from their only workspace", async () => {
    const sam = await soleMember("sam-lost", "member");
    graph.loseCreates = 2;
    await createRepeatingTask(sam, { title: "Sam's lost call", dueAt: london(nextWeekday(4), "10:00") }, { every: "week" });
    await syncSeriesOutlook({ fetchImpl: graph.fetch, userId: sam.userId });
    assert.equal(mastersOf(sam).length, 1);
    await removeMember(mark, sam.userId, { operation: "remove_member" }, { fetchImpl: graph.fetch });
    assert.equal(mastersOf(sam).length, 0);
  });

  it("points a plain date event at the new open task after Done", async () => {
    const wednesday = nextWeekday(3);
    const task = await repeating("Linked", wednesday, null, { every: "week" });
    const later = shiftDay(wednesday, 14);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "09:30") }, "this", { provenance: DRAG });
    await sync();
    const single = [...graph.plains.keys()].find((id) => graph.plains.get(id)!.key?.startsWith("series:"))!;
    await completeTask(mark, task.id);
    const next = (await admin().query<{ current_task_id: string }>("select current_task_id from crm.task_series where id = $1", [task.seriesId])).rows[0].current_task_id;
    graph.calls = [];
    await sync();
    const patch = graph.calls.find((call) => call.method === "PATCH" && call.url.endsWith(`/${single}`));
    assert.match(JSON.stringify(patch?.body ?? null), new RegExp(next));
  });

  it("writes the other changed dates when Outlook refuses one", async () => {
    graph.refuseInstancePatch = true;
    const monday = nextWeekday(1);
    const task = await repeating("Refusals", monday, "09:00", { every: "week" });
    await sync();
    const first = shiftDay(monday, 7);
    const second = shiftDay(monday, 14);
    graph.refuseTitles.add("Refused date");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: first }, { title: "Refused date" }, "this");
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: second }, { dueAt: london(second, "16:00"), dueHasTime: true }, "this", [], DRAG);
    await sync();
    assert.deepEqual(graph.onDay(second).map((item) => item.start), [london(second, "16:00")]);
  });

  it("still writes task blocks when the repeating tasks' Outlook sync fails", async () => {
    const tuesday = nextWeekday(2);
    await repeating("Blocks", tuesday, "10:00", { every: "week" });
    const connection = (await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    await admin().query("revoke execute on function private.claim_series_outlook(uuid[], uuid, integer) from crm_app");
    try {
      await flushTaskBlocks(mark, connection, WRITE_SCOPES, { fetchImpl: graph.fetch });
    } finally {
      await admin().query("grant execute on function private.claim_series_outlook(uuid[], uuid, integer) to crm_app");
    }
    assert.equal(graph.onDay(tuesday).length, 1);
  });

  it("leaves a series' back-off alone when the calendar syncs", async () => {
    const task = await repeating("Backing off", nextWeekday(4), "10:00", { every: "week" });
    const connection = (await admin().query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    await flushTaskBlocks(mark, connection, WRITE_SCOPES, { fetchImpl: graph.fetch });
    await updateOccurrence(mark, { taskId: task.id }, { title: "Backing off, renamed" }, "all");
    await admin().query("update crm.task_series_outlook set retry_at = now() + interval '30 minutes', attempts = 3 where series_id = $1", [task.seriesId]);
    await flushTaskBlocks(mark, connection, WRITE_SCOPES, { fetchImpl: graph.fetch });
    const row = (await admin().query<{ retry_at: Date | null; attempts: number }>("select retry_at, attempts from crm.task_series_outlook where series_id = $1", [task.seriesId])).rows[0];
    assert.ok(row.retry_at);
    assert.equal(row.attempts, 3);
  });

  it("gives a master on a clock change day an end after its start", () => {
    const draft = masterDraft("00000000-0000-4000-8000-000000000002", {
      startDay: "2027-10-31",
      at: "01:30",
      durationMinutes: 30,
      title: "Clocks",
      link: null,
      recurrence: seriesRecurrence({ startsOn: "2027-10-31", at: "01:30", rule: { freq: "daily", interval: 1 }, ends: { never: true } }, "2027-10-31", null),
    }, "key");
    assert.equal(draft.start.dateTime, "2027-10-31T01:30:00");
    assert.equal(draft.end.dateTime, "2027-10-31T02:00:00");
  });
});
