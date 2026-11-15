import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/booking/rules";
import { loadBusy, saveBookingPage } from "@/lib/booking/pages";
import { seriesBusy } from "@/lib/booking/slots";
import { buildPlan, scheduleTasks } from "@/lib/crm/plan-schedule";
import { packPlan } from "@/lib/crm/plan-tasks";
import { scopesForRole } from "@/lib/crm/scopes";
import { readPlanner } from "@/lib/crm/task-blocks";
import { createRepeatingTask, KEEPS_DAY, NEW_DAY_ALL, setTaskRepeat, skipOccurrence, updateOccurrence } from "@/lib/crm/task-series";
import { completeTask, createTask, getTask, reopenTask } from "@/lib/crm/tasks";
import type { Task, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { undoTaskEvents } from "@/lib/crm/undo";
import { moveUpcoming, PAST_DAY } from "@/lib/crm/upcoming";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { dropRefusal, openDayChips, resetsFor, upcomingBlocks } from "@/lib/task-blocks";
import { upcomingBetween } from "@/lib/task-repeat";
import { planSeriesOutlook, type SeriesOutlookRow } from "@/lib/crm/series-outlook";
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

  it("skips, moves and opens later dates of a part split off by This and following, before it starts", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating(mark, "Split me", tuesday, "14:00", { every: "week" });
    const from = shiftDay(tuesday, 14);
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: from }, { dueAt: london(from, "15:00") }, "following", { provenance: { operation: "update_task", source: "web" } });
    const planner = await readPlanner(mark);
    const split = planner.series.find((item) => item.id !== task.seriesId && item.startsOn === from)!;
    assert.equal(split.currentTaskId, null);
    assert.equal(split.anchorTaskId, task.id);
    const blocks = upcomingBlocks([split], { viewerId: mark.userId, from, to: shiftDay(from, 14), today });
    assert.deepEqual(blocks.map((block) => block.upcoming?.occursOn), [from, shiftDay(from, 7), shiftDay(from, 14)]);
    assert.ok(blocks.every((block) => block.upcoming?.currentTaskId === task.id));
    const skipped = await skipOccurrence(mark, { seriesId: split.id, occursOn: shiftDay(from, 7) });
    assert.deepEqual((await changeRows(split.id)).map((row) => [row.occurs_on, row.skip]), [[shiftDay(from, 7), true]]);
    await undoTaskEvents(mark, task.id, skipped.body.undo, { operation: "undo_change", source: "web" });
    assert.deepEqual(await changeRows(split.id), []);
    const moved = await moveUpcoming(mark, { seriesId: split.id, occursOn: shiftDay(from, 14) }, { dueAt: london(shiftDay(from, 14), "17:00"), dueHasTime: true }, "this", [], { operation: "drag_task", source: "web" });
    assert.equal(moved.task.id, task.id);
    const all = await moveUpcoming(mark, { seriesId: split.id, occursOn: shiftDay(from, 14) }, { dueAt: london(shiftDay(from, 14), "17:00"), dueHasTime: true }, "all", moved.undo, { operation: "drag_task", source: "web" });
    assert.equal((await seriesRow(split.id)).at, "17:00");
    assert.equal((await seriesRow(task.seriesId!)).at, "14:00");
    assert.equal((await getTask(mark, task.id)).dueAt, london(tuesday, "14:00"));
    await undoTaskEvents(mark, task.id, all.undo, { operation: "undo_change", source: "web" });
    assert.equal((await seriesRow(split.id)).at, "15:00");
  });

  it("refuses a later date dropped on a past day", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating(mark, "No past", tuesday, "14:00", { every: "week" });
    const yesterday = shiftDay(today, -1);
    await assert.rejects(
      () => moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: shiftDay(tuesday, 7) }, { dueAt: london(yesterday, "14:00"), dueHasTime: true }, "this", [], { operation: "drag_task", source: "web" }),
      (error: Error) => error.message === PAST_DAY,
    );
  });

  it("counts the changed dates All would reset", async () => {
    const wednesday = nextWeekday(3);
    const task = await repeating(mark, "Count", wednesday, "09:00", { every: "week" });
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: shiftDay(wednesday, 7) }, { dueAt: london(shiftDay(wednesday, 7), "10:00"), dueHasTime: true }, "this", [], { operation: "drag_task", source: "web" });
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: shiftDay(wednesday, 14) }, { durationMinutes: 45 }, "this", [], { operation: "drag_task", source: "web" });
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: shiftDay(wednesday, 21) });
    const series = (await readPlanner(mark)).series.filter((item) => item.id === task.seriesId);
    const [block] = upcomingBlocks(series, { viewerId: mark.userId, from: shiftDay(wednesday, 28), to: shiftDay(wednesday, 28), today });
    assert.equal(resetsFor(block), 1);
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

  it("lets an overdue repeating task move onto its own next date", async () => {
    const task = await repeating(mark, "Stand-up", nextWeekday(1), "10:00", { every: "day" }, { durationMinutes: 30 });
    const yesterday = shiftDay(today, -1);
    await sql("update crm.tasks set due_at = $2, occurs_on = $3 where id = $1", [task.id, london(yesterday, "10:00"), yesterday]);
    const monday = nextWeekday(1);
    const [moved] = await scheduleTasks(mark, [{ taskId: task.id, at: london(monday, "10:00"), durationMinutes: 30, moveDay: monday }], { mode: "agent", provenance: { operation: "schedule_tasks", source: "mcp" } });
    assert.equal(moved.task.dueAt, london(monday, "10:00"));
  });

  it("refuses an agent schedule over an upcoming date", async () => {
    const tuesday = nextWeekday(2);
    const wednesday = shiftDay(tuesday, 1);
    await repeating(mark, "Standing call", tuesday, "10:00", { every: "day" }, { durationMinutes: 60 });
    const note = (await createTask(mark, { title: "Write notes", dueDate: wednesday, durationMinutes: 30 })).body.task;
    await assert.rejects(
      () => scheduleTasks(mark, [{ taskId: note.id, at: london(wednesday, "10:15"), durationMinutes: 30 }], { mode: "agent", provenance: { operation: "schedule_tasks", source: "mcp" } }),
      /clashes with Standing call/,
    );
    const [placed] = await scheduleTasks(mark, [{ taskId: note.id, at: london(wednesday, "11:30"), durationMinutes: 30 }], { mode: "agent", provenance: { operation: "schedule_tasks", source: "mcp" } });
    assert.equal(placed.task.dueAt, london(wednesday, "11:30"));
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

describe("dates moved past the open one", () => {
  it("still show where they fall, on the Calendar, in booking and in Outlook", () => {
    const series = {
      startsOn: "2027-01-04",
      at: "09:00",
      rule: { freq: "daily" as const, interval: 1 },
      ends: { never: true as const },
      durationMinutes: 30,
      afterOccurs: "2027-01-04",
      after: "2027-01-06",
      changes: [{ occursOn: "2027-01-05", dueAt: "2027-01-09T15:00:00.000Z", dueHasTime: true }],
    };
    const shown = upcomingBetween(series, "2027-01-04", "2027-01-10", "2027-01-04", "Europe/London");
    assert.deepEqual(shown.map((item) => [item.occursOn, item.day]), [["2027-01-07", "2027-01-07"], ["2027-01-08", "2027-01-08"], ["2027-01-09", "2027-01-09"], ["2027-01-05", "2027-01-09"], ["2027-01-10", "2027-01-10"]]);
    const row = {
      series_id: "00000000-0000-4000-8000-000000000001",
      workspace_id: "00000000-0000-4000-8000-000000000002",
      owner_id: "00000000-0000-4000-8000-000000000003",
      owner_member: true,
      title: "Daily",
      starts_on: "2027-01-04",
      at: "09:00",
      duration_minutes: 30,
      rule: series.rule,
      ends: series.ends,
      ended: false,
      current_task_id: "00000000-0000-4000-8000-000000000004",
      current_occurs_on: "2027-01-04",
      current_due_at: "2027-01-06T09:00:00.000Z",
      changes: series.changes,
      user_id: null,
      master_id: null,
      create_key: null,
      create_user_id: null,
      create_sent_at: null,
      written: null,
      dates: {},
      version: 1,
      attempts: 0,
    } as SeriesOutlookRow;
    const plan = planSeriesOutlook(row, Date.parse("2027-01-04T08:00:00Z"), "Europe/London");
    assert.equal(plan.kind, "write");
    if (plan.kind === "write") {
      assert.equal(plan.master?.startDay, "2027-01-07");
      assert.deepEqual(plan.dates["2027-01-05"], { start: "2027-01-09T15:00:00.000Z", end: "2027-01-09T15:30:00.000Z", title: "Daily" });
    }
  });
});

describe("review of the whole branch", () => {
  const drag = { operation: "drag_task", source: "web" };

  async function splitAt(task: Task, from: string, time: string) {
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: from }, { dueAt: london(from, time) }, "following", { provenance: drag });
    return (await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1 and archived_at is null order by created_at desc limit 1", [task.seriesId]))[0].id;
  }

  it("never deadlocks a change to an unstarted part against Done or Stop on its parent", async () => {
    for (let round = 0; round < 8; round += 1) {
      const tuesday = nextWeekday(2);
      const task = await repeating(mark, `Race ${round}`, tuesday, "14:00", { every: "week" });
      const split = await splitAt(task, shiftDay(tuesday, 14), "15:00");
      const results = await Promise.allSettled([
        skipOccurrence(mark, { seriesId: split, occursOn: shiftDay(tuesday, 21) }),
        round % 2 === 0 ? completeTask(mark, task.id) : setTaskRepeat(mark, task.id, null),
      ]);
      for (const result of results) {
        if (result.status === "rejected") assert.doesNotMatch(String((result.reason as Error).message), /deadlock/);
      }
    }
  });

  it("refuses a later date moved onto or before the open one's day", async () => {
    const friday = nextWeekday(5);
    const task = await repeating(mark, "Not before", friday, "10:00", { every: "week" });
    const later = shiftDay(friday, 7);
    for (const day of [friday, shiftDay(friday, -1)]) {
      await assert.rejects(
        () => moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(day, "11:00"), dueHasTime: true }, "this", [], drag),
        /day after the open one/,
      );
    }
    assert.deepEqual(await changeRows(task.seriesId!), []);
    const block = upcomingBlocks((await readPlanner(mark)).series.filter((item) => item.id === task.seriesId), { viewerId: mark.userId, from: later, to: later, today })[0];
    assert.match(dropRefusal(block, london(friday, "11:00"), today) ?? "", /day after the open one/);
  });

  it("refuses All that would drop a moved day, and moves later dates with This and following", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating(mark, "Keep the day", tuesday, "14:00", { every: "week" });
    const later = shiftDay(tuesday, 7);
    const one = await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(shiftDay(later, 1), "15:30"), dueHasTime: true }, "this", [], drag);
    await assert.rejects(
      () => moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(shiftDay(later, 1), "15:30"), dueHasTime: true }, "all", one.undo, drag),
      (error: Error) => error.message === NEW_DAY_ALL,
    );
    assert.equal((await changeRows(task.seriesId!)).length, 1);
    assert.equal((await seriesRow(task.seriesId!)).at, "14:00");
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(shiftDay(later, 1), "15:30"), dueHasTime: true }, "following", one.undo, drag);
    const [part] = await sql<{ starts_on: string; at: string }>("select starts_on::text, to_char(at, 'HH24:MI') as at from crm.task_series where split_from_id = $1 and archived_at is null", [task.seriesId]);
    assert.deepEqual(part, { starts_on: shiftDay(later, 1), at: "15:30" });
    assert.equal((await seriesRow(task.seriesId!)).at, "14:00");
  });

  it("refuses a new day for This and following on the first date of a part that hasn't started", async () => {
    const monday = nextWeekday(1);
    const task = await repeating(mark, "Unstarted day", monday, "09:00", { every: "week" });
    const from = shiftDay(monday, 14);
    const split = await splitAt(task, from, "10:00");
    await assert.rejects(
      () => updateOccurrence(mark, { seriesId: split, occursOn: from }, { dueAt: london(shiftDay(from, 1), "10:00") }, "following", { provenance: drag }),
      (error: Error) => error.message === KEEPS_DAY,
    );
    assert.deepEqual(await sql("select starts_on::text from crm.task_series where id = $1", [split]), [{ starts_on: from }]);
  });

  it("lets dates of a part split twice be skipped and opened", async () => {
    const monday = nextWeekday(1);
    const task = await repeating(mark, "Twice", monday, "09:00", { every: "week" });
    const first = await splitAt(task, shiftDay(monday, 14), "10:00");
    await updateOccurrence(mark, { seriesId: first, occursOn: shiftDay(monday, 28) }, { dueAt: london(shiftDay(monday, 28), "11:00") }, "following", { provenance: drag });
    const second = (await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1 and archived_at is null", [first]))[0].id;
    const planner = await readPlanner(mark);
    assert.equal(planner.series.find((item) => item.id === second)?.anchorTaskId, task.id);
    await skipOccurrence(mark, { seriesId: second, occursOn: shiftDay(monday, 35) });
    assert.deepEqual((await changeRows(second)).map((row) => row.skip), [true]);
  });

  it("edits the part itself for This and following on its first date, leaving no empty part", async () => {
    const wednesday = nextWeekday(3);
    const task = await repeating(mark, "First date", wednesday, "09:00", { every: "week" });
    const from = shiftDay(wednesday, 14);
    const split = await splitAt(task, from, "10:00");
    await updateOccurrence(mark, { seriesId: split, occursOn: from }, { dueAt: london(from, "12:00") }, "following", { provenance: drag });
    const parts = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1 and archived_at is null", [split]);
    assert.deepEqual(parts, []);
    assert.equal((await seriesRow(split)).at, "12:00");
  });

  it("keeps an unstarted part with its owner and never hands out a task id a teammate can't read", async () => {
    const thursday = nextWeekday(4);
    const task = await repeating(mark, "Mine to keep", thursday, "09:00", { every: "week" });
    const from = shiftDay(thursday, 14);
    const split = await splitAt(task, from, "10:00");
    await assert.rejects(
      () => updateOccurrence(mark, { seriesId: split, occursOn: from }, { ownerId: sam.userId }, "all", { provenance: drag }),
      /once they start/,
    );
    await assert.rejects(() => updateOccurrence(mark, { seriesId: split, occursOn: from }, { completed: true }, "all", { provenance: drag }), /haven't started/);
    await sql("update crm.task_series set owner_id = $2 where id = $1", [split, sam.userId]);
    const samSeries = (await readPlanner(sam)).series.find((item) => item.id === split);
    assert.equal(samSeries?.anchorTaskId ?? null, null);
  });

  it("keeps a This one move on the next date when Done is undone", async () => {
    const monday = nextWeekday(1);
    const task = await repeating(mark, "Reopened", monday, "10:00", { every: "week" });
    const next = shiftDay(monday, 7);
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: next }, { dueAt: london(shiftDay(next, 1), "16:00"), dueHasTime: true }, "this", [], drag);
    await completeTask(mark, task.id);
    await reopenTask(mark, task.id);
    const [change] = await changeRows(task.seriesId!);
    assert.equal(change.occurs_on, next);
    assert.equal(new Date(change.due_at!).toISOString(), london(shiftDay(next, 1), "16:00"));
  });

  it("lets a part's dates be changed while its parent's last task is done but the part hasn't started", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating(mark, "Gap", tuesday, "09:00", { every: "week" });
    const split = await splitAt(task, shiftDay(tuesday, 7), "10:00");
    await sql("update crm.tasks set completed_at = now() where id = $1", [task.id]);
    await sql("update crm.task_series set current_task_id = null where id = $1", [split]);
    await skipOccurrence(mark, { seriesId: split, occursOn: shiftDay(tuesday, 14) });
    assert.deepEqual((await changeRows(split)).map((row) => row.skip), [true]);
  });

  it("gives Open the tagged people and team of an open task it shows from a repeating date", async () => {
    const task = await repeating(mark, "Handed one", nextWeekday(3), "09:00", { every: "week" });
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this", { provenance: drag });
    const planner = await readPlanner(mark);
    assert.ok(planner.seriesTasks.some((item) => item.id === task.id));
    assert.ok((planner.tagged[task.id] ?? []).length > 0 || planner.teams.some((team) => team.members.length > 1));
    assert.ok(planner.teams.find((team) => team.id === mark.workspaceId)!.members.length > 1);
  });

  it("reads every change row and series, however many", async () => {
    const task = await repeating(mark, "Many skips", nextWeekday(1), "07:00", { every: "day" });
    await sql(
      "insert into crm.task_occurrence_changes (series_id, occurs_on, skip) select $1, d::date, true from generate_series($2::date, $2::date + 204, interval '1 day') d",
      [task.seriesId, shiftDay(nextWeekday(1), 1)],
    );
    const series = (await readPlanner(mark)).series.find((item) => item.id === task.seriesId)!;
    assert.equal(series.changes.length, 205);
  });

  it("draws a date that crosses midnight on the next day too", async () => {
    const tuesday = nextWeekday(2);
    await repeating(mark, "Late", tuesday, "23:30", { every: "week" }, { durationMinutes: 60 });
    const later = shiftDay(tuesday, 7);
    const start = new Date(london(shiftDay(later, 1), "00:00"));
    const result = (await runTool(mark, "list_calendar_events", { from: shiftDay(later, 1), to: shiftDay(later, 1) })) as { taskBlocks: { upcoming?: boolean; title: string }[] };
    assert.ok(result.taskBlocks.some((block) => block.upcoming && block.title === "Late"), start.toISOString());
  });

  it("only undoes the This one move it replaces", async () => {
    const monday = nextWeekday(1);
    const first = await repeating(mark, "One", monday, "09:00", { every: "week" });
    const other = await repeating(mark, "Other", monday, "11:00", { every: "week" });
    const otherMove = await moveUpcoming(mark, { seriesId: other.seriesId!, occursOn: shiftDay(monday, 7) }, { dueAt: london(shiftDay(monday, 7), "12:00"), dueHasTime: true }, "this", [], drag);
    await assert.rejects(
      () => moveUpcoming(mark, { seriesId: first.seriesId!, occursOn: shiftDay(monday, 7) }, { dueAt: london(shiftDay(monday, 7), "10:00"), dueHasTime: true }, "all", otherMove.undo, drag),
      /other dates/,
    );
    assert.equal((await changeRows(other.seriesId!)).length, 1);
  });

  it("refuses a garbled move with a clear message", async () => {
    const task = await repeating(mark, "Garbled", nextWeekday(2), "09:00", { every: "week" });
    const target = { seriesId: task.seriesId!, occursOn: shiftDay(nextWeekday(2), 7) };
    await assert.rejects(() => moveUpcoming(mark, target, { dueAt: "garbage", dueHasTime: true }, "this", [], drag), /Choose a day and time/);
    for (const minutes of [7.5, 1000]) await assert.rejects(() => moveUpcoming(mark, target, { durationMinutes: minutes }, "this", [], drag), /between 5 and 480/);
  });

  it("counts the dates All resets without the one being moved", async () => {
    const wednesday = nextWeekday(3);
    const task = await repeating(mark, "Resets", wednesday, "09:00", { every: "week" });
    const later = shiftDay(wednesday, 7);
    await moveUpcoming(mark, { seriesId: task.seriesId!, occursOn: later }, { dueAt: london(later, "10:00"), dueHasTime: true }, "this", [], drag);
    const series = (await readPlanner(mark)).series.filter((item) => item.id === task.seriesId);
    const [block] = upcomingBlocks(series, { viewerId: mark.userId, from: later, to: later, today });
    assert.equal(resetsFor(block), 0);
  });

  it("hides dates of a part that hasn't started on or before the day its open task was moved to", async () => {
    const tuesday = nextWeekday(2);
    const task = await repeating(mark, "Moved past the part", tuesday, "14:00", { every: "week" });
    const from = shiftDay(tuesday, 14);
    const split = await splitAt(task, from, "15:00");
    await sql("update crm.tasks set due_at = $2 where id = $1", [task.id, london(shiftDay(from, 8), "14:00")]);
    const part = (await readPlanner(mark)).series.find((item) => item.id === split)!;
    assert.equal(part.anchorTaskId, task.id);
    const blocks = upcomingBlocks([part], { viewerId: mark.userId, from, to: shiftDay(from, 21), today });
    assert.deepEqual(blocks.map((block) => block.upcoming?.occursOn), [shiftDay(from, 14), shiftDay(from, 21)]);
  });

  it("shows the open date-only occurrence as a chip on its day", async () => {
    const task = await repeating(mark, "Report", nextWeekday(3), null, { every: "week" });
    const planner = await readPlanner(mark);
    const chips = openDayChips(planner.tasks, mark.userId);
    assert.ok(chips.some((chip) => chip.task.id === task.id && chip.task.dueDate === task.dueDate));
  });
});
