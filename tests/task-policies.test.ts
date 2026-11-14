import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { addTaskParticipantsInDb, createTask, updateTask } from "@/lib/crm/tasks";
import { describeUndo, listRecentChanges, undoAuditEvent } from "@/lib/crm/undo";
import { createWorkspace } from "@/lib/crm/workspaces";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, queryAsUser, resetDatabase } from "@/tests/helpers";

let mark: UserActor;
let ridgeon: UserActor;
let priya: UserActor;
let agent: AgentActor;

const admin = () => getAdminPool();

async function rejectsAsUser(userId: string, text: string, values: unknown[]) {
  await assert.rejects(queryAsUser(userId, text, values), (error: unknown) => {
    const code = (error as { code?: string }).code;
    return code === "42501" || code === "P0001";
  });
}

before(async () => {
  await resetDatabase();
  mark = { ...(await createUser("mark@policies.test", "Mark Ridgeon")), workspaceName: "Eclipse" };
  const second = await createWorkspace(mark, { name: "Mark Ridgeon" });
  ridgeon = { ...mark, workspaceId: second.id, workspaceName: "Mark Ridgeon" };
  const person = await createUser("priya@policies.test", "Priya Shah");
  await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, person.userId]);
  priya = { ...person, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "member", scopes: scopesForRole("member") };
  agent = (await createAgent(mark.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Policy agent")).actor;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("audit rows for private tasks", () => {
  it("hides a private task's audit rows from other members", async () => {
    const task = (await createTask(mark, { title: "Private salary review" })).body.task;
    await updateTask(mark, task.id, { title: "Private salary review for Q3" });
    const seen = await queryAsUser<{ changes: unknown }>(priya.userId, "select changes from crm.audit_events where entity_id = $1", [task.id]);
    assert.equal(seen.length, 0);
    const owner = await queryAsUser<{ event_type: string }>(mark.userId, "select event_type from crm.audit_events where entity_id = $1", [task.id]);
    assert.deepEqual(owner.map((row) => row.event_type).sort(), ["task.created", "task.updated"]);
  });

  it("shows a task's audit rows to a tagged person and to the person who made the change", async () => {
    const task = (await createTask(mark, { title: "Prepare the board pack" })).body.task;
    await withActor(mark, (db) => addTaskParticipantsInDb(db, mark, task.id, [priya.userId]));
    const tagged = await queryAsUser(priya.userId, "select 1 from crm.audit_events where entity_id = $1", [task.id]);
    assert.ok(tagged.length >= 1);

    const handed = (await createTask(priya, { title: "Chase the invoice", ownerId: mark.userId })).body.task;
    await admin().query("update crm.tasks set created_by_user_id = $2 where id = $1", [handed.id, mark.userId]);
    await admin().query("delete from crm.task_participants where task_id = $1", [handed.id]);
    await updateTask(mark, handed.id, { title: "Chase the invoice from Acme" });
    const own = await queryAsUser<{ actor_user_id: string }>(priya.userId, "select actor_user_id from crm.audit_events where entity_id = $1", [handed.id]);
    assert.ok(own.length >= 1);
    assert.ok(own.every((row) => row.actor_user_id === priya.userId));
  });

  it("keeps other records' audit rows visible to every member", async () => {
    const company = (await createCompany(mark, { name: "Acme Policies" })).body.company;
    const seen = await queryAsUser(priya.userId, "select 1 from crm.audit_events where entity_id = $1", [company.id]);
    assert.equal(seen.length, 1);
  });

  it("still lists and undoes a member's own task changes", async () => {
    const task = (await createTask(priya, { title: "Book the venue" })).body.task;
    await updateTask(priya, task.id, { title: "Book the venue for June" });
    const changes = await listRecentChanges(priya, { entityType: "task" });
    const renamed = changes.find((change) => change.entityId === task.id && change.type === "task.updated");
    assert.ok(renamed);
    assert.equal((await describeUndo(priya, renamed.id)).canUndo, true);
    await undoAuditEvent(priya, renamed.id, { operation: "undo_change" });
    const title = await admin().query<{ title: string }>("select title from crm.tasks where id = $1", [task.id]);
    assert.equal(title.rows[0].title, "Book the venue");
  });

  it("shows an agent the task audit rows in its workspace", async () => {
    const task = (await createTask(agent, { title: "Agent follow up", ownerId: mark.userId })).body.task;
    const rows = await withActor(agent, (db) => db.query("select 1 from crm.audit_events where entity_id = $1", [task.id]));
    assert.equal(rows.rowCount, 1);
  });
});

describe("idempotency keys", () => {
  it("hides another person's stored responses", async () => {
    const task = (await createTask(mark, { title: "Private hiring plan" }, { idempotencyKey: "hiring-plan" })).body.task;
    const theirs = await queryAsUser(priya.userId, "select response from crm.idempotency_keys where workspace_id = $1", [mark.workspaceId]);
    assert.equal(theirs.length, 0);
    const replay = await createTask(mark, { title: "Private hiring plan" }, { idempotencyKey: "hiring-plan" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.body.task.id, task.id);
  });

  it("refuses a key stored under someone else's name", async () => {
    await rejectsAsUser(
      priya.userId,
      `insert into crm.idempotency_keys (workspace_id, actor_key, idempotency_key, request_hash, status_code, response)
       values ($1, $2, 'planted', 'x', 200, '{}'::jsonb)`,
      [mark.workspaceId, `user:${mark.userId}`],
    );
  });

  it("keeps an agent's replays working", async () => {
    const first = await createTask(agent, { title: "Agent replay" }, { idempotencyKey: "agent-replay" });
    const again = await createTask(agent, { title: "Agent replay" }, { idempotencyKey: "agent-replay" });
    assert.equal(again.replayed, true);
    assert.equal(again.body.task.id, first.body.task.id);
  });
});

describe("webhook deliveries for private tasks", () => {
  it("hides a private task's delivery payload from other members", async () => {
    await admin().query(
      "insert into crm.webhook_endpoints (workspace_id, url, secret, events) values ($1, 'https://hooks.example.com/orbit', 'secret', array['task.created'])",
      [mark.workspaceId],
    );
    const task = (await createTask(mark, { title: "Private pay rise" })).body.task;
    const queued = await admin().query("select 1 from crm.webhook_deliveries where payload -> 'entity' ->> 'id' = $1", [task.id]);
    assert.equal(queued.rowCount, 1);
    const seen = await queryAsUser(priya.userId, "select payload from crm.webhook_deliveries where payload -> 'entity' ->> 'id' = $1", [task.id]);
    assert.equal(seen.length, 0);
    const owner = await queryAsUser(mark.userId, "select payload from crm.webhook_deliveries where payload -> 'entity' ->> 'id' = $1", [task.id]);
    assert.equal(owner.length, 1);
  });
});

describe("task insert and update policies", () => {
  it("refuses a task created in someone else's name", async () => {
    await rejectsAsUser(
      priya.userId,
      "insert into crm.tasks (workspace_id, title, owner_id, created_by_user_id) values ($1, 'Forged', $2, $2)",
      [mark.workspaceId, mark.userId],
    );
    await rejectsAsUser(priya.userId, "insert into crm.tasks (workspace_id, title, owner_id) values ($1, 'Nameless', $2)", [
      mark.workspaceId,
      mark.userId,
    ]);
  });

  it("refuses a task an agent attributes to a person", async () => {
    await assert.rejects(
      withActor(agent, (db) =>
        db.query("insert into crm.tasks (workspace_id, title, created_by_user_id) values ($1, 'Forged by agent', $2)", [agent.workspaceId, mark.userId]),
      ),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
  });

  it("still creates tasks for people and agents", async () => {
    const mine = (await createTask(priya, { title: "Call the printer", ownerId: mark.userId })).body.task;
    assert.equal(mine.createdByUserId, priya.userId);
    const theirs = (await createTask(agent, { title: "Agent task" })).body.task;
    assert.equal(theirs.createdByAgentId, agent.agentId);
  });

  it("refuses moving a task to another workspace with a plain update", async () => {
    const task = (await createTask(mark, { title: "Stay put" })).body.task;
    await rejectsAsUser(mark.userId, "update crm.tasks set workspace_id = $2 where id = $1", [task.id, ridgeon.workspaceId]);
    const row = await admin().query<{ workspace_id: string }>("select workspace_id from crm.tasks where id = $1", [task.id]);
    assert.equal(row.rows[0].workspace_id, mark.workspaceId);
    await queryAsUser(mark.userId, "update crm.tasks set title = 'Still here', workspace_id = workspace_id where id = $1", [task.id]);
  });
});
