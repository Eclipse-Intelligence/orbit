import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { scopesForRole } from "@/lib/crm/scopes";
import { taskRemindChoices } from "@/lib/crm/task-snooze";
import { groupTasksByDue, taskGroupKind } from "@/lib/crm/task-views";
import { addTaskParticipants, archiveTask, completeTask, createTask, getTask, reopenTask } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let sam: UserActor;
let ada: UserActor;
let priya: UserActor;
let olly: UserActor;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@list.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@list.test", "Sam Member"), "member");
  ada = await join(await createUser("ada@list.test", "Ada Admin"), "admin");
  priya = await join(await createUser("priya@list.test", "Priya Nair"), "member");
  olly = await createUser("olly@elsewhere.test", "Olly Outside");
});

async function events(id: string) {
  return sql<{ event_type: string }>("select event_type from crm.audit_events where entity_id = $1 and event_type in ('task.updated', 'task.reopened') order by created_at, id", [id]);
}

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("task list", () => {
  it("reopens a task marked done by mistake and records it", async () => {
    const task = (await createTask(mark, { title: "Call Jane about the renewal", dueAt: "2026-11-20T15:00:00Z" })).body.task;
    await completeTask(mark, task.id, { provenance: { operation: "complete_task", source: "web" } });
    assert.ok((await getTask(mark, task.id)).completedAt);

    const reopened = (await reopenTask(mark, task.id, { provenance: { operation: "reopen_task", source: "web" } })).body.task;
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.dueAt, "2026-11-20T15:00:00.000Z");
    const events = await sql<{ event_type: string; operation: string }>(
      "select event_type, operation from crm.audit_events where entity_id = $1 and event_type in ('task.completed', 'task.reopened') order by created_at, id",
      [task.id],
    );
    assert.deepEqual(
      events.map((event) => [event.event_type, event.operation]),
      [
        ["task.completed", "complete_task"],
        ["task.reopened", "reopen_task"],
      ],
    );
  });

  it("only lets people who can change a task reopen it", async () => {
    const task = (await createTask(mark, { title: "Send Halden the pricing", ownerId: mark.userId })).body.task;
    await addTaskParticipants(mark, task.id, [sam.userId]);
    await completeTask(mark, task.id);
    await assert.rejects(reopenTask(sam, task.id), /Only the assignee/);
    assert.ok((await getTask(mark, task.id)).completedAt);
  });

  it("lets an admin reopen someone else's task", async () => {
    const task = (await createTask(sam, { title: "Send Northwind the contract", ownerId: sam.userId })).body.task;
    await completeTask(sam, task.id);
    const reopened = (await reopenTask(ada, task.id)).body.task;
    assert.equal(reopened.completedAt, null);
  });

  it("hides a task from people who can't see it and from other workspaces", async () => {
    const task = (await createTask(sam, { title: "Private follow-up", ownerId: sam.userId })).body.task;
    await completeTask(sam, task.id);
    await assert.rejects(reopenTask(priya, task.id), /not found/i);
    await assert.rejects(reopenTask(olly, task.id), /not found/i);
    assert.ok((await getTask(sam, task.id)).completedAt);
  });

  it("does nothing to an open or archived task", async () => {
    const open = (await createTask(mark, { title: "Still to do" })).body.task;
    const same = (await reopenTask(mark, open.id)).body.task;
    assert.equal(same.completedAt, null);
    assert.deepEqual(await events(open.id), []);

    const archived = (await createTask(mark, { title: "Done and archived" })).body.task;
    await completeTask(mark, archived.id);
    await archiveTask(mark, archived.id);
    const untouched = (await reopenTask(mark, archived.id)).body.task;
    assert.ok(untouched.completedAt);
    assert.deepEqual(await events(archived.id), []);
  });

  it("groups by London days across the end of British Summer Time", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const kinds = ["2026-10-24T22:59:00Z", "2026-10-24T23:30:00Z", "2026-10-25T23:59:00Z", "2026-10-26T00:00:00Z"].map((dueAt) =>
      taskGroupKind(dueAt, now, "Europe/London"),
    );
    assert.deepEqual(kinds, ["overdue", "today", "today", "upcoming"]);
  });

  it("groups the All view under Overdue, Today, Upcoming and No date", () => {
    const now = Date.parse("2026-11-12T10:00:00Z");
    const tasks = [
      { id: "a", dueAt: "2026-11-10T09:00:00Z" },
      { id: "b", dueAt: "2026-11-12T08:00:00Z" },
      { id: "c", dueAt: "2026-11-12T23:30:00Z" },
      { id: "d", dueAt: "2026-11-13T00:30:00Z" },
      { id: "e", dueAt: null },
      { id: "f", dueAt: "2027-01-04T09:00:00Z" },
    ];
    const groups = groupTasksByDue(tasks, now, "Europe/London");
    assert.deepEqual(
      groups.map((group) => [group.kind, group.label, group.tasks.map((task) => task.id)]),
      [
        ["overdue", "Overdue", ["a"]],
        ["today", "Today", ["b", "c"]],
        ["upcoming", "Upcoming", ["d", "f"]],
        ["none", "No date", ["e"]],
      ],
    );
    assert.deepEqual(groupTasksByDue([], now), []);
    assert.equal(taskGroupKind("2026-11-12T23:30:00Z", now, "America/New_York"), "today");
    assert.equal(taskGroupKind("2026-11-12T05:00:00Z", now, "America/New_York"), "today");
    assert.equal(taskGroupKind("2026-11-12T04:00:00Z", now, "America/New_York"), "overdue");
  });

  it("offers Later today, then the working-day choices, for Remind me", () => {
    const morning = taskRemindChoices("2026-11-12T15:00:00Z", new Date("2026-11-12T10:00:00Z"), "Europe/London");
    assert.deepEqual(
      morning.map((choice) => [choice.id, choice.label, choice.at]),
      [
        ["later", "Later today", "2026-11-12T13:00:00.000Z"],
        ["tomorrow", "Tomorrow", "2026-11-13T15:00:00.000Z"],
        ["next-week", "Next week", "2026-11-16T15:00:00.000Z"],
      ],
    );
    const evening = taskRemindChoices(null, new Date("2026-11-12T20:30:00Z"), "Europe/London");
    assert.deepEqual(
      evening.map((choice) => choice.id),
      ["tomorrow", "next-week"],
      "no Later today once the day is nearly over",
    );
  });
});
