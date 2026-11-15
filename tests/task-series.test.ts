import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { scopesForRole } from "@/lib/crm/scopes";
import {
  createRepeatingTask,
  deleteSeries,
  endSeriesOn,
  NEEDS_SCOPE,
  readRepeatHistory,
  rollDueSeries,
  setTaskRepeat,
  skipDeletedOccurrenceInDb,
  skipOccurrence,
  TOO_MANY_SERIES,
  updateOccurrence,
} from "@/lib/crm/task-series";
import { addTaskParticipants, archiveTask, completeTask, createTask, getTask, listTasks, reopenTask, unarchiveTaskInDb, updateTask } from "@/lib/crm/tasks";
import type { AgentActor, Task, TaskWrite, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { undoAuditEvent, undoTaskEvents } from "@/lib/crm/undo";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PATCH as restUpdateTask } from "@/app/api/v1/tasks/[id]/route";
import { POST as restCreateTask } from "@/app/api/v1/tasks/route";
import { runTool } from "@/lib/assistant/tools";
import { createDoc } from "@/lib/docs/store";
import { clickupClient } from "@/lib/clickup";
import { SCOPES } from "@/lib/crm/scopes";
import { createCrmMcpServer } from "@/server/mcp/server";
import { moveRecordsToWorkspace } from "@/lib/crm/move-workspace";
import { createWorkspace } from "@/lib/crm/workspaces";
import { removeMember } from "@/lib/crm/team";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let ada: UserActor;
let companyId: string;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function seriesRow(id: string) {
  const [row] = await sql<{ current_task_id: string | null; ended_at: Date | null; archived_at: Date | null; at: string | null; title: string; ends: unknown; starts_on: string; roll_at: Date | null; owner_id: string | null }>(
    "select current_task_id, ended_at, archived_at, to_char(at, 'HH24:MI') as at, title, ends, starts_on::text as starts_on, roll_at, owner_id from crm.task_series where id = $1",
    [id],
  );
  return row;
}

async function listTaskParticipantsFor(taskId: string) {
  return (await sql<{ user_id: string }>("select user_id from crm.task_participants where task_id = $1", [taskId])).map((row) => row.user_id);
}

async function occurrences(seriesId: string) {
  return sql<{ id: string; occurs_on: string; due_at: Date; completed: boolean; archived: boolean; title: string }>(
    "select id, occurs_on::text as occurs_on, due_at, completed_at is not null as completed, archived_at is not null as archived, title from crm.tasks where series_id = $1 order by occurs_on, created_at",
    [seriesId],
  );
}

async function events(taskId: string) {
  return sql<{ id: string; event_type: string; operation: string; changes: Record<string, unknown> }>(
    "select id, event_type, operation, changes from crm.audit_events where entity_id = $1 order by created_at, id",
    [taskId],
  );
}

function at(day: string, time: string) {
  return new Date(`${day}T${time}:00Z`).toISOString();
}

async function weekly(title: string, day = "2027-03-02", time = "14:00", extra: Record<string, unknown> = {}) {
  return (await createRepeatingTask(mark, { title, dueAt: at(day, time), companyId }, { every: "week", ...extra })).body.task;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@series.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@series.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@series.test", "Priya Nair"), "member");
  ada = await join(await createUser("ada@series.test", "Ada Admin"), "admin");
  companyId = (await createCompany(mark, { name: "Northwind", domain: "northwind.test" })).body.company.id;
  setLiveTesting({ batch: async () => undefined });
});

beforeEach(async () => {
  await sql("update crm.task_series set archived_at = now() where archived_at is null");
});

after(async () => {
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("repeating tasks", () => {
  it("creates the series and its first occurrence as a normal task", async () => {
    const task = await weekly("Check in with Jane", "2027-03-02");
    assert.ok(task.seriesId);
    assert.equal(task.occursOn, "2027-03-02");
    assert.equal(task.dueAt, "2027-03-02T14:00:00.000Z");
    assert.equal(task.companyId, companyId);
    assert.equal(task.repeat?.phrase, "Repeats every Tuesday at 14:00");
    assert.equal(task.repeat?.current, true);
    assert.deepEqual(task.repeat?.next, { occursOn: "2027-03-09", dueAt: "2027-03-09T14:00:00.000Z", dueHasTime: true });
    const row = await seriesRow(task.seriesId!);
    assert.equal(row.current_task_id, task.id);
    assert.equal(row.at, "14:00");
    assert.equal(row.starts_on, "2027-03-02");
    assert.equal(new Date(row.roll_at!).toISOString(), "2027-03-09T00:00:00.000Z");
    assert.deepEqual((await events(task.id)).map((event) => `${event.event_type} ${event.operation}`).sort(), ["task.created create_task", "task_series.created create_task"]);
  });

  it("starts on the first pattern day, and tomorrow when today's time has passed", async () => {
    const monday = (await createRepeatingTask(mark, { title: "Team call", dueAt: at("2027-03-06", "10:00") }, { every: "week", days: ["mo"] })).body.task;
    assert.equal(monday.occursOn, "2027-03-08");
    assert.equal(monday.dueAt, "2027-03-08T10:00:00.000Z");
    const today = dayKeyAt(new Date());
    const passed = new Date(Date.now() - 60 * 1000);
    const walk = (await createRepeatingTask(mark, { title: "Walk the dog", dueAt: passed.toISOString() }, { every: "day" })).body.task;
    assert.equal(walk.occursOn, dayKeyAt(passed) === today ? shiftDay(today, 1) : today);
    const undated = (await createRepeatingTask(mark, { title: "Invoice" }, { every: "month", monthDay: 1 })).body.task;
    assert.equal(undated.dueHasTime, false);
    assert.equal(undated.occursOn?.slice(8), "01");
  });

  it("creates the next one on the pattern when one is done, whatever day it was done", async () => {
    const task = await weekly("Weekly report", "2027-03-02");
    const done = (await completeTask(mark, task.id)).body.task;
    assert.equal(done.repeat?.current, false);
    const rows = await occurrences(task.seriesId!);
    assert.deepEqual(rows.map((row) => [row.occurs_on, row.completed]), [["2027-03-02", true], ["2027-03-09", false]]);
    const next = await getTask(mark, rows[1].id);
    assert.equal(next.dueAt, "2027-03-09T14:00:00.000Z");
    assert.equal(next.companyId, companyId);
    assert.equal(next.createdByUserId, mark.userId);
    assert.equal((await seriesRow(task.seriesId!)).current_task_id, next.id);
    const created = await events(next.id);
    assert.deepEqual(created.map((event) => `${event.event_type} ${event.operation}`), ["task.created repeat_task"]);
    const listed = (await listTasks(mark, { query: "Weekly report" })).data;
    assert.deepEqual(listed.map((item) => item.id), [next.id]);
  });

  it("makes exactly one next occurrence when two completions race", async () => {
    const task = await weekly("Race", "2027-03-03");
    await Promise.all([completeTask(mark, task.id), completeTask(mark, task.id), updateTask(mark, task.id, { completed: true })]);
    const rows = await occurrences(task.seriesId!);
    assert.deepEqual(rows.map((row) => [row.occurs_on, row.completed]), [["2027-03-03", true], ["2027-03-10", false]]);
  });

  it("removes an untouched next one when Done is undone, and keeps a touched one", async () => {
    const task = await weekly("Undo me", "2027-03-04");
    await completeTask(mark, task.id);
    await reopenTask(mark, task.id);
    let rows = await occurrences(task.seriesId!);
    assert.deepEqual(rows.map((row) => [row.occurs_on, row.completed, row.archived]), [["2027-03-04", false, false], ["2027-03-11", false, true]]);
    assert.equal((await seriesRow(task.seriesId!)).current_task_id, task.id);

    await completeTask(mark, task.id);
    rows = await occurrences(task.seriesId!);
    const next = rows.find((row) => !row.completed && !row.archived)!;
    await updateTask(mark, next.id, { description: "Bring the numbers" });
    await reopenTask(mark, task.id);
    const reopened = await getTask(mark, task.id);
    assert.equal(reopened.seriesId, null);
    assert.equal(reopened.completedAt, null);
    assert.equal((await seriesRow(next.id ? (await getTask(mark, next.id)).seriesId! : "")).current_task_id, next.id);
  });

  it("rolls a missed one forward to the latest date, keeping only one open", async () => {
    const task = (await createRepeatingTask(mark, { title: "Stretch", dueAt: at("2027-03-01", "09:00") }, { every: "day" })).body.task;
    const result = await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-03-04T08:00:00Z") });
    assert.equal(result.rolled, 1);
    const moved = await getTask(mark, task.id);
    assert.equal(moved.occursOn, "2027-03-04");
    assert.equal(moved.dueAt, "2027-03-04T09:00:00.000Z");
    const rolled = (await events(task.id)).find((event) => event.operation === "repeat_roll")!;
    assert.equal(rolled.event_type, "task.updated");
    assert.deepEqual((rolled.changes.repeat as { passed: string[] }).passed, ["2027-03-01", "2027-03-02", "2027-03-03"]);
    assert.equal((await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-03-04T08:00:00Z") })).rolled, 0);
    const history = await readRepeatHistory(mark, task.id);
    assert.deepEqual(history, [
      { kind: "missed", day: "2027-03-03" },
      { kind: "missed", day: "2027-03-02" },
      { kind: "missed", day: "2027-03-01" },
    ]);
    await assert.rejects(undoAuditEvent(mark, rolled.id, { operation: "undo_change" }), /can't be undone|Undo/i);
  });

  it("rolls at the reminder time when it comes before the day starts", async () => {
    const task = (await createRepeatingTask(mark, { title: "Tuesday call", dueAt: at("2027-03-02", "14:00"), remindMinutes: 1440 }, { every: "week" })).body.task;
    const row = await seriesRow(task.seriesId!);
    assert.equal(new Date(row.roll_at!).toISOString(), "2027-03-08T14:00:00.000Z");
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-03-08T14:01:00Z") });
    const moved = await getTask(mark, task.id);
    assert.equal(moved.dueAt, "2027-03-09T14:00:00.000Z");
    assert.equal(moved.remindMinutes, 1440);
  });

  it("skips the open one and a future one, and undoes a skip", async () => {
    const task = await weekly("Skip me", "2027-03-05");
    const skipped = (await skipOccurrence(mark, { taskId: task.id })).body;
    assert.equal(skipped.skipped, "2027-03-05");
    assert.equal(skipped.task.occursOn, "2027-03-12");
    assert.equal(skipped.task.dueAt, "2027-03-12T14:00:00.000Z");
    const future = (await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-19" })).body;
    assert.equal(future.skipped, "2027-03-19");
    assert.equal((await getTask(mark, task.id)).repeat?.next?.occursOn, "2027-03-26");
    await assert.rejects(skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-20" }), /isn't one of its dates/);

    const skipEvent = (await events(task.id)).find((event) => event.operation === "skip_occurrence" && event.event_type === "task.updated")!;
    await undoAuditEvent(mark, skipEvent.id, { operation: "undo_change" });
    const back = await getTask(mark, task.id);
    assert.equal(back.occursOn, "2027-03-05");
    assert.equal(back.dueAt, "2027-03-05T14:00:00.000Z");
    const history = await readRepeatHistory(mark, task.id);
    assert.deepEqual(history, []);
  });

  it("asks where a change applies, and applies This one, All and This and following", async () => {
    const task = await weekly("Walk the dog", "2027-03-01", "14:00", { every: "day" });
    await assert.rejects(updateOccurrence(mark, { taskId: task.id }, { title: "Walk Rex" }, undefined), new RegExp(NEEDS_SCOPE.slice(0, 20)));

    const moved = (await updateOccurrence(mark, { taskId: task.id }, { dueAt: at("2027-03-01", "15:00"), dueHasTime: true }, "this")).body.task;
    assert.equal(moved.dueAt, "2027-03-01T15:00:00.000Z");
    assert.equal((await seriesRow(task.seriesId!)).at, "14:00");

    const day = (await updateOccurrence(mark, { taskId: task.id }, { dueAt: at("2027-03-02", "09:00"), dueHasTime: true }, undefined)).body.task;
    assert.equal(day.dueAt, "2027-03-02T09:00:00.000Z");
    assert.equal(day.occursOn, "2027-03-01");

    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-04" }, { dueAt: at("2027-03-04", "15:30"), dueHasTime: true, durationMinutes: 30 }, "this");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-05" }, { title: "Walk Rex in the park" }, "this");
    let row = await getTask(mark, task.id);
    assert.equal(row.repeat?.changedDates, 1);

    const all = (await updateOccurrence(mark, { taskId: task.id }, { title: "Walk Rex", dueAt: at("2027-03-02", "16:00"), dueHasTime: true }, "all")).body;
    assert.equal(all.task.title, "Walk Rex");
    assert.equal(all.task.dueAt, "2027-03-02T16:00:00.000Z");
    const series = await seriesRow(task.seriesId!);
    assert.equal(series.title, "Walk Rex");
    assert.equal(series.at, "16:00");
    row = await getTask(mark, task.id);
    assert.equal(row.repeat?.changedDates, 0);
    const changes = await sql<{ occurs_on: string; title: string | null; due_at: Date | null }>(
      "select occurs_on::text as occurs_on, title, due_at from crm.task_occurrence_changes where series_id = $1 order by occurs_on",
      [task.seriesId],
    );
    assert.deepEqual(changes.map((change) => [change.occurs_on, change.title, change.due_at]), [["2027-03-04", null, null], ["2027-03-05", "Walk Rex in the park", null]]);
    const allEvent = (await events(task.id)).filter((event) => event.event_type === "task_series.updated").pop()!;
    assert.equal((allEvent.changes.resetChanges as unknown[]).length, 1);

    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-06" }, { durationMinutes: 45 }, "this");
    const splitting = await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-06" }, { dueAt: at("2027-03-06", "07:00"), dueHasTime: true }, "following");
    assert.equal(splitting.body.task.id, task.id);
    assert.deepEqual((await seriesRow(task.seriesId!)).ends, { until: "2027-03-05" });
    const [child] = await sql<{ id: string; current_task_id: string | null; at: string }>(
      "select id, current_task_id, to_char(at, 'HH24:MI') as at from crm.task_series where split_from_id = $1",
      [task.seriesId],
    );
    assert.equal(child.current_task_id, null);
    assert.equal(child.at, "07:00");
    const kept = await sql<{ duration_minutes: number | null }>("select duration_minutes from crm.task_occurrence_changes where series_id = $1 and occurs_on = '2027-03-06'", [child.id]);
    assert.equal(kept[0]?.duration_minutes, 45);
    const splitEvent = (await events(task.id)).filter((event) => event.event_type === "task_series.updated").pop()!;
    assert.ok(splitting.body.undo.includes(splitEvent.id));
    await completeTask(mark, task.id);
    for (const day of ["2027-03-03", "2027-03-04", "2027-03-05"]) {
      const open = (await occurrences(task.seriesId!)).find((row) => !row.completed && !row.archived)!;
      assert.equal(open.occurs_on, day);
      await completeTask(mark, open.id);
    }
    assert.ok((await seriesRow(task.seriesId!)).ended_at);
    const started = (await occurrences(child.id)).filter((row) => !row.completed);
    assert.deepEqual(started.map((row) => [row.occurs_on, new Date(row.due_at).toISOString()]), [["2027-03-06", "2027-03-06T07:00:00.000Z"]]);
  });

  it("hands one occurrence to a colleague and gives the next back to the owner", async () => {
    const task = await weekly("Board pack", "2027-03-03", "10:00");
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    const handed = await getTask(sam, task.id);
    assert.equal(handed.ownerId, sam.userId);
    assert.equal(handed.dueHasTime, false);
    await completeTask(sam, task.id);
    const rows = await occurrences(task.seriesId!);
    const next = await getTask(mark, rows[1].id);
    assert.equal(next.ownerId, mark.userId);
    assert.equal(next.dueAt, "2027-03-10T10:00:00.000Z");
    assert.equal((await seriesRow(task.seriesId!)).current_task_id, next.id);
    const [pending] = await sql<{ roll_pending: boolean }>("select roll_pending from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(pending.roll_pending, true);
    assert.equal((await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-03-09T12:00:00Z") })).rolled, 0);
    const settled = await seriesRow(task.seriesId!);
    assert.equal(new Date(settled.roll_at!).toISOString(), "2027-03-17T00:00:00.000Z");
  });

  it("saves the series date only when giving a teammate a timed one", async () => {
    const task = (await createRepeatingTask(mark, { title: "Sam's review", dueAt: at("2027-03-03", "10:00"), ownerId: sam.userId }, { every: "week" })).body.task;
    assert.equal(task.dueHasTime, false);
    assert.equal((await seriesRow(task.seriesId!)).at, null);
  });

  it("stops, ends on a date and deletes a series, each with undo", async () => {
    const stop = await weekly("Stop me", "2027-03-02");
    const stopped = (await setTaskRepeat(mark, stop.id, null)).body;
    assert.ok((await seriesRow(stop.seriesId!)).ended_at);
    assert.equal(stopped.task.repeat?.ended, true);
    await completeTask(mark, stop.id);
    assert.equal((await occurrences(stop.seriesId!)).length, 1);
    await reopenTask(mark, stop.id);
    await undoAuditEvent(mark, stopped.undo.find(Boolean)!, { operation: "undo_change" });
    assert.equal((await seriesRow(stop.seriesId!)).ended_at, null);

    const end = await weekly("End me", "2027-03-02");
    const ended = (await endSeriesOn(mark, end.id, "2027-03-16")).body.task;
    assert.equal(ended.repeat?.end, "until 16 Mar");
    assert.deepEqual(ended.repeat?.ends, { until: "2027-03-16" });
    await assert.rejects(endSeriesOn(mark, end.id, "2027-03-01"), /before the first one/);

    const gone = await weekly("Delete me", "2027-03-02");
    await completeTask(mark, gone.id);
    const open = (await occurrences(gone.seriesId!)).find((row) => !row.completed)!;
    const deleted = (await deleteSeries(mark, open.id)).body;
    const rows = await occurrences(gone.seriesId!);
    assert.deepEqual(rows.map((row) => [row.completed, row.archived]), [[true, false], [false, true]]);
    assert.ok((await seriesRow(gone.seriesId!)).archived_at);
    const deletedEvent = (await events(open.id)).find((event) => event.event_type === "task_series.deleted")!;
    assert.ok(deleted.undo.includes(deletedEvent.id));
    await undoAuditEvent(mark, deletedEvent.id, { operation: "undo_change" });
    assert.equal((await seriesRow(gone.seriesId!)).archived_at, null);
    assert.equal((await getTask(mark, open.id)).archivedAt, null);
  });

  it("makes an existing task repeat and changes the pattern for all", async () => {
    const plain = (await createTask(mark, { title: "Pay the cleaner", dueDate: "2027-03-06" })).body.task;
    const made = (await setTaskRepeat(mark, plain.id, { every: "week", days: ["fr"] })).body.task;
    assert.equal(made.occursOn, "2027-03-06");
    assert.equal(made.repeat?.next?.occursOn, "2027-03-12");
    const changed = (await setTaskRepeat(mark, plain.id, { every: "month", monthDay: 6 })).body.task;
    assert.equal(changed.repeat?.next?.occursOn, "2027-04-06");
    const updated = (await events(plain.id)).filter((event) => event.event_type === "task_series.updated").pop()!;
    await undoAuditEvent(mark, updated.id, { operation: "undo_change" });
    assert.equal((await getTask(mark, plain.id)).repeat?.next?.occursOn, "2027-03-12");
  });

  it("refuses a 201st repeating task", async () => {
    await sql(
      `insert into crm.task_series (workspace_id, owner_id, created_by_user_id, title, starts_on, rule)
       select $1, $2, $2, 'Filler ' || n, '2027-03-01', '{"freq": "daily", "interval": 1}'::jsonb from generate_series(1, 200) n`,
      [mark.workspaceId, mark.userId],
    );
    await assert.rejects(weekly("One too many"), new RegExp(TOO_MANY_SERIES));
  });
});

describe("repeating tasks over the API, MCP and the assistant", () => {
  it("creates, changes, skips and stops repeats with the same fields everywhere", async () => {
    const token = (await createAgent(mark.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Zapier")).token;
    const rest = async (method: "POST" | "PATCH", body: Record<string, unknown>, id?: string) => {
      const request = new Request(`http://crm.test/api/v1/tasks${id ? `/${id}` : ""}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const response = method === "POST" ? await restCreateTask(request) : await restUpdateTask(request, { params: Promise.resolve({ id: id! }) });
      return { status: response.status, body: (await response.json()) as { task?: Task; error?: { message: string } } };
    };
    const created = await rest("POST", { title: "Invoice", dueDate: "2027-04-01", repeat: { every: "month", monthDay: 1, ends: { after: 3 } } });
    assert.equal(created.status, 201);
    const invoice = created.body.task!;
    assert.equal(invoice.repeat?.phrase, "Repeats monthly on the 1st");
    assert.equal(invoice.repeat?.rrule, "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;COUNT=3");
    assert.equal(invoice.repeat?.end, "2 more");
    const refused = await rest("PATCH", { title: "Send the invoice" }, invoice.id);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error!.message, /repeatScope/);
    const renamed = await rest("PATCH", { title: "Send the invoice", repeatScope: "all" }, invoice.id);
    assert.equal(renamed.body.task!.title, "Send the invoice");
    const skipped = await rest("PATCH", { skip: true, occursOn: "2027-05-01" }, invoice.id);
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.task!.repeat?.next?.occursOn, "2027-06-01");

    const server = createCrmMcpServer(mark);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "task-series", version: "1.0.0" });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      if (result.isError) throw new Error(result.content[0]?.text);
      return JSON.parse(result.content[0].text) as { task: Task };
    };
    try {
      const call1 = (await call("create_next_action", { title: "Team call", dueAt: "2027-04-05T10:00", repeat: { every: "week", days: ["mo"] } })).task;
      assert.equal(call1.repeat?.text, "Every Monday at 10:00");
      const moved = (await call("update_next_action", { id: call1.id, occursOn: "2027-04-12", dueAt: "2027-04-12T11:00", repeatScope: "this" })).task;
      assert.equal(moved.id, call1.id);
      assert.equal(moved.repeat?.changedDates, 1);
      const stopped = (await call("update_next_action", { id: call1.id, repeat: null })).task;
      assert.equal(stopped.repeat?.ended, true);
    } finally {
      await client.close();
      await server.close();
    }

    const made = (await runTool(mark, "create_task", { title: "Review", dueDate: "2027-04-02", sendToClickUp: false, repeat: { every: "week", interval: 2, days: ["fr"] } })) as { task: Task };
    assert.equal(made.task.repeat?.phrase, "Repeats every 2 weeks on Friday");
    const asked = (await runTool(mark, "update_task", { taskId: made.task.id, title: "Review the pipeline" })) as { error?: string; field?: string };
    assert.equal(asked.field, "repeatScope");
    const skippedTool = (await runTool(mark, "update_task", { taskId: made.task.id, skip: true })) as { task: Task };
    assert.equal(skippedTool.task.occursOn, "2027-04-16");
    const following = (await runTool(mark, "update_task", { seriesId: made.task.seriesId, occursOn: "2027-04-30", title: "Review the pipeline", repeatScope: "following" })) as { task: Task };
    assert.equal(following.task.id, made.task.id);
    const [child] = await sql<{ title: string; starts_on: string }>("select title, starts_on::text as starts_on from crm.task_series where split_from_id = $1", [made.task.seriesId]);
    assert.deepEqual(child, { title: "Review the pipeline", starts_on: "2027-04-30" });
    const stringRepeat = (await runTool(mark, "create_task", { title: "Bad repeat", sendToClickUp: false, repeat: "every week" })) as { error?: string };
    assert.match(stringRepeat.error ?? "", /as an object/);
    const bothFields = (await runTool(mark, "update_task", { taskId: made.task.id, title: "Renamed", repeat: { every: "week", days: ["fr"] } })) as { field?: string };
    assert.equal(bothFields.field, "repeatScope");
    const badDay = (await runTool(mark, "update_task", { taskId: made.task.id, occursOn: "next week", skip: true })) as { error?: string };
    assert.match(badDay.error ?? "", /occursOn takes a day/);
  });
});

describe("repeating task review fixes", () => {
  it("keeps a daily task daily with reminders up to a week before", async () => {
    for (const remind of [1440, 2880, 10080]) {
      const task = (await createRepeatingTask(mark, { title: `Daily ${remind}`, dueAt: at("2027-05-03", "14:00"), remindMinutes: remind }, { every: "day" })).body.task;
      await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-05-03T14:16:00Z") });
      assert.equal((await getTask(mark, task.id)).occursOn, "2027-05-04", `${remind}`);
      await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-05-03T14:30:00Z") });
      assert.equal((await getTask(mark, task.id)).occursOn, "2027-05-04", `${remind} stays on the next day`);
      await completeTask(mark, task.id);
      const next = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
      assert.equal(next.occurs_on, "2027-05-05");
    }
  });

  it("lets the creator of a teammate's open occurrence complete it and carries on", async () => {
    const task = (await createRepeatingTask(sam, { title: "Sam's for Priya", dueDate: "2027-05-04" }, { every: "week" })).body.task;
    await updateOccurrence(sam, { taskId: task.id }, { ownerId: priya.userId }, "all");
    await completeTask(sam, task.id);
    const next = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    assert.equal(next.occurs_on, "2027-05-11");
    assert.equal((await getTask(priya, next.id)).ownerId, priya.userId);
  });

  it("detaches an older done occurrence that is reopened, and the series keeps going", async () => {
    const task = await weekly("Older reopen", "2027-05-05");
    await completeTask(mark, task.id);
    const second = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    await completeTask(mark, second.id);
    await reopenTask(mark, task.id);
    assert.equal((await getTask(mark, task.id)).seriesId, null);
    const open = (await occurrences(task.seriesId!)).filter((row) => !row.completed && !row.archived);
    assert.deepEqual(open.map((row) => row.occurs_on), ["2027-05-19"]);
  });

  it("edits a done occurrence without asking for a scope", async () => {
    const task = await weekly("Done edit", "2027-05-06");
    await completeTask(mark, task.id);
    const renamed = (await updateOccurrence(mark, { taskId: task.id }, { title: "Done edit renamed" }, undefined)).body.task;
    assert.equal(renamed.title, "Done edit renamed");
    assert.equal((await seriesRow(task.seriesId!)).title, "Done edit");
  });

  it("treats archiving the open one as Skip this one, and Delete the series from a done one archives the open one", async () => {
    const task = await weekly("Archive skip", "2027-05-07");
    const archived = (await archiveTask(mark, task.id)).body.task;
    assert.equal(archived.archivedAt, null);
    assert.equal(archived.occursOn, "2027-05-14");
    await completeTask(mark, task.id);
    const open = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    await deleteSeries(mark, task.id);
    assert.ok((await seriesRow(task.seriesId!)).archived_at);
    assert.ok((await getTask(mark, open.id)).archivedAt);
  });

  it("counts after N times from the series start when the pattern changes", async () => {
    const task = (await createRepeatingTask(mark, { title: "Counted", dueDate: "2027-05-03" }, { every: "day", ends: { after: 5 } })).body.task;
    await completeTask(mark, task.id);
    const second = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    await completeTask(mark, second.id);
    const third = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    const changed = (await setTaskRepeat(mark, third.id, { every: "weekday", ends: { after: 5 } })).body.task;
    assert.equal(changed.repeat?.end, "2 more");
  });

  it("refuses a bad length on a new repeating task with a 400", async () => {
    await assert.rejects(createRepeatingTask(mark, { title: "Too long", dueDate: "2027-05-03", durationMinutes: 900 }, { every: "day" }), /between 5 and 480/);
    await assert.rejects(createRepeatingTask(mark, { title: "Month mo", dueDate: "2027-05-03" }, { every: "week", days: ["month"] }), /Choose days/);
    await assert.rejects(createRepeatingTask(mark, { title: "Mixed", dueDate: "2027-05-03" }, { every: "day", monthDay: 3 }), /only go with every: month/);
  });

  it("refuses a stale skip", async () => {
    const task = await weekly("Stale skip", "2027-05-08");
    await skipOccurrence(mark, { taskId: task.id });
    await assert.rejects(skipOccurrence(mark, { taskId: task.id }, { expect: "2027-05-08" }), /moved on already/);
  });

  it("binds tasks and series in the database", async () => {
    const own = (await createTask(sam, { title: "Sam's own" })).body.task;
    const marks = await weekly("Mark's binding", "2027-05-09");
    await assert.rejects(
      (await import("./helpers")).queryAsUser(sam.userId, "update crm.tasks set series_id = $2, occurs_on = '2027-05-10' where id = $1", [own.id, marks.seriesId]),
      /can't join|row-level|isn't in this workspace|can't add to that repeating task/,
    );
    await assert.rejects(
      (await import("./helpers")).queryAsUser(mark.userId, "update crm.task_series set current_task_id = $2 where id = $1", [marks.seriesId, own.id]),
      /must belong to it|row-level/,
    );
  });
});

describe("repeating task review round 2", () => {
  it("puts This one changes back to the series when the open one moves on", async () => {
    const task = await weekly("Series title", "2027-06-01", "09:00");
    await updateOccurrence(mark, { taskId: task.id }, { title: "Just this week", durationMinutes: 45, ownerId: sam.userId }, "this");
    await skipOccurrence(sam, { taskId: task.id });
    const moved = await getTask(mark, task.id);
    assert.deepEqual([moved.title, moved.durationMinutes, moved.ownerId, moved.occursOn], ["Series title", 45, sam.userId, "2027-06-08"], "Sam keeps the length of the one he holds");
    assert.deepEqual([moved.dueAt, moved.dueHasTime], ["2027-06-07T23:00:00.000Z", false], "still Sam's, so no time is put back");
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-06-15T01:00:00Z") });
    const rolled = await getTask(mark, task.id);
    assert.deepEqual([rolled.ownerId, rolled.occursOn, rolled.dueAt], [mark.userId, "2027-06-15", "2027-06-15T09:00:00.000Z"]);
  });

  it("lets a colleague handed one occurrence act on it but not on the series", async () => {
    const task = await weekly("Handed weekly", "2027-06-02", "09:00");
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await assert.rejects(updateOccurrence(sam, { taskId: task.id }, { title: "Renamed by Sam" }, "all"), /assignee or creator can change every date/);
    await assert.rejects(setTaskRepeat(sam, task.id, null), /assignee or creator can change every date/);
    await assert.rejects(setTaskRepeat(sam, task.id, { every: "day" }), /assignee or creator can change every date/);
    await assert.rejects(deleteSeries(sam, task.id), /assignee or creator can change every date/);
    await assert.rejects(skipOccurrence(sam, { seriesId: task.seriesId!, occursOn: "2027-06-16" }), /not found|assignee or creator/);
    await assert.rejects(
      (await import("./helpers")).queryAsUser(sam.userId, "update crm.task_series set title = 'Sam was here' where id = $1", [task.seriesId]),
      /assignee or creator can change every date/,
    );
    const renamed = (await updateOccurrence(sam, { taskId: task.id }, { title: "Sam's week" }, "this")).body.task;
    assert.equal(renamed.title, "Sam's week");
    await completeTask(sam, task.id);
    await reopenTask(sam, task.id);
    assert.equal((await getTask(sam, task.id)).completedAt, null);
    const open = (await occurrences(task.seriesId!)).filter((row) => !row.completed && !row.archived);
    assert.equal(open.length, 1);
  });

  it("refuses unclear assistant and API input", async () => {
    const task = await weekly("Strict input", "2027-06-03");
    const plain = (await createTask(mark, { title: "Plain one", dueDate: "2027-06-03" })).body.task;
    const skipText = (await runTool(mark, "update_task", { taskId: task.id, skip: "yes" })) as { error?: string };
    assert.match(skipText.error ?? "", /skip: true/);
    const badScope = (await runTool(mark, "update_task", { taskId: task.id, title: "x", repeatScope: "everything" })) as { error?: string };
    assert.match(badScope.error ?? "", /this, following or all/);
    const noDay = (await runTool(mark, "update_task", { seriesId: task.seriesId, skip: true })) as { error?: string };
    assert.match(noDay.error ?? "", /Send occursOn with seriesId/);
    const mismatch = (await runTool(mark, "update_task", { taskId: plain.id, seriesId: task.seriesId, title: "x", repeatScope: "this" })) as { error?: string };
    assert.match(mismatch.error ?? "", /isn't part of that repeating task/);
    const notRepeating = (await runTool(mark, "update_task", { taskId: plain.id, occursOn: "2027-06-10", skip: true })) as { error?: string };
    assert.match(notRepeating.error ?? "", /doesn't repeat/);
    await assert.rejects(createRepeatingTask(mark, { title: "Empty ends", dueDate: "2027-06-03" }, { every: "day", ends: {} }), /Choose when it ends/);
  });

  it("reads After N times back as the number chosen and leaves skipped dates out of what's left", async () => {
    const task = (await createRepeatingTask(mark, { title: "Ten times", dueDate: "2027-06-07" }, { every: "day", ends: { after: 10 } })).body.task;
    await completeTask(mark, task.id);
    const second = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    const changed = (await setTaskRepeat(mark, second.id, { every: "weekday", ends: { after: 10 } })).body.task;
    assert.deepEqual(changed.repeat?.ends, { count: 10, spent: 1 });
    assert.equal(changed.repeat?.end, "8 more");
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: shiftDay(changed.repeat!.next!.occursOn, 0) });
    assert.equal((await getTask(mark, second.id)).repeat?.end, "7 more");
  });
});

describe("repeating tasks moving workspace again", () => {
  it("moves a task that left its series, after stopping and repeating again, and after an undone repeat", async () => {
    const created = await createWorkspace(mark, { name: "Mark Ridgeon Two" });
    const ridgeon: UserActor = { ...mark, workspaceId: created.id, workspaceName: "Mark Ridgeon Two", role: "owner", scopes: scopesForRole("owner") };
    const acme = (await createCompany(mark, { name: "Acme Again", domain: "acme-again.test" })).body.company;
    const task = (await createTask(mark, { title: "Acme check", dueDate: "2027-06-04", companyId: acme.id })).body.task;
    await setTaskRepeat(mark, task.id, { every: "week" });
    await setTaskRepeat(mark, task.id, null);
    await setTaskRepeat(mark, task.id, { every: "day" });
    const second = (await createTask(mark, { title: "Acme second", dueDate: "2027-06-04", companyId: acme.id })).body.task;
    const repeated = await setTaskRepeat(mark, second.id, { every: "week" });
    await undoAuditEvent(mark, repeated.body.undo.find(Boolean)!, { operation: "undo_change" });
    await moveRecordsToWorkspace(mark, { companyIds: [acme.id], workspaceId: ridgeon.workspaceId }, { operation: "move_records", source: "web" });
    assert.equal((await getTask(ridgeon, task.id)).workspaceId, ridgeon.workspaceId);
    assert.equal((await getTask(ridgeon, second.id)).workspaceId, ridgeon.workspaceId);
  });
});

describe("repeating task review round 3", () => {
  it("keeps a series made from someone else's task moving when one occurrence is handed on", async () => {
    const original = (await createTask(sam, { title: "Sam's task for Mark", dueAt: at("2027-07-06", "09:00"), ownerId: mark.userId })).body.task;
    const made = (await setTaskRepeat(mark, original.id, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: made.id }, { ownerId: priya.userId }, "this");
    const rolled = await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-07-13T01:00:00Z") });
    assert.equal(rolled.rolled, 1);
    const back = await getTask(mark, made.id);
    assert.deepEqual([back.ownerId, back.occursOn], [mark.userId, "2027-07-13"]);
    await updateOccurrence(mark, { taskId: made.id }, { ownerId: priya.userId }, "this");
    const skipped = (await skipOccurrence(mark, { taskId: made.id })).body.task;
    assert.deepEqual([skipped.ownerId, skipped.occursOn], [mark.userId, "2027-07-20"]);
    await updateOccurrence(mark, { taskId: made.id }, { ownerId: priya.userId }, "this");
    const renamed = (await updateOccurrence(mark, { taskId: made.id }, { title: "Weekly for Mark" }, "all")).body.task;
    assert.equal(renamed.title, "Weekly for Mark");
    await deleteSeries(mark, made.id);
    assert.ok((await seriesRow(made.seriesId!)).archived_at);
    const [row] = await sql<{ roll_at: Date | null }>("select roll_at from crm.task_series where id = $1", [made.seriesId]);
    assert.equal(row.roll_at, null);
  });

  it("lets an agent complete its own task after its owner makes it repeat, and keeps agents to their own series", async () => {
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Repeat agent");
    const task = (await createTask(agent, { title: "Agent's weekly", dueDate: "2027-07-07", ownerId: mark.userId })).body.task;
    await setTaskRepeat(mark, task.id, { every: "week" });
    await completeTask(agent, task.id);
    const next = (await occurrences((await getTask(mark, task.id)).seriesId!)).find((row) => !row.completed)!;
    assert.equal(next.occurs_on, "2027-07-14");
    const marks = await weekly("Mark's own series", "2027-07-08");
    const touched = await withActor(agent, async (db) => {
      try {
        return (await db.query("update crm.task_series set title = 'Agent was here' where id = $1", [marks.seriesId])).rowCount;
      } catch (error) {
        return error instanceof Error ? error.message : "refused";
      }
    });
    assert.notEqual(touched, 1);
    assert.equal((await seriesRow(marks.seriesId!)).title, "Mark's own series");
  });

  it("refuses series changes by someone who doesn't own the series, with no created_by to lean on", async () => {
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Series agent");
    const task = (await createRepeatingTask(agent, { title: "Agent series", dueDate: "2027-07-09", ownerId: priya.userId }, { every: "week" })).body.task;
    await updateOccurrence(agent, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await assert.rejects(
      (await import("./helpers")).queryAsUser(sam.userId, "update crm.task_series set title = 'Sam was here', roll_at = now() where id = $1", [task.seriesId]),
      /assignee or creator can change every date|row-level/,
    );
  });

  it("lets a colleague relink their occurrence without touching the series", async () => {
    const task = await weekly("Relink weekly", "2027-07-10");
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await updateOccurrence(sam, { taskId: task.id }, { companyId: null }, undefined);
    assert.equal((await seriesRow(task.seriesId!)).current_task_id, task.id);
    const [series] = await sql<{ company_id: string | null }>("select company_id from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(series.company_id, companyId);
  });

  it("keeps the end when only the pattern changes", async () => {
    const task = (await createRepeatingTask(mark, { title: "Kept end", dueDate: "2027-07-12" }, { every: "week", ends: { on: "2027-09-30" } })).body.task;
    const changed = (await setTaskRepeat(mark, task.id, { every: "day" })).body.task;
    assert.deepEqual(changed.repeat?.ends, { until: "2027-09-30" });
  });
});

describe("repeating task review round 4", () => {
  it("hands a removed person's series to the remover, who can then change, stop and delete them", async () => {
    const rita = await join(await createUser("rita@series.test", "Rita Lowe"), "member");
    const ritas = (await createRepeatingTask(rita, { title: "Rita's weekly", dueDate: "2027-08-02" }, { every: "week" })).body.task;
    const second = (await createRepeatingTask(rita, { title: "Rita's daily", dueDate: "2027-08-02" }, { every: "day" })).body.task;
    await removeMember(mark, rita.userId);
    const [row] = await sql<{ owner_id: string; created_by_user_id: string }>("select owner_id, created_by_user_id from crm.task_series where id = $1", [ritas.seriesId]);
    assert.deepEqual(row, { owner_id: mark.userId, created_by_user_id: mark.userId });
    const renamed = (await updateOccurrence(mark, { taskId: ritas.id }, { title: "Weekly, Mark now" }, "all")).body.task;
    assert.equal(renamed.title, "Weekly, Mark now");
    await setTaskRepeat(mark, ritas.id, null);
    assert.ok((await seriesRow(ritas.seriesId!)).ended_at);
    await deleteSeries(mark, second.id);
    assert.ok((await seriesRow(second.seriesId!)).archived_at);
  });

  it("keeps a colleague's own day and time when they skip, and doesn't put the series reminder on a date-only move", async () => {
    const task = (await createRepeatingTask(mark, { title: "Timed with reminder", dueAt: at("2027-08-03", "09:00"), remindMinutes: 60 }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    const handed = await getTask(sam, task.id);
    assert.deepEqual([handed.dueHasTime, handed.remindMinutes], [false, null]);
    const skipped = (await skipOccurrence(sam, { taskId: task.id })).body.task;
    assert.deepEqual([skipped.occursOn, skipped.dueHasTime, skipped.remindMinutes], ["2027-08-10", false, null]);
    await updateOccurrence(sam, { taskId: task.id }, { dueAt: at("2027-08-10", "16:00"), dueHasTime: true }, "this");
    const viaTool = (await runTool(sam, "update_task", { taskId: task.id, skip: true })) as { task?: Task; error?: string };
    assert.equal(viaTool.error, undefined);
    assert.deepEqual([viaTool.task!.occursOn, viaTool.task!.dueAt], ["2027-08-17", "2027-08-17T16:00:00.000Z"]);
    const archived = (await archiveTask(sam, task.id)).body.task;
    assert.deepEqual([archived.archivedAt, archived.occursOn, archived.dueAt], [null, "2027-08-24", "2027-08-24T16:00:00.000Z"]);
    assert.ok((await listTaskParticipantsFor(task.id)).includes(mark.userId), "handing This one keeps the series owner tagged");
  });

  it("relinks every later one with repeatScope all, and only this one with this", async () => {
    const other = (await createCompany(mark, { name: "Relink Two", domain: "relink-two.test" })).body.company;
    const task = await weekly("Relink scopes", "2027-08-04");
    await updateOccurrence(mark, { taskId: task.id }, { companyId: other.id }, "this");
    let [series] = await sql<{ company_id: string | null }>("select company_id from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(series.company_id, companyId);
    await updateOccurrence(mark, { taskId: task.id }, { companyId: other.id }, "all");
    [series] = await sql<{ company_id: string | null }>("select company_id from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(series.company_id, other.id);
  });

  it("never lets someone outside the workspace read or change a series' tasks", async () => {
    const olly = await createUser("olly@elsewhere-series.test", "Olly Outside");
    const tasks = [await weekly("Isolated one", "2027-08-05"), (await createRepeatingTask(sam, { title: "Isolated two", dueDate: "2027-08-05" }, { every: "day" })).body.task];
    const attempts = [
      (task: Task) => getTask(olly, task.id),
      (task: Task) => updateOccurrence(olly, { taskId: task.id }, { title: "x" }, "this"),
      (task: Task) => updateOccurrence(olly, { taskId: task.id }, { title: "x" }, "all"),
      (task: Task) => skipOccurrence(olly, { taskId: task.id }),
      (task: Task) => skipOccurrence(olly, { seriesId: task.seriesId!, occursOn: "2027-08-12" }),
      (task: Task) => setTaskRepeat(olly, task.id, null),
      (task: Task) => deleteSeries(olly, task.id),
      (task: Task) => completeTask(olly, task.id),
    ];
    for (const task of tasks) {
      for (const attempt of attempts) await assert.rejects(attempt(task), /not found|isn't in this workspace|forbidden|can't/i);
      const visible = await withActor(olly, async (db) => (await db.query("select 1 from crm.tasks where series_id = $1 union all select 1 from crm.task_series where id = $1", [task.seriesId])).rowCount);
      assert.equal(visible, 0);
    }
  });

  it("keeps exactly one open occurrence per active series through the lifecycle", async () => {
    const task = (await createRepeatingTask(mark, { title: "Lifecycle", dueAt: at("2027-09-01", "10:00") }, { every: "day" })).body.task;
    const seriesId = task.seriesId!;
    const openOnes = async () => (await sql<{ total: number }>("select count(*)::int as total from crm.tasks where series_id = $1 and completed_at is null and archived_at is null", [seriesId]))[0].total;
    const current = async () => (await seriesRow(seriesId)).current_task_id!;
    const actions: [string, () => Promise<unknown>][] = [
      ["complete", async () => completeTask(mark, await current())],
      ["skip", async () => skipOccurrence(mark, { taskId: await current() })],
      ["this", async () => updateOccurrence(mark, { taskId: await current() }, { title: "Lifecycle this" }, "this")],
      ["all", async () => updateOccurrence(mark, { taskId: await current() }, { durationMinutes: 30 }, "all")],
      ["hand", async () => updateOccurrence(mark, { taskId: await current() }, { ownerId: sam.userId }, "this")],
      ["sam completes", async () => completeTask(sam, await current()).catch(() => undefined)],
      ["roll", async () => rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2027-12-31T23:00:00Z") })],
      ["archive", async () => archiveTask(mark, await current())],
      ["pattern", async () => setTaskRepeat(mark, await current(), { every: "weekday" })],
    ];
    for (let round = 0; round < 3; round += 1) {
      for (const [name, act] of actions) {
        await act();
        assert.equal(await openOnes(), 1, `${name} in round ${round}`);
      }
    }
    const done = (await sql<{ id: string }>("select id from crm.tasks where series_id = $1 and completed_at is not null order by occurs_on desc limit 1", [seriesId]))[0];
    await reopenTask(mark, done.id).catch(() => undefined);
    assert.ok((await openOnes()) <= 1);
  });
});

describe("repeating task review round 5", () => {
  async function handedSeries(title: string, day: string) {
    const original = (await createTask(sam, { title, dueAt: at(day, "09:00"), ownerId: mark.userId })).body.task;
    const made = (await setTaskRepeat(mark, original.id, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: made.id }, { ownerId: priya.userId }, "this");
    return made;
  }

  it("gives a tagged series owner the same validation and results as the task's creator", async () => {
    const outcome = async (actor: UserActor, other: UserActor, taskId: string, write: TaskWrite, scope: "all" | "following" | "this") => {
      const label = (id: string | null) => (id === priya.userId ? "priya" : id === actor.userId ? "actor" : id === other.userId ? "other" : id);
      try {
        const task = (await updateOccurrence(actor, { taskId }, write, scope)).body.task;
        const alerts = await sql("select 1 from crm.notifications where user_id = $1 and href like $2", [other.userId, `%${taskId}%`]);
        return {
          ok: true,
          title: task.title.replace(/^(Mark|Sam) side /, ""),
          dueHasTime: task.dueHasTime,
          dueAt: task.dueAt,
          durationMinutes: task.durationMinutes,
          priority: task.priority,
          ownerId: label(task.ownerId),
          alerts: alerts.length,
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    };
    const cases: [string, TaskWrite | ((other: UserActor) => TaskWrite)][] = [
      ["blank title", { title: "   " }],
      ["long length", { durationMinutes: 900 }],
      ["outsider", { ownerId: "00000000-0000-4000-8000-000000000099" }],
      ["bad time", { dueAt: "not a time", dueHasTime: true }],
      ["rename", { title: "Renamed weekly" }],
      ["length", { durationMinutes: 30 }],
      ["priority", { priority: "high" }],
      ["time", { dueAt: at("2027-10-05", "15:00"), dueHasTime: true }],
      ["hand on", (other) => ({ ownerId: other.userId })],
    ];
    for (const scope of ["all", "following", "this"] as const) {
      for (const [name, made] of cases) {
        const markSide = await handedSeries(`Mark side ${scope} ${name}`, "2027-10-05");
        const samSide = (await createRepeatingTask(sam, { title: `Sam side ${scope} ${name}`, dueAt: at("2027-10-05", "09:00"), ownerId: priya.userId }, { every: "week" })).body.task;
        const viaSeries = await outcome(mark, sam, markSide.id, typeof made === "function" ? made(sam) : made, scope);
        const asCreator = await outcome(sam, mark, samSide.id, typeof made === "function" ? made(mark) : made, scope);
        assert.deepEqual(viaSeries, asCreator, `${scope} ${name}`);
      }
    }
  });

  it("keeps an All change that hands the series on with a time date only", async () => {
    const task = await weekly("All hand-over", "2027-10-06", "09:00");
    const saved = (await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId, dueAt: at("2027-10-06", "11:00"), dueHasTime: true }, "all")).body.task;
    assert.deepEqual([saved.ownerId, saved.dueHasTime], [sam.userId, false]);
    assert.equal((await seriesRow(task.seriesId!)).at, null);
  });

  it("lets a tagged series owner delete the series and undo it", async () => {
    const task = await handedSeries("Owner undo", "2027-10-07");
    const deleted = (await deleteSeries(mark, task.id)).body;
    assert.ok((await getTask(mark, task.id)).archivedAt);
    await undoTaskEvents(mark, task.id, deleted.undo, { operation: "undo_change" });
    assert.equal((await getTask(mark, task.id)).archivedAt, null);
    assert.equal((await seriesRow(task.seriesId!)).archived_at, null);
  });

  it("lets the series' owner update its occurrences without seeing more or reaching other tasks", async () => {
    const { queryAsUser } = await import("./helpers");
    const task = await handedSeries("Policy check", "2027-10-09");
    const olly = await join(await createUser("olly5@series.test", "Olly Park"), "member");
    const loose = (await createTask(priya, { title: "Priya's own" })).body.task;
    const renamed = await queryAsUser(mark.userId, "update crm.tasks set title = 'Policy renamed' where id = $1 returning id", [task.id]);
    assert.equal(renamed.length, 1);
    assert.equal((await queryAsUser(mark.userId, "update crm.tasks set title = 'Nope' where id = $1 returning id", [loose.id])).length, 0);
    assert.equal((await queryAsUser(olly.userId, "update crm.tasks set title = 'Nope' where id = $1 returning id", [task.id])).length, 0);
    assert.equal((await queryAsUser(mark.userId, "select 1 from crm.tasks where id = $1", [loose.id])).length, 0);
  });

  it("records handing a removed person's series on, archived ones included", async () => {
    const rita = await join(await createUser("rita5@series.test", "Rita Moss"), "member");
    const live = (await createRepeatingTask(rita, { title: "Rita's live", dueDate: "2027-10-10" }, { every: "week" })).body.task;
    const gone = (await createRepeatingTask(rita, { title: "Rita's archived", dueDate: "2027-10-10" }, { every: "week" })).body.task;
    await deleteSeries(rita, gone.id);
    await removeMember(mark, rita.userId);
    const rows = await sql<{ owner_id: string; created_by_user_id: string }>("select owner_id, created_by_user_id from crm.task_series where id = any($1::uuid[]) order by title", [[live.seriesId, gone.seriesId]]);
    assert.deepEqual(rows, [{ owner_id: mark.userId, created_by_user_id: mark.userId }, { owner_id: mark.userId, created_by_user_id: mark.userId }]);
    const audits = await sql("select 1 from crm.audit_events where entity_id = $1 and event_type = 'task_series.updated' and changes ? 'handedOver'", [live.id]);
    assert.equal(audits.length, 1);
  });

  it("keeps completed, docs and email pins to the task's own people", async () => {
    const task = await handedSeries("Own fields", "2027-10-08");
    await assert.rejects(updateOccurrence(mark, { taskId: task.id }, { completed: true }, "all"), /Only the assignee or the task's creator/);
  });
});

describe("repeating task review round 6", () => {
  async function handedSeries(title: string, day: string) {
    const original = (await createTask(sam, { title, dueAt: at(day, "09:00"), ownerId: mark.userId })).body.task;
    const made = (await setTaskRepeat(mark, original.id, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: made.id }, { ownerId: priya.userId }, "this");
    return made;
  }
  const CANNOT = /Only the assignee or the task's creator can (change|reassign) it/;

  it("refuses a tagged series owner on the plain task paths of a handed occurrence", async () => {
    const task = await handedSeries("Plain paths", "2027-11-01");
    await assert.rejects(updateTask(mark, task.id, { title: "Plain rename" }), CANNOT);
    await assert.rejects(updateTask(mark, task.id, { ownerId: mark.userId }), CANNOT);
    await assert.rejects(archiveTask(mark, task.id), CANNOT);
    const { sendTaskToClickUpList } = await import("@/lib/crm/clickup");
    await assert.rejects(sendTaskToClickUpList(mark, task.id, "list-1"), CANNOT);
    const after = await getTask(mark, task.id);
    assert.deepEqual([after.title, after.ownerId, after.archivedAt, after.clickupListId], ["Plain paths", priya.userId, null, null]);
    assert.equal((await seriesRow(task.seriesId!)).ended_at, null);
  });

  it("leaves a completed occurrence with its own people", async () => {
    const task = await handedSeries("Done stays", "2027-11-02");
    await completeTask(priya, task.id);
    await assert.rejects(updateOccurrence(mark, { taskId: task.id }, { title: "Renamed done" }, "this"), CANNOT);
    await assert.rejects(updateTask(mark, task.id, { title: "Renamed done" }), CANNOT);
    await assert.rejects(updateTask(mark, task.id, { ownerId: mark.userId }), CANNOT);
    await assert.rejects(archiveTask(mark, task.id), CANNOT);
    await assert.rejects(reopenTask(mark, task.id), CANNOT);
    const { queryAsUser } = await import("./helpers");
    assert.equal((await queryAsUser(mark.userId, "update crm.tasks set title = 'Raw' where id = $1 returning id", [task.id])).length, 0);
    const done = await getTask(priya, task.id);
    assert.deepEqual([done.title, done.ownerId, Boolean(done.completedAt), done.archivedAt], ["Done stays", priya.userId, true, null]);
  });

  it("doesn't let a series owner complete an occurrence by raw SQL", async () => {
    const { queryAsUser } = await import("./helpers");
    const task = await handedSeries("Raw complete", "2027-11-11");
    await assert.rejects(queryAsUser(mark.userId, "update crm.tasks set completed_at = now() where id = $1 returning id", [task.id]), /can complete or reopen it/);
    assert.equal((await getTask(priya, task.id)).completedAt, null);
    await completeTask(priya, task.id);
    assert.ok((await getTask(priya, task.id)).completedAt);
  });

  it("lets a series owner undo their own This one and All edits", async () => {
    const one = await handedSeries("Undo this", "2027-11-03");
    const renamed = (await updateOccurrence(mark, { taskId: one.id }, { title: "Just this week" }, "this")).body;
    await undoTaskEvents(mark, one.id, renamed.undo, { operation: "undo_change" });
    assert.equal((await getTask(mark, one.id)).title, "Undo this");
    const all = await handedSeries("Undo all", "2027-11-04");
    const changed = (await updateOccurrence(mark, { taskId: all.id }, { title: "Every week", durationMinutes: 45 }, "all")).body;
    await undoTaskEvents(mark, all.id, changed.undo, { operation: "undo_change" });
    const back = await getTask(mark, all.id);
    assert.deepEqual([back.title, back.durationMinutes], ["Undo all", 15]);
    assert.equal((await seriesRow(all.seriesId!)).title, "Undo all");
  });

  it("tags the remover on the series they take over and refuses to undo the hand-over", async () => {
    const rita = await join(await createUser("rita6@series.test", "Rita Shaw"), "member");
    const task = (await createRepeatingTask(rita, { title: "Rita's handed", dueDate: "2027-11-05", ownerId: priya.userId }, { every: "week" })).body.task;
    await removeMember(mark, rita.userId);
    assert.ok((await listTaskParticipantsFor(task.id)).includes(mark.userId));
    assert.equal((await getTask(mark, task.id)).title, "Rita's handed");
    const [event] = await sql<{ id: string }>("select id from crm.audit_events where entity_id = $1 and event_type = 'task_series.updated' and changes ? 'handedOver'", [task.id]);
    await assert.rejects(undoAuditEvent(mark, event.id, { operation: "undo_change" }), /handed over when someone left/);
    const renamed = (await updateOccurrence(mark, { taskId: task.id }, { title: "Mark's now" }, "all")).body.task;
    assert.equal(renamed.title, "Mark's now");
  });

  it("puts a series the cron can't act on back instead of picking it every run", async () => {
    const task = await handedSeries("Cron can't", "2027-11-08");
    await sql("delete from crm.task_participants where task_id = $1 and user_id = $2", [task.id, mark.userId]);
    const now = Date.parse("2027-11-16T01:00:00Z");
    const first = await rollDueSeries({ deadline: Date.now() + 10_000, now });
    assert.ok(first.due >= 1);
    const [row] = await sql<{ roll_retry_at: string }>("select roll_retry_at::text from crm.task_series where id = $1", [task.seriesId]);
    assert.ok(Date.parse(row.roll_retry_at) > now, "pushed back");
    const again = await rollDueSeries({ deadline: Date.now() + 10_000, now });
    assert.equal(again.due, 0);
  });

  it("ignores an agent id in a member's session", async () => {
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Round 6 agent");
    const task = (await createRepeatingTask(agent, { title: "Agent weekly", dueDate: "2027-11-09", ownerId: priya.userId }, { every: "week" })).body.task;
    const olly = await join(await createUser("olly6@series.test", "Olly Ward"), "member");
    await sql("insert into crm.task_participants (task_id, user_id, added_by) values ($1, $2, $3)", [task.id, olly.userId, priya.userId]);
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('app.agent_id', $2, true)", [JSON.stringify({ sub: olly.userId, role: "authenticated" }), agent.agentId]);
      await client.query("set local role authenticated");
      const changed = await client.query("update crm.tasks set title = 'Olly' where id = $1 returning id", [task.id]);
      assert.equal(changed.rowCount, 0);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("refuses tagged people on series actions with the series message", async () => {
    const task = await handedSeries("Tagged refusals", "2027-11-10");
    const olly = await join(await createUser("olly7@series.test", "Olly Moss"), "member");
    await addTaskParticipants(priya, task.id, [olly.userId]);
    const SERIES = /assignee or creator can change every date\.$/;
    await assert.rejects(skipOccurrence(olly, { taskId: task.id }), SERIES);
    await assert.rejects(setTaskRepeat(olly, task.id, null), SERIES);
    await assert.rejects(endSeriesOn(olly, task.id, "2027-12-31"), SERIES);
    await assert.rejects(updateOccurrence(olly, { taskId: task.id }, { title: "Olly's" }, "all"), SERIES);
    await assert.rejects(deleteSeries(olly, task.id), SERIES);
  });
});

describe("repeating task review round 7", () => {
  it("leaves a series with nothing left to roll alone", async () => {
    const first = (await createRepeatingTask(mark, { title: "Twice only", dueDate: "2027-12-06" }, { every: "week", ends: { after: 2 } })).body.task;
    await completeTask(mark, first.id);
    const last = (await occurrences(first.seriesId!)).find((row) => !row.completed)!;
    await updateOccurrence(mark, { taskId: last.id }, { ownerId: priya.userId }, "this");
    await updateOccurrence(priya, { taskId: last.id }, { dueDate: "2027-12-15" }, "this");
    const audits = async () => (await sql("select 1 from crm.audit_events where entity_id = $1", [last.id])).length;
    const before = await audits();
    const runs = [];
    for (const day of ["2027-12-14", "2027-12-16", "2027-12-20", "2027-12-27"]) {
      runs.push((await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse(`${day}T09:00:00Z`) })).due);
    }
    assert.ok(runs.slice(1).every((due) => due === 0), JSON.stringify(runs));
    const [row] = await sql<{ roll_at: Date | null; roll_pending: boolean }>("select roll_at, roll_pending from crm.task_series where id = $1", [first.seriesId]);
    assert.deepEqual([row.roll_at, row.roll_pending], [null, false]);
    assert.equal(await audits(), before);
    const open = await getTask(priya, last.id);
    assert.deepEqual([open.occursOn, open.dueDate, open.completedAt], ["2027-12-13", "2027-12-15", null]);
  });
});

describe("repeating task review round 8", () => {
  it("doesn't let an assignee who isn't the series' owner change its bookkeeping by raw SQL", async () => {
    const { queryAsUser } = await import("./helpers");
    const task = (await createRepeatingTask(mark, { title: "Guarded", dueAt: at("2028-02-07", "09:00") }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    const refused = /Only the repeating task's assignee or creator can change every date|row-level/;
    await sql("update crm.task_series set roll_pending = true where id = $1", [task.seriesId]);
    for (const change of ["roll_retry_at = 'infinity'", "roll_at = 'infinity'", "roll_pending = false", "created_at = now() - interval '1 year'", "created_by_user_id = null", "title = 'Taken'"]) {
      await assert.rejects(queryAsUser(priya.userId, `update crm.task_series set ${change} where id = $1 returning id`, [task.seriesId]), refused, change);
    }
    const flagged = await queryAsUser(priya.userId, "update crm.task_series set roll_pending = true where id = $1 returning id", [task.seriesId]);
    assert.equal(flagged.length, 1, "anyone who can see it can still flag it for a refresh");
  });

  it("keeps a colleague's pending change when a roll fails, and only waits before trying again", async () => {
    const task = (await createRepeatingTask(mark, { title: "Fails once", dueAt: at("2028-01-03", "09:00") }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    await updateOccurrence(priya, { taskId: task.id }, { dueDate: "2028-01-04" }, "this");
    const state = async () =>
      (await sql<{ roll_pending: boolean; roll_at: string | null; roll_retry_at: string | null }>("select roll_pending, roll_at::text, roll_retry_at::text from crm.task_series where id = $1", [task.seriesId]))[0];
    assert.equal((await state()).roll_pending, true);
    const rollAt = (await state()).roll_at;
    await sql(`create or replace function public.fail_series_roll() returns trigger language plpgsql as $$ begin raise exception 'forced roll failure'; end; $$`);
    await sql(`create trigger fail_series_roll before update of occurs_on on crm.tasks for each row when (old.id = '${task.id}') execute function public.fail_series_roll()`);
    const now = Date.parse("2028-01-12T09:00:00Z");
    try {
      const failed = await rollDueSeries({ deadline: Date.now() + 10_000, now });
      assert.equal(failed.failed, 1);
      const after = await state();
      assert.equal(after.roll_pending, true, "the colleague's change still gets its refresh");
      assert.equal(after.roll_at, rollAt);
      assert.ok(Date.parse(after.roll_retry_at!) > now);
      assert.equal((await rollDueSeries({ deadline: Date.now() + 10_000, now })).due, 0);
    } finally {
      await sql("drop trigger if exists fail_series_roll on crm.tasks");
      await sql("drop function if exists public.fail_series_roll()");
    }
    const later = await rollDueSeries({ deadline: Date.now() + 10_000, now: now + 20 * 60_000 });
    assert.equal(later.rolled, 1);
    const done = await state();
    assert.deepEqual([done.roll_pending, done.roll_retry_at], [false, null]);
    assert.equal((await getTask(mark, task.id)).occursOn, "2028-01-10");
  });
});

describe("repeating task review round 10", () => {
  it("never lets a series write fail for someone who isn't its owner, whatever state the series is in", async () => {
    const { CrmError } = await import("@/lib/crm/errors");
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Round 10 agent");
    const olly = await join(await createUser("olly10@series.test", "Olly Ross"), "member");
    const problems: string[] = [];
    let day = 0;
    const setup = async (state: string) => {
      day += 7;
      const due = shiftDay("2028-03-06", day);
      const made = (await createTask(agent, { title: `Walk ${state} ${day}`, dueAt: at(due, "09:00"), ownerId: mark.userId })).body.task;
      const task = (await setTaskRepeat(mark, made.id, { every: "week" })).body.task;
      await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
      await addTaskParticipants(priya, task.id, [olly.userId]);
      if (state === "stopped") await setTaskRepeat(mark, task.id, null);
      if (state === "archived") await deleteSeries(mark, task.id);
      if (state === "split") await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: shiftDay(due, 14) }, { title: `Later ${day}` }, "following");
      return task;
    };
    const undoLast = async (actor: UserActor | AgentActor, taskId: string) => {
      const column = actor.type === "user" ? "actor_user_id" : "actor_agent_id";
      const [event] = await sql<{ id: string }>(
        `select id from crm.audit_events where entity_id = $1 and ${column} = $2 and event_type not like '%.undone' order by created_at desc, id desc limit 1`,
        [taskId, actor.type === "user" ? actor.userId : actor.agentId],
      );
      if (event) await undoAuditEvent(actor, event.id, { operation: "undo_change" });
    };
    for (const state of ["live", "stopped", "archived", "split"]) {
      for (const [name, actor] of [["assignee", priya], ["tagged", olly], ["agent", agent]] as const) {
        const task = await setup(state);
        const steps: [string, () => Promise<unknown>][] = [
          ["complete", () => completeTask(actor, task.id)],
          ["reopen", () => reopenTask(actor, task.id)],
          ["complete again", () => completeTask(actor, task.id)],
          ["reopen again", () => reopenTask(actor, task.id)],
          ["retime", () => updateTask(actor, task.id, { dueDate: shiftDay(task.occursOn!, 1) })],
          ["undo", () => undoLast(actor, task.id)],
          ["archive", () => archiveTask(actor, task.id)],
          ["restore", () => undoLast(actor, task.id)],
          ["undo again", () => undoLast(actor, task.id)],
        ];
        for (const [label, run] of steps) {
          try {
            await run();
          } catch (error) {
            const refusal = error instanceof CrmError;
            if (!refusal || (name === "assignee" && state !== "archived")) problems.push(`${state} ${name} ${label}: ${refusal ? "" : "unexpected "}${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("starts a split's later part even when the person who finishes the earlier part can't see it", async () => {
    const task = (await createRepeatingTask(mark, { title: "Split unseen", dueDate: "2029-03-06", ownerId: priya.userId }, { every: "week" })).body.task;
    await updateOccurrence(priya, { seriesId: task.seriesId!, occursOn: "2029-03-13" }, { title: "Split unseen later" }, "following");
    const [child] = await sql<{ id: string; current_task_id: string | null }>("select id, current_task_id from crm.task_series where split_from_id = $1", [task.seriesId]);
    assert.equal(child.current_task_id, null);
    await completeTask(mark, task.id);
    assert.ok((await seriesRow(task.seriesId!)).ended_at);
    const run = await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2029-03-07T09:00:00Z") });
    assert.ok(run.rolled >= 1, JSON.stringify(run));
    const [started] = await sql<{ current_task_id: string | null }>("select current_task_id from crm.task_series where id = $1", [child.id]);
    assert.ok(started.current_task_id);
    const open = await getTask(priya, started.current_task_id!);
    assert.deepEqual([open.title, open.occursOn], ["Split unseen later", "2029-03-13"]);
    assert.equal((await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2029-03-07T09:01:00Z") })).due, 0);
  });

  it("starts someone else's later part once the earlier part is stopped, with its last task still open", async () => {
    const task = (await createRepeatingTask(mark, { title: "Split stopped", dueDate: "2029-05-01", ownerId: priya.userId }, { every: "week" })).body.task;
    await updateOccurrence(priya, { seriesId: task.seriesId!, occursOn: "2029-05-15" }, { title: "Split stopped later" }, "following");
    await setTaskRepeat(mark, task.id, null);
    assert.equal((await getTask(priya, task.id)).completedAt, null);
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2029-05-02T09:00:00Z") });
    const [child] = await sql<{ current_task_id: string | null }>("select current_task_id from crm.task_series where split_from_id = $1", [task.seriesId]);
    assert.ok(child.current_task_id);
    assert.equal((await getTask(priya, child.current_task_id!)).occursOn, "2029-05-15");
  });

  it("stops your own later parts with the earlier part, and finishing its last task never starts them", async () => {
    const task = await weekly("Own split stopped", "2029-06-05");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2029-06-19" }, { title: "Own split later" }, "following");
    const stopped = (await setTaskRepeat(mark, task.id, null)).body;
    const [child] = await sql<{ id: string; ended_at: Date | null; current_task_id: string | null }>("select id, ended_at, current_task_id from crm.task_series where split_from_id = $1", [task.seriesId]);
    assert.ok(child.ended_at);
    await completeTask(mark, task.id);
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2029-06-20T09:00:00Z") });
    assert.equal((await sql<{ current_task_id: string | null }>("select current_task_id from crm.task_series where id = $1", [child.id]))[0].current_task_id, null);
    await reopenTask(mark, task.id);
    await undoTaskEvents(mark, task.id, stopped.undo, { operation: "undo_change" });
    assert.equal((await sql<{ ended_at: Date | null }>("select ended_at from crm.task_series where id = $1", [child.id]))[0].ended_at, null, "undoing the stop restarts the later part too");
  });

  it("stops your own later part behind a colleague's middle part", async () => {
    const task = await weekly("Chain first", "2029-09-03");
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2029-09-17" }, { title: "Chain middle" }, "following");
    const [middle] = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [task.seriesId]);
    await sql("update crm.task_series set owner_id = $2, created_by_user_id = $2 where id = $1", [middle.id, priya.userId]);
    const [later] = await sql<{ id: string }>(
      `insert into crm.task_series (workspace_id, owner_id, created_by_user_id, title, starts_on, rule, ends, split_from_id)
       select workspace_id, $2, $2, 'Chain later', starts_on + 14, rule, ends, id from crm.task_series where id = $1 returning id`,
      [middle.id, mark.userId],
    );
    const { queryAsUser } = await import("./helpers");
    assert.equal((await queryAsUser(mark.userId, "select 1 from crm.task_series where id = $1", [middle.id])).length, 0, "Mark can't see Priya's middle part");
    assert.deepEqual((await queryAsUser(priya.userId, "select id from crm.series_later_parts($1)", [task.seriesId])).length, 0, "only someone who can change the series gets its later parts");
    const stopped = (await setTaskRepeat(mark, task.id, null)).body;
    const ended = async (id: string) => (await sql<{ ended_at: Date | null; current_task_id: string | null }>("select ended_at, current_task_id from crm.task_series where id = $1", [id]))[0];
    assert.ok((await ended(later.id)).ended_at, "Mark's later part stops with his first part");
    assert.equal((await ended(middle.id)).ended_at, null, "Priya's middle part is hers");
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2029-09-04T09:00:00Z") });
    const started = (await ended(middle.id)).current_task_id;
    assert.ok(started, "Priya's part starts once Mark's first part has ended");
    await setTaskRepeat(priya, started!, null);
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2029-10-02T09:00:00Z") });
    assert.equal((await ended(later.id)).current_task_id, null, "Mark's later part never starts");
    await undoTaskEvents(mark, task.id, stopped.undo, { operation: "undo_change" });
    assert.equal((await ended(later.id)).ended_at, null, "undoing the stop restarts it");
  });

  it("treats Delete the series like a stop for later parts: yours end, a colleague's starts", async () => {
    const own = await weekly("Own split deleted", "2029-07-03");
    await updateOccurrence(mark, { seriesId: own.seriesId!, occursOn: "2029-07-17" }, { title: "Own split deleted later" }, "following");
    const [ownLater] = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [own.seriesId]);
    const deleted = (await deleteSeries(mark, own.id)).body;
    const state = async (id: string) => (await sql<{ ended_at: Date | null; current_task_id: string | null }>("select ended_at, current_task_id from crm.task_series where id = $1", [id]))[0];
    assert.ok((await state(ownLater.id)).ended_at);

    const theirs = (await createRepeatingTask(mark, { title: "Split deleted", dueDate: "2029-07-04", ownerId: priya.userId }, { every: "week" })).body.task;
    await updateOccurrence(priya, { seriesId: theirs.seriesId!, occursOn: "2029-07-18" }, { title: "Split deleted later" }, "following");
    const [theirLater] = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [theirs.seriesId]);
    await deleteSeries(mark, theirs.id);
    assert.equal((await state(theirLater.id)).ended_at, null);

    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2029-07-20T09:00:00Z") });
    assert.equal((await state(ownLater.id)).current_task_id, null, "your own later part never starts");
    const started = (await state(theirLater.id)).current_task_id;
    assert.ok(started, "a colleague's later part starts once the earlier part is deleted");
    assert.equal((await getTask(priya, started!)).occursOn, "2029-07-18");

    await undoTaskEvents(mark, own.id, deleted.undo, { operation: "undo_change" });
    assert.equal((await state(ownLater.id)).ended_at, null, "undoing the delete restores your later part");
  });

  it("starts a later part on its first date that isn't skipped, and ends it when every date is skipped", async () => {
    const task = await weekly("Skipped start", "2030-01-01");
    await skipOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2030-01-15" });
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2030-01-15" }, { title: "Skipped start later" }, "following");
    const [later] = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [task.seriesId]);
    await completeTask(mark, task.id);
    const second = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    await completeTask(mark, second.id);
    const [row] = await sql<{ current_task_id: string | null }>("select current_task_id from crm.task_series where id = $1", [later.id]);
    assert.ok(row.current_task_id);
    assert.deepEqual([(await getTask(mark, row.current_task_id!)).occursOn, (await getTask(mark, row.current_task_id!)).title], ["2030-01-22", "Skipped start later"]);
    assert.equal((await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2030-01-16T09:00:00Z") })).due, 0, "the started part isn't listed every run");

    const short = (await createRepeatingTask(mark, { title: "All skipped", dueDate: "2030-03-05" }, { every: "week", ends: { after: 3 } })).body.task;
    await skipOccurrence(mark, { seriesId: short.seriesId!, occursOn: "2030-03-19" });
    await updateOccurrence(mark, { seriesId: short.seriesId!, occursOn: "2030-03-19" }, { title: "All skipped later" }, "following");
    const [last] = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [short.seriesId]);
    await completeTask(mark, short.id);
    const middle = (await occurrences(short.seriesId!)).find((one) => !one.completed)!;
    await completeTask(mark, middle.id);
    const [ended] = await sql<{ ended_at: Date | null; current_task_id: string | null }>("select ended_at, current_task_id from crm.task_series where id = $1", [last.id]);
    assert.deepEqual([Boolean(ended.ended_at), ended.current_task_id], [true, null]);
    const due = await sql<{ series_id: string }>("select series_id from private.series_due_to_roll($1, 200)", [new Date(Date.parse("2030-03-20T09:00:00Z")).toISOString()]);
    assert.ok(!due.some((row) => row.series_id === last.id), "the ended part isn't listed again");
  });

  it("backs off a later part with no task when it can't be started", async () => {
    const task = (await createRepeatingTask(mark, { title: "Backs off", dueDate: "2030-05-07", ownerId: priya.userId }, { every: "week" })).body.task;
    await updateOccurrence(priya, { seriesId: task.seriesId!, occursOn: "2030-05-21" }, { title: "Backs off later" }, "following");
    const [later] = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [task.seriesId]);
    const now = Date.parse("2030-05-08T09:00:00Z");
    await sql("select private.delay_series_roll($1, $2, $3)", [later.id, new Date(now + 15 * 60_000).toISOString(), new Date(now).toISOString()]);
    const [row] = await sql<{ roll_retry_at: Date | null }>("select roll_retry_at from crm.task_series where id = $1", [later.id]);
    assert.ok(row.roll_retry_at && row.roll_retry_at.getTime() > now);
  });

  it("starts a colleague's later part from the cron with the earlier part's ClickUp list and assignee", async () => {
    const task = (await createRepeatingTask(mark, { title: "Split list", dueDate: "2030-07-02", ownerId: priya.userId }, { every: "week" })).body.task;
    await updateOccurrence(priya, { seriesId: task.seriesId!, occursOn: "2030-07-09" }, { title: "Split list later" }, "following");
    const [later] = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [task.seriesId]);
    await sql("update crm.tasks set clickup_list_id = 'list-9' where id = $1", [task.id]);
    await sql("update crm.task_series set owner_id = null where id = $1", [later.id]);
    await completeTask(mark, task.id);
    await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2030-07-03T09:00:00Z") });
    const [row] = await sql<{ current_task_id: string | null }>("select current_task_id from crm.task_series where id = $1", [later.id]);
    const started = await getTask(priya, row.current_task_id!);
    assert.deepEqual([started.clickupListId, started.ownerId], ["list-9", priya.userId]);
  });

  it("won't bring back a deleted series whose open task has left it", async () => {
    const original = (await createTask(sam, { title: "Left behind", dueAt: at("2030-09-03", "09:00"), ownerId: mark.userId })).body.task;
    const task = (await setTaskRepeat(mark, original.id, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    const deleted = (await deleteSeries(mark, task.id)).body;
    const restored = await withActor(priya, (db) => unarchiveTaskInDb(db, priya, task.id, { operation: "unarchive_task" }));
    assert.deepEqual([restored.task.archivedAt, restored.task.seriesId], [null, null]);
    await assert.rejects(undoTaskEvents(mark, task.id, deleted.undo, { operation: "undo_change" }), /open task has left/);
    assert.ok((await seriesRow(task.seriesId!)).archived_at);
  });

  it("doesn't make your reopened task the open one past an occurrence you can't see", async () => {
    const olly = await join(await createUser("olly11@series.test", "Olly Vale"), "member");
    const first = (await createRepeatingTask(mark, { title: "Hidden middle", dueDate: "2029-08-06", ownerId: priya.userId }, { every: "week" })).body.task;
    await completeTask(priya, first.id);
    const second = (await occurrences(first.seriesId!)).find((row) => !row.completed)!;
    await updateOccurrence(mark, { taskId: second.id }, { ownerId: olly.userId }, "this");
    await sql("delete from crm.task_participants where task_id = $1 and user_id = $2", [second.id, priya.userId]);
    await assert.rejects(getTask(priya, second.id), /not found/i);
    await completeTask(olly, second.id);
    const third = (await occurrences(first.seriesId!)).find((row) => !row.completed)!;
    assert.equal((await getTask(priya, third.id)).ownerId, priya.userId);
    await reopenTask(priya, first.id);
    const series = await seriesRow(first.seriesId!);
    assert.equal(series.current_task_id, third.id, "the open one stays the open one");
    const open = await getTask(priya, third.id);
    assert.deepEqual([open.archivedAt, open.completedAt], [null, null]);
    const reopened = await getTask(priya, first.id);
    assert.deepEqual([reopened.completedAt, reopened.seriesId], [null, null]);
  });
});

describe("repeating task review round 14", () => {
  it("puts the series' links back when a link change on the open one is undone", async () => {
    const { relinkTaskUndoable, undoTaskLinkChange } = await import("@/lib/crm/task-act");
    const contact = (await createContact(mark, { firstName: "Undo", lastName: "Link", email: "undo.link@series.test" })).body.contact;
    const task = await weekly("Link undo", "2030-11-05");
    const linked = await relinkTaskUndoable(mark, task.id, { contactId: contact.id }, { operation: "link_task", source: "web" });
    const linkedSeries = await sql<{ contact_id: string | null }>("select contact_id from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(linkedSeries[0].contact_id, contact.id, "the link follows the series");
    await undoTaskLinkChange(mark, task.id, linked.undo!);
    const series = await sql<{ contact_id: string | null }>("select contact_id from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(series[0].contact_id, null, "undo puts the series' link back");
    await completeTask(mark, task.id);
    const next = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    assert.equal((await getTask(mark, next.id)).contactId, null, "the next date has the original link");
  });

  it("leaves the series alone when a This one link change is undone", async () => {
    const contact = (await createContact(mark, { firstName: "This", lastName: "Only", email: "this.only@series.test" })).body.contact;
    const other = (await createCompany(mark, { name: "This Only Co", domain: "this-only.test" })).body.company;
    const task = await weekly("This link undo", "2030-11-07");
    const before = (await sql<{ company_id: string | null; contact_id: string | null }>("select company_id, contact_id from crm.task_series where id = $1", [task.seriesId]))[0];
    await updateOccurrence(mark, { taskId: task.id }, { contactId: contact.id }, "this");
    const second = (await updateOccurrence(mark, { taskId: task.id }, { companyId: other.id }, "this")).body;
    await undoTaskEvents(mark, task.id, second.undo, { operation: "undo_change" });
    const after = (await sql<{ company_id: string | null; contact_id: string | null }>("select company_id, contact_id from crm.task_series where id = $1", [task.seriesId]))[0];
    assert.deepEqual(after, before);
    assert.equal((await getTask(mark, task.id)).contactId, contact.id, "the occurrence keeps its own earlier change");
  });

  it("lets a later series link change win over undoing an earlier followed one", async () => {
    const { relinkTaskUndoable, undoTaskLinkChange } = await import("@/lib/crm/task-act");
    const contact = (await createContact(mark, { firstName: "Later", lastName: "Wins", email: "later.wins@series.test" })).body.contact;
    const other = (await createCompany(mark, { name: "Later Wins Co", domain: "later-wins.test" })).body.company;
    const task = await weekly("Later wins", "2030-11-08");
    const linked = await relinkTaskUndoable(mark, task.id, { contactId: contact.id }, { operation: "link_task", source: "web" });
    await updateOccurrence(mark, { taskId: task.id }, { companyId: other.id }, "all");
    await undoTaskLinkChange(mark, task.id, linked.undo!);
    const series = (await sql<{ company_id: string | null; contact_id: string | null }>("select company_id, contact_id from crm.task_series where id = $1", [task.seriesId]))[0];
    assert.deepEqual(series, { company_id: other.id, contact_id: contact.id });
    assert.equal((await getTask(mark, task.id)).contactId, null);
  });

  it("keeps a colleague's link change and its undo to their occurrence", async () => {
    const { relinkTaskUndoable, undoTaskLinkChange } = await import("@/lib/crm/task-act");
    const contact = (await createContact(mark, { firstName: "Theirs", lastName: "Only", email: "theirs.only@series.test" })).body.contact;
    const task = await weekly("Colleague link", "2030-11-06");
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    const linked = await relinkTaskUndoable(priya, task.id, { contactId: contact.id }, { operation: "link_task", source: "web" });
    const contactOf = async () => (await sql<{ contact_id: string | null }>("select contact_id from crm.task_series where id = $1", [task.seriesId]))[0].contact_id;
    assert.equal(await contactOf(), null);
    await undoTaskLinkChange(priya, task.id, linked.undo!);
    assert.equal((await getTask(priya, task.id)).contactId, null);
    assert.equal(await contactOf(), null);
  });
});

describe("repeating task review round 16", () => {
  const seriesLinks = async (seriesId: string) => (await sql<{ company_id: string | null; contact_id: string | null }>("select company_id, contact_id from crm.task_series where id = $1", [seriesId]))[0];

  it("keeps a This one link change off the series when a later save changes no link", async () => {
    const { relinkTaskUndoable } = await import("@/lib/crm/task-act");
    const contact = (await createContact(mark, { firstName: "Kept", lastName: "Here", email: "kept.here@series.test" })).body.contact;
    const task = await weekly("No link save", "2031-01-07");
    await updateOccurrence(mark, { taskId: task.id }, { contactId: contact.id }, "this");
    await sql("update crm.tasks set mail_thread_key = $2 where id = $1", [task.id, `${mark.userId}|thread-r16`]);
    await relinkTaskUndoable(mark, task.id, { mailThreadKey: null }, { operation: "link_task", source: "web" });
    assert.deepEqual(await seriesLinks(task.seriesId!), { company_id: companyId, contact_id: null });
    await updateOccurrence(mark, { taskId: task.id }, { companyId }, undefined);
    assert.deepEqual(await seriesLinks(task.seriesId!), { company_id: companyId, contact_id: null });
    assert.equal((await getTask(mark, task.id)).contactId, contact.id);
  });

  it("follows only the link that changed", async () => {
    const { relinkTaskUndoable } = await import("@/lib/crm/task-act");
    const contact = (await createContact(mark, { firstName: "Only", lastName: "This", email: "only.this@series.test" })).body.contact;
    const other = (await createCompany(mark, { name: "Followed Co", domain: "followed-co.test" })).body.company;
    const task = await weekly("One field follows", "2031-01-08");
    await updateOccurrence(mark, { taskId: task.id }, { contactId: contact.id }, "this");
    await relinkTaskUndoable(mark, task.id, { companyId: other.id }, { operation: "link_task", source: "web" });
    assert.deepEqual(await seriesLinks(task.seriesId!), { company_id: other.id, contact_id: null });
  });

  it("lists a followed link change as one undoable change, and undoes all of it", async () => {
    const { relinkTaskUndoable } = await import("@/lib/crm/task-act");
    const { listRecentChanges } = await import("@/lib/crm/undo");
    const contact = (await createContact(mark, { firstName: "One", lastName: "Change", email: "one.change@series.test" })).body.contact;
    const task = await weekly("One change", "2031-01-09");
    await relinkTaskUndoable(mark, task.id, { contactId: contact.id }, { operation: "link_task", source: "web" });
    const recent = (await listRecentChanges(mark, { entityType: "task", limit: 10 })).filter((change) => change.entityId === task.id);
    const newest = recent[0];
    assert.equal(recent.filter((change) => change.at === newest.at).length, 1);
    assert.deepEqual([newest.type, newest.canUndo], ["task.updated", true]);
    await undoAuditEvent(mark, newest.id, { operation: "undo_change" });
    assert.equal((await getTask(mark, task.id)).contactId, null);
    assert.deepEqual(await seriesLinks(task.seriesId!), { company_id: companyId, contact_id: null });
  });

  it("undoes both halves of an All change from the newest change", async () => {
    const { listRecentChanges } = await import("@/lib/crm/undo");
    const task = await weekly("Both halves", "2031-01-10");
    await updateOccurrence(mark, { taskId: task.id }, { title: "Both halves renamed" }, "all");
    const recent = (await listRecentChanges(mark, { entityType: "task", limit: 10 })).filter((change) => change.entityId === task.id);
    assert.equal(recent.filter((change) => change.at === recent[0].at).length, 1);
    await undoAuditEvent(mark, recent[0].id, { operation: "undo_change" });
    assert.equal((await getTask(mark, task.id)).title, "Both halves");
    assert.equal((await seriesRow(task.seriesId!)).title, "Both halves");
  });

  it("never reads a task from another workspace for a later part", async () => {
    const { queryAsUser } = await import("./helpers");
    const task = (await createRepeatingTask(mark, { title: "Moved previous", dueDate: "2031-02-04", ownerId: priya.userId }, { every: "week" })).body.task;
    await updateOccurrence(priya, { seriesId: task.seriesId!, occursOn: "2031-02-18" }, { title: "Moved previous later" }, "following");
    const [later] = await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [task.seriesId]);
    assert.equal((await queryAsUser(priya.userId, "select id from crm.series_split_previous($1)", [later.id])).length, 1);
    const elsewhere = await createWorkspace(mark, { name: "Elsewhere 16" });
    await sql("update crm.tasks set workspace_id = $2, owner_id = $3 where id = $1", [task.id, elsewhere.id, mark.userId]);
    assert.equal((await queryAsUser(priya.userId, "select id from crm.series_split_previous($1)", [later.id])).length, 0);
    assert.equal((await queryAsUser(mark.userId, "select id from crm.series_later_parts($1)", [task.seriesId])).length, 1);
    await sql("update crm.task_series set workspace_id = $2, owner_id = $3 where id = $1", [later.id, elsewhere.id, mark.userId]);
    assert.equal((await queryAsUser(mark.userId, "select id from crm.series_later_parts($1)", [task.seriesId])).length, 0);
  });
});

describe("repeating tasks and docs", () => {
  it("carries the open one's doc links to the next one", async () => {
    const doc = (await createDoc(mark, { title: "Weekly agenda", content: "Points to cover." })).id;
    const task = (await createRepeatingTask(mark, { title: "Agenda call", dueDate: "2027-05-10", docIds: [doc] }, { every: "week" })).body.task;
    assert.deepEqual(task.docIds, [doc]);
    await completeTask(mark, task.id);
    const next = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    assert.deepEqual((await getTask(mark, next.id)).docIds, [doc]);
  });
});

describe("repeating tasks in ClickUp", () => {
  it("skips an occurrence deleted in ClickUp and deletes an undone next one there", async () => {
    const task = await weekly("ClickUp weekly", "2027-03-03", "09:00");
    await sql("update crm.tasks set clickup_task_id = 'cu-1', clickup_list_id = 'list-1', clickup_url = 'https://app.clickup.test/t/cu-1' where id = $1", [task.id]);
    const skipped = await withActor(mark, (db) => skipDeletedOccurrenceInDb(db, mark, task.id, { operation: "clickup_deleted", source: "clickup" }));
    assert.equal(skipped, true);
    const [row] = await sql<{ occurs_on: string; clickup_task_id: string | null; clickup_list_id: string | null; archived_at: Date | null }>(
      "select occurs_on::text as occurs_on, clickup_task_id, clickup_list_id, archived_at from crm.tasks where id = $1",
      [task.id],
    );
    assert.deepEqual(row, { occurs_on: "2027-03-10", clickup_task_id: null, clickup_list_id: "list-1", archived_at: null });

    await completeTask(mark, task.id);
    const next = (await occurrences(task.seriesId!)).find((item) => !item.completed)!;
    const [carried] = await sql<{ clickup_list_id: string | null }>("select clickup_list_id from crm.tasks where id = $1", [next.id]);
    assert.equal(carried.clickup_list_id, "list-1");
    await sql("update crm.tasks set clickup_task_id = 'cu-2' where id = $1", [next.id]);
    await reopenTask(mark, task.id);
    const [gone] = await sql<{ archived: boolean; sync: Record<string, unknown> }>("select archived_at is not null as archived, clickup_sync as sync from crm.tasks where id = $1", [next.id]);
    assert.equal(gone.archived, true);
    assert.equal(gone.sync.deleteRemote, true);
    const calls: { url: string; method: string }[] = [];
    const api = clickupClient({
      token: "pk_test",
      baseUrl: "https://clickup.test/api/v2",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        return new Response(calls.length === 1 ? "{}" : "", { status: calls.length === 1 ? 200 : 404 });
      },
    });
    assert.equal(await api.deleteTask("cu-2"), true);
    assert.equal(await api.deleteTask("cu-gone"), false);
    assert.deepEqual(calls, [
      { url: "https://clickup.test/api/v2/task/cu-2", method: "DELETE" },
      { url: "https://clickup.test/api/v2/task/cu-gone", method: "DELETE" },
    ]);
  });
});

describe("repeating tasks moving workspace", () => {
  it("moves a series with its open task and takes done ones left behind out of it", async () => {
    const created = await createWorkspace(mark, { name: "Mark Ridgeon" });
    const ridgeon: UserActor = { ...mark, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    const halden = (await createCompany(mark, { name: "Halden Move", domain: "halden-move.test" })).body.company;
    const task = (await createRepeatingTask(mark, { title: "Halden weekly", dueAt: at("2027-03-02", "09:00"), companyId: halden.id }, { every: "week" })).body.task;
    await completeTask(mark, task.id);
    const open = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    await moveRecordsToWorkspace(mark, { companyIds: [halden.id], workspaceId: ridgeon.workspaceId }, { operation: "move_records", source: "web" });
    const [series] = await sql<{ workspace_id: string; company_id: string; current_task_id: string }>("select workspace_id, company_id, current_task_id from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(series.workspace_id, ridgeon.workspaceId);
    assert.equal(series.current_task_id, open.id);
    const moved = await getTask(ridgeon, open.id);
    assert.equal(moved.seriesId, task.seriesId);
    assert.equal(moved.repeat?.current, true);
    await completeTask(ridgeon, open.id);
    const next = (await occurrences(task.seriesId!)).filter((row) => !row.completed);
    assert.equal(next.length, 1);
    assert.equal((await getTask(ridgeon, next[0].id)).companyId, series.company_id);
  });
});

describe("repeating task privacy", () => {
  it("shows a series only to the people who can see its tasks, and carries tags forward", async () => {
    const task = (await createRepeatingTask(sam, { title: "Sam's private check", dueAt: at("2027-03-02", "11:00") }, { every: "week" })).body.task;
    const visible = async (user: UserActor) =>
      (await getPool().query("select 1")).rowCount !== null &&
      (await import("@/lib/crm/context")).withActor(user, async (db) => (await db.query("select id from crm.task_series where id = $1", [task.seriesId])).rowCount ?? 0);
    assert.equal(await visible(sam), 1);
    assert.equal(await visible(priya), 0);
    await assert.rejects(getTask(priya, task.id), /not found/i);
    await assert.rejects(skipOccurrence(priya, { taskId: task.id }), /not found/i);
    await assert.rejects(skipOccurrence(priya, { seriesId: task.seriesId!, occursOn: "2027-03-09" }), /not found/i);

    assert.equal(await visible(ada), 0, "an admin can't see someone else's series");
    await assert.rejects(getTask(ada, task.id), /not found/i);
    await addTaskParticipants(sam, task.id, [priya.userId]);
    assert.equal(await visible(priya), 1);
    await assert.rejects(updateOccurrence(priya, { taskId: task.id }, { title: "Mine now" }, "all"), /assignee or creator can change every date/);
    await completeTask(sam, task.id);
    const next = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    assert.equal((await getTask(priya, next.id)).title, "Sam's private check");
    assert.equal(await visible(priya), 1);
    assert.ok(ada);
  });
});

export type { Task };
