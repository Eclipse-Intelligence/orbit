import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
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
import { addTaskParticipants, archiveTask, completeTask, createTask, getTask, listTasks, reopenTask, updateTask } from "@/lib/crm/tasks";
import type { Task, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { undoAuditEvent } from "@/lib/crm/undo";
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
    const passed = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const walk = (await createRepeatingTask(mark, { title: "Walk the dog", dueAt: passed }, { every: "day" })).body.task;
    assert.equal(walk.occursOn, shiftDay(today, 1));
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
    assert.equal(pending.roll_pending, false);
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
      /can't join|row-level|isn't in this workspace/,
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
    assert.deepEqual([moved.title, moved.durationMinutes, moved.ownerId, moved.occursOn], ["Series title", 15, sam.userId, "2027-06-08"]);
    assert.equal(moved.dueAt, "2027-06-08T09:00:00.000Z");
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
    await assert.rejects(updateOccurrence(priya, { taskId: task.id }, { title: "Mine now" }, "all"), /Only the assignee|can't|not found/i);
    await completeTask(sam, task.id);
    const next = (await occurrences(task.seriesId!)).find((row) => !row.completed)!;
    assert.equal((await getTask(priya, next.id)).title, "Sam's private check");
    assert.equal(await visible(priya), 1);
    assert.ok(ada);
  });
});

export type { Task };
