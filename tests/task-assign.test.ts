import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { POST as restCreateTask } from "@/app/api/v1/tasks/route";
import { runTool } from "@/lib/assistant/tools";
import { createTaskWithClickUp } from "@/lib/crm/clickup";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { countTaskViews, getCompanyContext } from "@/lib/crm/relationships";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import {
  addTaskParticipants,
  archiveTask,
  completeTask,
  countOpenTasks,
  createTask,
  createTaskInDb,
  getTask,
  listDueReminders,
  listTaskParticipants,
  listTasks,
  removeTaskParticipant,
  unarchiveTaskInDb,
  updateTask,
  updateTaskInDb,
} from "@/lib/crm/tasks";
import type { Actor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { createCrmMcpServer } from "@/server/mcp/server";
import { removeMember } from "@/lib/crm/team";
import { describeUndo, undoAuditEvent } from "@/lib/crm/undo";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, listRuns, saveWorkflow, setWorkflowStatus } from "@/lib/workflows/store";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

type Alert = { user_id: string; workspace_id: string; title: string; body: string | null; href: string | null; source: string };

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let ada: UserActor;
let olly: UserActor;
let companyId: string;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function alertsFor(user: UserActor) {
  return sql<Alert>("select user_id, workspace_id, title, body, href, source from crm.notifications where user_id = $1 order by created_at, id", [user.userId]);
}

async function waitForAlerts(user: UserActor, count: number) {
  for (let tries = 0; tries < 300; tries += 1) {
    const rows = await alertsFor(user);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${count} alerts for ${user.fullName}`);
}

function opened(path: string) {
  return `/open?workspace=${mark.workspaceId}&to=${encodeURIComponent(path)}`;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function mcp(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "task-assign", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]?.text ?? "";
      if (result.isError) throw new Error(text);
      return JSON.parse(text) as Record<string, unknown>;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@assign.test", "Mark Ridgeon");
  await sql("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
  mark = { ...mark, workspaceName: "Eclipse" };
  sam = await join(await createUser("sam@assign.test", "Sam Member"), "member");
  priya = await join(await createUser("priya@assign.test", "Priya Nair"), "member");
  ada = await join(await createUser("ada@assign.test", "Ada Admin"), "admin");
  olly = await createUser("olly@elsewhere.test", "Olly Outside");
  companyId = (await createCompany(mark, { name: "Halden Group", domain: "halden.test" })).body.company.id;
  setLiveTesting({ batch: async () => undefined });
});

beforeEach(async () => {
  await settle();
  await sql("truncate crm.push_log, crm.notifications");
});

after(async () => {
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("task assignment and tagging", () => {
  it("lets tagged people read a task but not edit, complete or reassign it", async () => {
    const task = (await createTask(mark, { title: "Send Halden the revised pricing", companyId, ownerId: sam.userId })).body.task;
    await assert.rejects(getTask(priya, task.id), /not found/i);
    await assert.rejects(addTaskParticipants(priya, task.id, [priya.userId]), /not found/i);

    assert.deepEqual(await addTaskParticipants(sam, task.id, [priya.userId, sam.userId]), [priya.userId]);
    assert.deepEqual(await addTaskParticipants(sam, task.id, [priya.userId]), []);
    await assert.rejects(addTaskParticipants(sam, task.id, [olly.userId]), /Choose people in this workspace/);
    assert.deepEqual(await listTaskParticipants(sam, [task.id]), { [task.id]: [mark.userId, priya.userId] });

    assert.equal((await getTask(priya, task.id)).title, "Send Halden the revised pricing");
    await assert.rejects(updateTask(priya, task.id, { title: "Changed" }), /Only the assignee/);
    await assert.rejects(completeTask(priya, task.id), /Only the assignee/);
    await assert.rejects(updateTask(priya, task.id, { ownerId: priya.userId }), /Only the assignee.*reassign/);
    const [row] = await sql<{ title: string; owner_id: string; completed_at: Date | null }>("select title, owner_id, completed_at from crm.tasks where id = $1", [task.id]);
    assert.deepEqual(row, { title: "Send Halden the revised pricing", owner_id: sam.userId, completed_at: null });

    const alerts = await waitForAlerts(priya, 1);
    assert.deepEqual(alerts, [
      { user_id: priya.userId, workspace_id: mark.workspaceId, title: "Sam Member tagged you in a task", body: "Send Halden the revised pricing", href: opened("/tasks?who=tagged"), source: "task" },
    ]);

    const participant = await addTaskParticipants(priya, task.id, [ada.userId]);
    assert.deepEqual(participant, [ada.userId]);
    assert.equal((await getTask(priya, task.id)).ownerId, sam.userId);
  });

  it("keeps Mine, counts, record pages and reminders free of tagged tasks", async () => {
    const assigned = (await createTask(mark, { title: "Mark's call prep", companyId, ownerId: mark.userId })).body.task;
    const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const unassigned = (await createTask(mark, { title: "Unassigned check", companyId, ownerId: null, dueAt: soon, remindMinutes: 15 })).body.task;
    await addTaskParticipants(mark, assigned.id, [priya.userId]);
    await addTaskParticipants(mark, unassigned.id, [priya.userId]);

    assert.equal(await countOpenTasks(priya, { mine: true }), 0);
    assert.equal(await countOpenTasks(priya), 0);
    assert.deepEqual((await listTasks(priya)).data, []);
    assert.deepEqual((await listTasks(priya, { mine: true })).data, []);
    assert.deepEqual((await listTasks(priya, { companyId })).data, []);
    assert.equal((await countTaskViews(priya, { mine: true })).all, 0);
    assert.equal((await getCompany(priya, companyId)).openTaskCount, 0);
    assert.deepEqual((await getCompanyContext(priya, companyId)).tasks, []);
    assert.deepEqual(await listDueReminders(priya), []);
    const tool = (await runTool(priya, "list_tasks", {})) as { data: unknown[] };
    assert.deepEqual(tool.data, []);
    const raw = await withActor(priya, async (db) => (await db.query<{ total: number }>("select count(*)::int as total from crm.tasks where id = any($1::uuid[])", [[assigned.id, unassigned.id]])).rows[0].total);
    assert.equal(raw, 2);

    const tagged = (await listTasks(priya, { tagged: true })).data.map((task) => task.title).sort();
    assert.ok(tagged.includes("Mark's call prep") && tagged.includes("Unassigned check"));
    assert.equal((await countTaskViews(priya, { tagged: true })).all, tagged.length);
    assert.ok(!(await listTasks(mark, { tagged: true })).data.some((task) => task.id === assigned.id || task.id === unassigned.id));

    assert.ok((await listTasks(mark, { mine: true })).data.some((task) => task.id === assigned.id));
    assert.ok((await listDueReminders(mark)).some((item) => item.id === unassigned.id));
  });

  it("lets the assignee hand a task on and keeps them tagged", async () => {
    const task = (await createTask(mark, { title: "Draft Samsara renewal terms", ownerId: sam.userId })).body.task;
    await waitForAlerts(sam, 1);
    const handed = await updateTask(sam, task.id, { ownerId: priya.userId });
    assert.equal(handed.body.task.ownerId, priya.userId);
    assert.equal((await getTask(sam, task.id)).ownerId, priya.userId);
    assert.deepEqual((await listTaskParticipants(sam, [task.id]))[task.id], [mark.userId, sam.userId]);
    assert.ok((await listTasks(sam, { tagged: true })).data.some((item) => item.id === task.id));
    assert.ok(!(await listTasks(sam, { mine: true })).data.some((item) => item.id === task.id));
    assert.ok((await listTasks(priya, { mine: true })).data.some((item) => item.id === task.id));
    await assert.rejects(updateTask(sam, task.id, { ownerId: sam.userId }), /Only the assignee/);
    await assert.rejects(completeTask(sam, task.id), /Only the assignee/);

    const alerts = await waitForAlerts(priya, 1);
    assert.deepEqual(alerts.map((alert) => [alert.title, alert.href, alert.workspace_id]), [["Sam Member handed you a task", opened("/tasks"), mark.workspaceId]]);
    const back = await updateTask(priya, task.id, { ownerId: sam.userId });
    assert.equal(back.body.task.ownerId, sam.userId);
    assert.ok(!(await listTasks(sam, { tagged: true })).data.some((item) => item.id === task.id));
    assert.ok((await listTasks(priya, { tagged: true })).data.some((item) => item.id === task.id));
  });

  it("alerts the assignee from every route that assigns, never for self-assignment", async () => {
    await createTask(mark, { title: "Mine only", ownerId: mark.userId });
    await createTask(mark, { title: "From the app", ownerId: sam.userId }, { provenance: { operation: "create_task", source: "web" } });
    const reassign = (await createTask(mark, { title: "Reassigned in the app" })).body.task;
    await updateTask(mark, reassign.id, { ownerId: sam.userId });

    const client = await mcp(mark);
    try {
      await client.call("create_next_action", { title: "From MCP", ownerId: sam.userId });
      const mcpTask = (await client.call("create_next_action", { title: "Reassigned over MCP" })).task as { id: string; ownerId: string };
      assert.equal(mcpTask.ownerId, mark.userId);
      const moved = (await client.call("update_next_action", { id: mcpTask.id, ownerId: sam.userId })).task as { ownerId: string };
      assert.equal(moved.ownerId, sam.userId);
    } finally {
      await client.close();
    }

    const token = (await createAgent(mark.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Zapier")).token;
    const response = await restCreateTask(
      new Request("http://crm.test/api/v1/tasks", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "From REST", ownerId: sam.userId }),
      }),
    );
    assert.equal(response.status, 201);

    const created = (await runTool(mark, "create_task", { title: "From the assistant", ownerId: sam.userId, sendToClickUp: false })) as { task: { ownerId: string } };
    assert.equal(created.task.ownerId, sam.userId);

    await createTaskWithClickUp(mark, { title: "From a workflow", ownerId: sam.userId }, null, { provenance: { operation: "workflow_step", source: "workflow" } });

    const alerts = await waitForAlerts(sam, 7);
    await settle();
    const titles = (await alertsFor(sam)).map((alert) => alert.title).sort();
    assert.deepEqual(titles, [
      "Mark Ridgeon assigned you a task",
      "Mark Ridgeon assigned you a task",
      "Mark Ridgeon assigned you a task",
      "Mark Ridgeon assigned you a task",
      "Mark Ridgeon assigned you a task",
      "Mark Ridgeon assigned you a task",
      "Zapier assigned you a task",
    ]);
    assert.ok(alerts.every((alert) => alert.source === "task" && alert.workspace_id === mark.workspaceId && Boolean(alert.body)));
    assert.deepEqual(await alertsFor(mark), []);
  });

  it("tells the creator when someone else completes their task", async () => {
    const forSam = (await createTask(mark, { title: "Send Halden the contract", ownerId: sam.userId })).body.task;
    const markOwn = (await createTask(mark, { title: "Mark finishes this" })).body.task;
    const samOwn = (await createTask(sam, { title: "Sam's own task" })).body.task;
    await completeTask(mark, markOwn.id);
    await completeTask(sam, samOwn.id);
    await completeTask(sam, forSam.id);
    await completeTask(sam, forSam.id);

    const alerts = await waitForAlerts(mark, 1);
    await settle();
    assert.deepEqual(
      (await alertsFor(mark)).map((alert) => [alert.title, alert.body, alert.href, alert.source]),
      [["Done by Sam Member", "Send Halden the contract", "/tasks?view=completed", "task"]],
    );
    assert.equal(alerts[0].workspace_id, mark.workspaceId);
    assert.deepEqual((await alertsFor(sam)).map((alert) => alert.title), ["Mark Ridgeon assigned you a task"]);
  });

  it("never alerts for ClickUp imports and syncs", async () => {
    const provenance = { operation: "import_clickup", source: "clickup" };
    const imported = await withActor(mark, (db) => createTaskInDb(db, mark, { title: "Imported from ClickUp", ownerId: sam.userId }, provenance));
    assert.ok(imported);
    await withActor(mark, (db) => updateTaskInDb(db, mark, imported.id, { ownerId: priya.userId }, { operation: "sync_clickup", source: "clickup" }));
    const completedBySam = (await createTask(mark, { title: "Closed in ClickUp", ownerId: sam.userId }, { provenance: { operation: "import_clickup", source: "clickup" } })).body.task;
    await withActor(sam, (db) => updateTaskInDb(db, sam, completedBySam.id, { completed: true }, { operation: "sync_clickup", source: "clickup" }));
    await settle();
    assert.deepEqual(await alertsFor(sam), []);
    assert.deepEqual(await alertsFor(priya), []);
    assert.deepEqual(await alertsFor(mark), []);
  });

  it("lets the owner, creator, admins and the person themselves remove someone", async () => {
    const task = (await createTask(sam, { title: "Plan the Halden kickoff", ownerId: priya.userId })).body.task;
    await addTaskParticipants(sam, task.id, [mark.userId, ada.userId]);
    const second = (await createTask(mark, { title: "Second kickoff task", ownerId: sam.userId })).body.task;
    await addTaskParticipants(mark, second.id, [priya.userId, ada.userId]);

    await assert.rejects(removeTaskParticipant(priya, second.id, ada.userId), /You can't remove them from this task/);
    assert.equal(await removeTaskParticipant(priya, second.id, priya.userId), true);
    await assert.rejects(getTask(priya, second.id), /not found/i);
    assert.equal(await removeTaskParticipant(sam, second.id, ada.userId), true);
    assert.equal(await removeTaskParticipant(sam, second.id, ada.userId), false);

    await addTaskParticipants(sam, task.id, [priya.userId]);
    assert.equal(await removeTaskParticipant(priya, task.id, mark.userId), true);
    assert.equal(await removeTaskParticipant(sam, task.id, ada.userId), true);
    await addTaskParticipants(sam, task.id, [mark.userId]);
    assert.equal(await removeTaskParticipant(ada, task.id, mark.userId), true);
    assert.deepEqual(await listTaskParticipants(sam, [task.id]), { [task.id]: [sam.userId] });
  });
});

describe("task access edges", () => {
  async function lastEvent(taskId: string, actor: UserActor, type: string) {
    const [row] = await sql<{ id: string }>(
      "select id from crm.audit_events where entity_id = $1 and actor_user_id = $2 and event_type = $3 order by created_at desc limit 1",
      [taskId, actor.userId, type],
    );
    return row.id;
  }

  it("refuses archive, restore and undo from someone only tagged, without a false audit event", async () => {
    const task = (await createTask(mark, { title: "Archive guard", ownerId: sam.userId })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    await assert.rejects(archiveTask(priya, task.id), /Only the assignee/);
    assert.equal((await getTask(mark, task.id)).archivedAt, null);
    await archiveTask(mark, task.id);
    await assert.rejects(
      withActor(priya, (db) => unarchiveTaskInDb(db, priya, task.id, { operation: "restore_task" })),
      /Only the assignee/,
    );
    assert.ok((await getTask(mark, task.id)).archivedAt);
    const events = await sql<{ actor_user_id: string }>(
      "select actor_user_id from crm.audit_events where entity_id = $1 and event_type in ('task.archived', 'task.updated')",
      [task.id],
    );
    assert.ok(events.length > 0 && events.every((event) => event.actor_user_id !== priya.userId));

    const handed = (await createTask(mark, { title: "Undo guard", ownerId: sam.userId })).body.task;
    await updateTask(sam, handed.id, { ownerId: priya.userId });
    const event = await lastEvent(handed.id, sam, "task.updated");
    const described = await describeUndo(sam, event);
    assert.equal(described.canUndo, false);
    assert.equal((described as { reason: string }).reason, "Can't undo: you're only tagged on this task now.");
    await assert.rejects(undoAuditEvent(sam, event, { operation: "undo_change" }), /only tagged/);
  });

  it("tags whoever assigns a task to someone else, and records it", async () => {
    const created = (await createTask(priya, { title: "Priya made this for Sam", ownerId: sam.userId })).body.task;
    assert.ok((await listTasks(priya, { tagged: true })).data.some((task) => task.id === created.id));
    assert.ok(!(await listTasks(priya, { mine: true })).data.some((task) => task.id === created.id));

    const own = (await createTask(priya, { title: "Priya's own" })).body.task;
    assert.deepEqual(await listTaskParticipants(priya, [own.id]), {});

    const byAdmin = (await createTask(sam, { title: "Admin moves this" })).body.task;
    await updateTask(ada, byAdmin.id, { ownerId: priya.userId });
    assert.deepEqual((await listTaskParticipants(ada, [byAdmin.id]))[byAdmin.id], [ada.userId]);
    await updateTask(ada, byAdmin.id, { ownerId: ada.userId });
    assert.ok(!(await listTasks(ada, { tagged: true })).data.some((task) => task.id === byAdmin.id));

    const byCreator = (await createTask(mark, { title: "Creator hands to Priya" })).body.task;
    await updateTask(mark, byCreator.id, { ownerId: priya.userId });
    assert.deepEqual((await listTaskParticipants(mark, [byCreator.id]))[byCreator.id], [mark.userId]);

    const unassigned = (await createTask(mark, { title: "Creator unassigns" })).body.task;
    await updateTask(mark, unassigned.id, { ownerId: null });
    assert.deepEqual(await listTaskParticipants(mark, [unassigned.id]), {});

    const toNoOne = (await createTask(mark, { title: "Sam lets go", ownerId: sam.userId })).body.task;
    const released = await updateTask(sam, toNoOne.id, { ownerId: null });
    assert.equal(released.body.task.ownerId, null);
    assert.equal((await getTask(sam, toNoOne.id)).ownerId, null);
    assert.ok((await listTasks(sam, { tagged: true })).data.some((task) => task.id === toNoOne.id));
    assert.ok(!(await listTasks(sam, { mine: true })).data.some((task) => task.id === toNoOne.id));
    assert.ok(!(await listDueReminders(sam)).some((item) => item.id === toNoOne.id));

    const tagged = await sql<{ event_type: string; participant: { userId: string } }>(
      "select event_type, changes->'participant' as participant from crm.audit_events where entity_id = $1 and event_type like 'task.participant_%'",
      [created.id],
    );
    assert.deepEqual(tagged.map((row) => [row.event_type, row.participant.userId]), [["task.participant_added", priya.userId]]);
    await removeTaskParticipant(priya, created.id, priya.userId);
    const removed = await sql<{ n: number }>("select count(*)::int as n from crm.audit_events where entity_id = $1 and event_type = 'task.participant_removed'", [created.id]);
    assert.equal(removed[0].n, 1);
  });

  it("alerts once per completion, never for completed tasks, and says what the task is", async () => {
    const task = (await createTask(mark, { title: "Done only once", ownerId: sam.userId })).body.task;
    await completeTask(sam, task.id);
    await updateTask(sam, task.id, { completed: false });
    await completeTask(sam, task.id);
    await waitForAlerts(mark, 1);
    await settle();
    assert.deepEqual((await alertsFor(mark)).map((alert) => [alert.title, alert.body]), [["Done by Sam Member", "Done only once"]]);

    await sql("truncate crm.notifications, crm.push_log");
    const finished = (await createTask(mark, { title: "Already finished", ownerId: sam.userId, completed: true })).body.task;
    await updateTask(mark, finished.id, { ownerId: priya.userId });
    await settle();
    assert.deepEqual(await alertsFor(sam), []);
    assert.deepEqual(await alertsFor(priya), []);
    await assert.rejects(createTask(mark, { title: "Outsider", ownerId: olly.userId }), /Choose an assignee in this workspace/);
  });

  it("never runs a task_completed workflow for a task its owner is only tagged in", async () => {
    const workflow = await createWorkflow(priya, { name: "On completion" });
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "task_completed" },
      triggerPosition: { x: 0, y: 0 },
      nodes: [{ id: "notify_1", type: "notify", config: { to: "owner", title: "Done {{task.title}}", body: "" }, position: { x: 300, y: 0 } }],
      edges: [{ source: "trigger", handle: "out", target: "notify_1" }],
    };
    await saveWorkflow(priya, workflow.id, { definition });
    await setWorkflowStatus(priya, workflow.id, "active");
    const tagged = (await createTask(mark, { title: "Sam's tagged task", ownerId: sam.userId })).body.task;
    await addTaskParticipants(mark, tagged.id, [priya.userId]);
    await completeTask(sam, tagged.id);
    await runWorkflowTick({ budgetMs: 30_000 });
    assert.deepEqual(await listRuns(priya, workflow.id), []);

    const mine = (await createTask(priya, { title: "Priya's to finish" })).body.task;
    await completeTask(priya, mine.id);
    await runWorkflowTick({ budgetMs: 30_000 });
    assert.equal((await listRuns(priya, workflow.id)).length, 1);
    await setWorkflowStatus(priya, workflow.id, "paused");
  });

  it("gives agents no Tagged list and keeps raw participant rows locked down", async () => {
    const agent = (await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Lister")).actor;
    assert.deepEqual((await listTasks(agent, { tagged: true })).data, []);
    assert.equal((await countTaskViews(agent, { tagged: true })).all, 0);
    assert.ok((await listTasks(agent)).total > 0);

    const hidden = (await createTask(mark, { title: "Hidden from Priya", ownerId: mark.userId })).body.task;
    const visible = (await createTask(mark, { title: "Visible to Sam", ownerId: sam.userId })).body.task;
    await assert.rejects(
      queryAsUser(priya.userId, "insert into crm.task_participants (task_id, user_id, added_by) values ($1, $2, $2)", [hidden.id, priya.userId]),
      /row-level security/,
    );
    await assert.rejects(
      queryAsUser(sam.userId, "insert into crm.task_participants (task_id, user_id, added_by) values ($1, $2, $3)", [visible.id, priya.userId, mark.userId]),
      /row-level security/,
    );
    await assert.rejects(
      queryAsUser(sam.userId, "insert into crm.task_participants (task_id, user_id, added_by) values ($1, $2, $3)", [visible.id, olly.userId, sam.userId]),
      /row-level security/,
    );
    await addTaskParticipants(mark, hidden.id, [ada.userId]);
    const seen = await queryAsUser<{ n: number }>(priya.userId, "select count(*)::int as n from crm.task_participants where task_id = $1", [hidden.id]);
    assert.equal(seen[0].n, 0);
    await assert.rejects(
      queryAsUser(sam.userId, "update crm.task_participants set user_id = $2 where task_id = $1", [visible.id, sam.userId]),
      /permission denied/,
    );
    const deleted = await queryAsUser<{ task_id: string }>(priya.userId, "delete from crm.task_participants where task_id = $1 returning task_id", [hidden.id]);
    assert.deepEqual(deleted, []);
  });

  it("drops tags when someone leaves the workspace, so rejoining doesn't restore them", async () => {
    const rhea = await join(await createUser("rhea@assign.test", "Rhea Rejoins"), "member");
    const task = (await createTask(mark, { title: "Rhea follows this", ownerId: mark.userId })).body.task;
    await addTaskParticipants(mark, task.id, [rhea.userId]);
    assert.equal((await getTask(rhea, task.id)).id, task.id);
    await removeMember(mark, rhea.userId);
    assert.deepEqual(await sql("select 1 from crm.task_participants where user_id = $1", [rhea.userId]), []);
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, rhea.userId]);
    await assert.rejects(getTask(rhea, task.id), /not found/i);
  });
});
