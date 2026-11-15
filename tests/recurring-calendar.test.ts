import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/booking/rules";
import { loadBusy, saveBookingPage } from "@/lib/booking/pages";
import { seriesBusy } from "@/lib/booking/slots";
import { buildPlan } from "@/lib/crm/plan-schedule";
import { packPlan } from "@/lib/crm/plan-tasks";
import { scopesForRole } from "@/lib/crm/scopes";
import { readPlanner } from "@/lib/crm/task-blocks";
import { createRepeatingTask, skipOccurrence } from "@/lib/crm/task-series";
import { createTask, getTask } from "@/lib/crm/tasks";
import type { Task, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { undoTaskEvents } from "@/lib/crm/undo";
import { moveUpcoming } from "@/lib/crm/upcoming";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { upcomingBlocks } from "@/lib/task-blocks";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

let mark: UserActor;
let sam: UserActor;

const today = dayKeyAt(new Date());

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

function london(day: string, time: string) {
  return new Date(`${day}T${time}:00Z`).toISOString();
}

function nextWeekday(index: number, from = shiftDay(today, 1)) {
  let day = from;
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== index) day = shiftDay(day, 1);
  return day;
}

async function repeating(actor: UserActor, title: string, day: string, time: string | null, repeat: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Task> {
  const timing = time ? { dueAt: london(day, time) } : { dueDate: day };
  return (await createRepeatingTask(actor, { title, ...timing, ...extra }, repeat)).body.task;
}

async function seriesRow(id: string) {
  const [row] = await sql<{ at: string | null; ends: Record<string, unknown>; ended_at: Date | null }>(
    "select to_char(at, 'HH24:MI') as at, ends, ended_at from crm.task_series where id = $1",
    [id],
  );
  return row;
}

async function changeRows(seriesId: string) {
  return sql<{ occurs_on: string; due_at: Date | null; skip: boolean }>(
    "select occurs_on::text as occurs_on, due_at, skip from crm.task_occurrence_changes where series_id = $1 order by occurs_on",
    [seriesId],
  );
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@recur3.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@recur3.test", "Sam Okafor"), "member");
  setLiveTesting({ batch: async () => undefined });
});

beforeEach(async () => {
  await sql("update crm.task_series set archived_at = now() where archived_at is null");
  await sql("update crm.tasks set archived_at = now() where archived_at is null");
});

after(async () => {
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("repeating tasks on the Calendar", () => {
  useServerlessPool();

  it("reads only the viewer's own series and draws every later date, never the open one twice", async () => {
    const tuesday = nextWeekday(2);
    const walk = await repeating(mark, "Walk the dog", tuesday, "14:00", { every: "day" });
    const theirs = await repeating(sam, "Sam's stand-up", tuesday, "09:30", { every: "day" });
    await repeating(mark, "Review", nextWeekday(5), null, { every: "week", interval: 2, days: ["fr"] });
    await skipOccurrence(mark, { seriesId: walk.seriesId!, occursOn: shiftDay(tuesday, 2) });

    const planner = await readPlanner(mark);
    const ids = planner.series.map((item) => item.id);
    assert.ok(ids.includes(walk.seriesId!));
    assert.equal(ids.includes(theirs.seriesId!), false);
    assert.equal(JSON.stringify(planner).includes("Sam's stand-up"), false);

    const blocks = upcomingBlocks(planner.series, { viewerId: mark.userId, from: tuesday, to: shiftDay(tuesday, 6), today });
    const walks = blocks.filter((block) => block.title === "Walk the dog");
    assert.deepEqual(
      walks.map((block) => block.upcoming?.occursOn),
      [1, 3, 4, 5, 6].map((offset) => shiftDay(tuesday, offset)),
    );
    assert.ok(walks.every((block) => block.task.dueHasTime && !block.done && block.durationMinutes === 15));
    assert.equal(walks[0].startsAt, london(shiftDay(tuesday, 1), "14:00"));
    assert.equal(blocks.find((block) => block.title === "Review")?.task.dueHasTime ?? false, false);

    const samPlanner = await readPlanner(sam);
    assert.deepEqual(samPlanner.series.map((item) => item.id), [theirs.seriesId]);
  });

  it("keeps a series handed to a teammate off the creator's calendar", async () => {
    const handed = await repeating(mark, "Their report", nextWeekday(3), null, { every: "week" }, { ownerId: sam.userId });
    assert.equal(handed.ownerId, sam.userId);
    assert.equal((await readPlanner(mark)).series.some((item) => item.id === handed.seriesId), false);
    assert.equal((await readPlanner(sam)).series.some((item) => item.id === handed.seriesId), true);
  });

  it("lists upcoming dates in list_calendar_events", async () => {
    const monday = nextWeekday(1);
    const call = await repeating(mark, "Team call", monday, "10:00", { every: "week", days: ["mo"] });
    const result = (await runTool(mark, "list_calendar_events", { from: monday, to: shiftDay(monday, 14) })) as {
      taskBlocks: { id?: string; upcoming?: boolean; seriesId?: string; occursOn?: string; start?: string }[];
    };
    const upcoming = result.taskBlocks.filter((block) => block.upcoming);
    assert.deepEqual(upcoming.map((block) => block.occursOn), [shiftDay(monday, 7), shiftDay(monday, 14)]);
    assert.ok(upcoming.every((block) => block.seriesId === call.seriesId && !block.id));
    assert.equal(result.taskBlocks.filter((block) => block.id === call.id).length, 1);
  });
});

describe("moving an upcoming date", () => {
  useServerlessPool();

  it("moves This one, then This and following in its place, and Undo puts it back", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating(mark, "Check in", tuesday, "14:00", { every: "week" });
    const target = { seriesId: task.seriesId!, occursOn: shiftDay(tuesday, 7) };
    const provenance = { operation: "drag_task", source: "web" };
    const one = await moveUpcoming(mark, target, { dueAt: london(target.occursOn, "15:30"), dueHasTime: true }, "this", [], provenance);
    assert.deepEqual((await changeRows(task.seriesId!)).map((row) => [row.occurs_on, new Date(row.due_at!).toISOString()]), [[target.occursOn, london(target.occursOn, "15:30")]]);
    assert.equal((await seriesRow(task.seriesId!)).at, "14:00");
    assert.ok(one.undo.length > 0);

    const following = await moveUpcoming(mark, target, { dueAt: london(target.occursOn, "15:30"), dueHasTime: true }, "following", one.undo, provenance);
    assert.deepEqual(await changeRows(task.seriesId!), []);
    assert.deepEqual((await seriesRow(task.seriesId!)).ends, { until: shiftDay(target.occursOn, -1) });
    const [split] = await sql<{ id: string; at: string; starts_on: string }>(
      "select id, to_char(at, 'HH24:MI') as at, starts_on::text as starts_on from crm.task_series where split_from_id = $1",
      [task.seriesId],
    );
    assert.deepEqual([split.at, split.starts_on], ["15:30", target.occursOn]);

    await undoTaskEvents(mark, task.id, following.undo, { operation: "undo_change", source: "web" });
    assert.deepEqual((await seriesRow(task.seriesId!)).ends, { never: true });
    assert.deepEqual(await changeRows(task.seriesId!), []);
  });

  it("moves All in place of This one, the open task included", async () => {
    const wednesday = nextWeekday(3);
    const task = await repeating(mark, "Walk", wednesday, "14:00", { every: "week" });
    const target = { seriesId: task.seriesId!, occursOn: shiftDay(wednesday, 7) };
    const provenance = { operation: "drag_task", source: "web" };
    const one = await moveUpcoming(mark, target, { dueAt: london(target.occursOn, "16:00"), dueHasTime: true }, "this", [], provenance);
    const all = await moveUpcoming(mark, target, { dueAt: london(target.occursOn, "16:00"), dueHasTime: true }, "all", one.undo, provenance);
    assert.equal((await seriesRow(task.seriesId!)).at, "16:00");
    assert.deepEqual(await changeRows(task.seriesId!), []);
    assert.equal((await getTask(mark, task.id)).dueAt, london(wednesday, "16:00"));
    assert.equal(all.task.id, task.id);
  });

  it("resizes This one without moving it", async () => {
    const thursday = nextWeekday(4);
    const task = await repeating(mark, "Read", thursday, "11:00", { every: "week" });
    const target = { seriesId: task.seriesId!, occursOn: shiftDay(thursday, 7) };
    await moveUpcoming(mark, target, { durationMinutes: 45 }, "this", [], { operation: "drag_task", source: "web" });
    const [row] = await sql<{ duration_minutes: number; due_at: Date | null }>(
      "select duration_minutes, due_at from crm.task_occurrence_changes where series_id = $1",
      [task.seriesId],
    );
    assert.equal(row.duration_minutes, 45);
    assert.equal(row.due_at, null);
  });

  it("refuses a teammate moving the creator's upcoming date", async () => {
    const friday = nextWeekday(5);
    const task = await repeating(mark, "Mine", friday, "10:00", { every: "week" });
    await assert.rejects(
      () => moveUpcoming(sam, { seriesId: task.seriesId!, occursOn: shiftDay(friday, 7) }, { dueAt: london(shiftDay(friday, 7), "12:00"), dueHasTime: true }, "this", [], { operation: "drag_task", source: "web" }),
      (error: { code?: string }) => error.code === "not_found" || error.code === "forbidden",
    );
  });
});

describe("Plan and booking pages", () => {
  useServerlessPool();

  it("treats timed upcoming dates as busy and never moves them", async () => {
    const tuesday = nextWeekday(2);
    const wednesday = shiftDay(tuesday, 1);
    await repeating(mark, "Deep work", tuesday, "09:00", { every: "day" }, { durationMinutes: 480 });
    const report = (await createTask(mark, { title: "Write the board report", dueDate: wednesday, durationMinutes: 60 })).body.task;
    const now = Date.parse(london(shiftDay(tuesday, -1), "08:00"));
    const plan = await buildPlan(mark, { now, ai: false, store: false });
    assert.equal(plan.placed.some((entry) => entry.taskId === report.id), false);
    assert.ok(plan.unplaced.some((entry) => entry.taskId === report.id));
    assert.equal(plan.placed.some((entry) => entry.title === "Deep work"), false);
  });

  it("packs around upcoming dates passed to the packer", () => {
    const day = "2027-03-03";
    const task = {
      id: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      title: "Write it",
      dueAt: new Date(`${day}T00:00:00Z`).toISOString(),
      dueHasTime: false,
      durationMinutes: 60,
      scheduledBy: null,
      completedAt: null,
      archivedAt: null,
      ownerId: "me",
      priority: "normal" as const,
      createdAt: "2027-01-01T00:00:00.000Z",
    };
    const busy = { startsAt: `${day}T09:00:00.000Z`, endsAt: `${day}T17:00:00.000Z` };
    const plan = packPlan({ tasks: [task], meetings: [], upcoming: [busy], viewerId: "me", now: Date.parse("2027-03-02T08:00:00Z") });
    assert.equal(plan.placed.length, 0);
    const free = packPlan({ tasks: [task], meetings: [], viewerId: "me", now: Date.parse("2027-03-02T08:00:00Z") });
    assert.equal(free.placed.length, 1);
  });

  it("adds the owner's upcoming timed dates to booking busy time, without titles", async () => {
    await saveBookingPage(mark, {
      slug: "mark-recur",
      enabled: true,
      title: null,
      intro: "",
      durationMinutes: 30,
      bufferMinutes: 0,
      minNoticeMinutes: 0,
      horizonDays: 60,
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      videoUrl: "",
    });
    const tuesday = nextWeekday(2);
    const task = await repeating(mark, "Secret project", tuesday, "14:00", { every: "week" });
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: shiftDay(tuesday, 14) });
    const from = Date.parse(london(tuesday, "00:00"));
    const to = from + 50 * 86_400_000;
    const busy = await loadBusy(mark.userId, from, to);
    const starts = busy.map((interval) => new Date(interval.start).toISOString());
    assert.ok(starts.includes(london(tuesday, "14:00")));
    assert.ok(starts.includes(london(shiftDay(tuesday, 7), "14:00")));
    assert.equal(starts.includes(london(shiftDay(tuesday, 14), "14:00")), false);
    assert.ok(starts.includes(london(shiftDay(tuesday, 42), "14:00")));
    assert.equal(starts.filter((start) => start === london(tuesday, "14:00")).length, 1);

    const rows = await getPool().query("select * from private.booking_series($1, $2::date, $3::date)", [mark.userId, tuesday, shiftDay(tuesday, 50)]);
    assert.equal(JSON.stringify(rows.rows).includes("Secret project"), false);
    assert.deepEqual(Object.keys(rows.rows[0]).sort(), ["at", "changes", "current_due_at", "current_occurs_on", "duration_minutes", "ends", "rule", "starts_on"]);
    assert.equal(seriesBusy([], from, to, Date.now()).length, 0);

    await sql("update crm.booking_pages set enabled = false where user_id = $1", [mark.userId]);
    assert.equal((await getPool().query("select * from private.booking_series($1, $2::date, $3::date)", [mark.userId, tuesday, shiftDay(tuesday, 50)])).rows.length, 0);
    const denied = await getAdminPool().query("select has_function_privilege('authenticated', 'private.booking_series(uuid, date, date)', 'execute') as granted");
    assert.equal(denied.rows[0].granted, false);
  });
});
