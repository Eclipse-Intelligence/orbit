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
  skipOccurrence,
  TOO_MANY_SERIES,
  updateOccurrence,
} from "@/lib/crm/task-series";
import { addTaskParticipants, completeTask, createTask, getTask, listTasks, reopenTask, updateTask } from "@/lib/crm/tasks";
import type { Task, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { undoAuditEvent } from "@/lib/crm/undo";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PATCH as restUpdateTask } from "@/app/api/v1/tasks/[id]/route";
import { POST as restCreateTask } from "@/app/api/v1/tasks/route";
import { runTool } from "@/lib/assistant/tools";
import { SCOPES } from "@/lib/crm/scopes";
import { createCrmMcpServer } from "@/server/mcp/server";
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

    const split = (await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2027-03-08" }, { dueAt: at("2027-03-08", "07:00"), dueHasTime: true }, "following")).body.task;
    assert.notEqual(split.seriesId, task.seriesId);
    assert.equal(split.occursOn, "2027-03-08");
    assert.equal(split.dueAt, "2027-03-08T07:00:00.000Z");
    assert.deepEqual((await seriesRow(task.seriesId!)).ends, { until: "2027-03-07" });
    assert.equal((await seriesRow(split.seriesId!)).at, "07:00");
    const listed = (await listTasks(mark, { query: "Walk Rex" })).data.map((item) => item.occursOn).sort();
    assert.deepEqual(listed, ["2027-03-01", "2027-03-08"]);
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
    assert.equal(following.task.title, "Review the pipeline");
    assert.equal(following.task.occursOn, "2027-04-30");
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
