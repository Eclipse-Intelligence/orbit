import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { countTaskViews, getDueActions } from "@/lib/crm/relationships";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { readPlanner } from "@/lib/crm/task-blocks";
import { addTaskParticipantsInDb, archiveTaskInDb, completeTask, createTask, getTask, listTasks, unarchiveTaskInDb, updateTask } from "@/lib/crm/tasks";
import { removeMember } from "@/lib/crm/team";
import { createWebhook } from "@/lib/crm/webhooks";
import { describeUndo, listRecentChanges, undoAuditEvent } from "@/lib/crm/undo";
import { createWorkspace } from "@/lib/crm/workspaces";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, queryAsUser, resetDatabase } from "@/tests/helpers";
import { createCrmMcpServer } from "@/server/mcp/server";

let mark: UserActor;
let ridgeon: UserActor;
let priya: UserActor;
let agent: AgentActor;
let ada: UserActor;

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
  const person2 = await createUser("ada@policies.test", "Ada Price");
  await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [mark.workspaceId, person2.userId]);
  ada = { ...person2, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "admin", scopes: scopesForRole("admin") };
});

const hidden = (error: unknown) => error instanceof CrmError && error.status === 404;

async function mcpText(actor: UserActor | AgentActor, name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "policies", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return result.content.map((part) => part.text).join("\n");
  } finally {
    await client.close();
    await server.close();
  }
}

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
      "insert into crm.webhook_endpoints (workspace_id, url, secret, events, created_by_user_id) values ($1, 'https://hooks.example.com/orbit', 'secret', array['task.created'], $2)",
      [mark.workspaceId, mark.userId],
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

describe("only your own tasks", () => {
  it("hides a member's private task from the owner and an admin in lists, counts, Plan, the assistant, MCP, SQL, audit and undo", async () => {
    const before = new Map<string, number>();
    for (const boss of [mark, ada]) before.set(boss.userId, (await countTaskViews(boss)).all);
    const task = (await createTask(priya, { title: "Priya's private appraisal notes", dueAt: new Date(Date.now() - 3_600_000).toISOString() })).body.task;
    for (const boss of [mark, ada]) {
      await assert.rejects(getTask(boss, task.id), hidden);
      assert.equal((await listTasks(boss, { limit: 100 })).data.some((item) => item.id === task.id), false);
      assert.equal((await getDueActions(boss, "all")).tasks.some((item) => item.id === task.id), false);
      assert.equal((await countTaskViews(boss)).all, before.get(boss.userId));
      assert.equal((await readPlanner(boss)).tasks.some((item) => item.id === task.id), false);
      assert.doesNotMatch(JSON.stringify(await runTool(boss, "list_tasks", { view: "all" })), /appraisal/);
      assert.doesNotMatch(await mcpText(boss, "get_due_actions", { view: "all" }), /appraisal/);
      assert.doesNotMatch(await mcpText(boss, "get_next_action", { id: task.id }), /appraisal/);
      assert.equal((await queryAsUser(boss.userId, "select 1 from crm.tasks where id = $1", [task.id])).length, 0);
      assert.equal((await queryAsUser(boss.userId, "select 1 from crm.audit_events where entity_id = $1", [task.id])).length, 0);
      await assert.rejects(updateTask(boss, task.id, { title: "Changed by the boss" }), (error: unknown) => error instanceof CrmError && (error.status === 404 || error.status === 403));
      await assert.rejects(completeTask(boss, task.id), (error: unknown) => error instanceof CrmError && (error.status === 404 || error.status === 403));
    }
    const event = await admin().query<{ id: string }>("select id from crm.audit_events where entity_id = $1 limit 1", [task.id]);
    await assert.rejects(describeUndo(mark, event.rows[0].id), hidden);
    assert.equal((await getTask(priya, task.id)).title, "Priya's private appraisal notes");
  });

  it("shows a workspace agent only the tasks it created", async () => {
    const people = (await createTask(mark, { title: "Mark's own call" })).body.task;
    const own = (await createTask(agent, { title: "Agent's own follow up", ownerId: mark.userId })).body.task;
    const listed = (await listTasks(agent, { limit: 100 })).data.map((item) => item.id);
    assert.ok(listed.includes(own.id));
    assert.equal(listed.includes(people.id), false);
    await assert.rejects(getTask(agent, people.id), hidden);
    await assert.rejects(updateTask(agent, people.id, { title: "Agent rename" }), (error: unknown) => error instanceof CrmError && (error.status === 404 || error.status === 403));
    assert.doesNotMatch(await mcpText(agent, "get_due_actions", { view: "all" }), /Mark's own call/);
    const rows = await withActor(agent, (db) => db.query("select 1 from crm.audit_events where entity_id = $1", [people.id]));
    assert.equal(rows.rowCount, 0);
    assert.equal((await getTask(mark, own.id)).title, "Agent's own follow up");
  });

  it("delivers a task event only to webhooks whose creator can see the task", async () => {
    const network = { lookup: async () => ["93.184.216.34"] };
    const marks = (await createWebhook(mark, { url: "https://hooks.example.com/mark", events: ["task.updated", "company.created"] }, network)).endpoint;
    const agents = (await createWebhook({ ...agent, scopes: [...SCOPES] }, { url: "https://hooks.example.com/agent", events: ["task.updated"] }, network)).endpoint;
    const nobody = await admin().query<{ id: string }>(
      "insert into crm.webhook_endpoints (workspace_id, url, secret, events) values ($1, 'https://hooks.example.com/legacy', 'secret', array['task.updated', 'company.created']) returning id",
      [mark.workspaceId],
    );
    const theirs = (await createTask(priya, { title: "Priya's quiet task" })).body.task;
    await updateTask(priya, theirs.id, { title: "Priya's quiet task, renamed" });
    const mine = (await createTask(mark, { title: "Mark's loud task" })).body.task;
    await updateTask(mark, mine.id, { title: "Mark's loud task, renamed" });
    const robots = (await createTask(agent, { title: "Agent's task" })).body.task;
    await updateTask(agent, robots.id, { title: "Agent's task, renamed" });
    const company = (await createCompany(priya, { name: "Hooked Ltd" })).body.company;
    const deliveries = await admin().query<{ endpoint_id: string; entity: string }>(
      "select endpoint_id, payload -> 'entity' ->> 'id' as entity from crm.webhook_deliveries where endpoint_id = any($1::uuid[])",
      [[marks.id, agents.id, nobody.rows[0].id]],
    );
    const to = (endpoint: string) => deliveries.rows.filter((row) => row.endpoint_id === endpoint).map((row) => row.entity).sort();
    assert.deepEqual(to(marks.id), [mine.id, robots.id, company.id].sort(), "the agent's unassigned task goes to the workspace owner");
    assert.deepEqual(to(agents.id), [robots.id]);
    assert.deepEqual(to(nobody.rows[0].id), [company.id]);
  });

  it("hands a removed member's tasks to the person who removed them, unowned ones included", async () => {
    const person = await createUser("leo@policies.test", "Leo Leaver");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, person.userId]);
    const leo: UserActor = { ...person, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "member", scopes: scopesForRole("member") };
    const owned = (await createTask(leo, { title: "Leo's owned task" })).body.task;
    const unowned = (await createTask(leo, { title: "Leo's unowned task", ownerId: null })).body.task;
    await assert.rejects(getTask(ada, owned.id), hidden);
    await removeMember(ada, leo.userId, { operation: "remove_member", source: "web" });
    assert.equal((await getTask(ada, owned.id)).ownerId, ada.userId);
    assert.equal((await getTask(ada, unowned.id)).ownerId, ada.userId);
    await assert.rejects(getTask(mark, owned.id), hidden);
  });
});

describe("raw writes that skip the app", () => {
  it("refuses changing a task's creator", async () => {
    const task = (await createTask(mark, { title: "Mine to keep" })).body.task;
    await rejectsAsUser(mark.userId, "update crm.tasks set created_by_user_id = $2 where id = $1", [task.id, priya.userId]);
    await rejectsAsUser(mark.userId, "update crm.tasks set created_by_user_id = null, created_by_agent_id = $2 where id = $1", [task.id, agent.agentId]);
  });

  it("refuses an audit row in someone else's name", async () => {
    await rejectsAsUser(
      priya.userId,
      `insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, actor_user_id, operation)
       values ($1, 'company.updated', 'company', gen_random_uuid(), 'user', $2, 'forged')`,
      [mark.workspaceId, mark.userId],
    );
    await rejectsAsUser(
      priya.userId,
      `insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, operation)
       values ($1, 'company.updated', 'company', gen_random_uuid(), 'system', 'forged')`,
      [mark.workspaceId],
    );
  });

  it("refuses a forged webhook delivery and webhook changes by a member", async () => {
    const endpoint = await admin().query<{ id: string }>(
      "insert into crm.webhook_endpoints (workspace_id, url, secret, events, created_by_user_id) values ($1, 'https://hooks.example.com/forged', 's', array['*'], $2) returning id",
      [mark.workspaceId, mark.userId],
    );
    await rejectsAsUser(
      priya.userId,
      `insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
       values ($1, $2, gen_random_uuid(), 'company.updated', '{"entity": {"type": "company"}}'::jsonb)`,
      [mark.workspaceId, endpoint.rows[0].id],
    );
    await rejectsAsUser(
      priya.userId,
      "insert into crm.webhook_endpoints (workspace_id, url, secret, events, created_by_user_id) values ($1, 'https://hooks.example.com/member', 's', array['*'], $2)",
      [mark.workspaceId, priya.userId],
    );
    const changed = await queryAsUser(priya.userId, "update crm.webhook_endpoints set url = 'https://evil.example.com' where id = $1 returning id", [endpoint.rows[0].id]);
    assert.equal(changed.length, 0);
  });
});

describe("agents and webhooks under task privacy", () => {
  it("gives an agent's unassigned task to the workspace owner", async () => {
    const task = (await createTask(agent, { title: "Agent found a lead to call" })).body.task;
    assert.equal(task.ownerId, mark.userId);
    assert.equal((await getTask(mark, task.id)).title, "Agent found a lead to call");
    const released = (await updateTask(agent, task.id, { ownerId: null })).body.task;
    assert.equal(released.ownerId, mark.userId);
    await admin().query("update crm.tasks set owner_id = null where id = $1", [task.id]);
    const touched = (await updateTask(agent, task.id, { title: "Agent found a lead to call, renamed" })).body.task;
    assert.equal(touched.ownerId, mark.userId);
    await completeTask(agent, task.id);
    await admin().query("update crm.tasks set owner_id = null where id = $1", [task.id]);
    const reopened = (await updateTask(agent, task.id, { completed: false })).body.task;
    assert.equal(reopened.ownerId, mark.userId);
  });

  it("gives the workspace owner an agent's ownerless task when the agent archives or unarchives it", async () => {
    const task = (await createTask(agent, { title: "Agent task to archive" })).body.task;
    await admin().query("update crm.tasks set owner_id = null where id = $1", [task.id]);
    const archived = await withActor(agent, (db) => archiveTaskInDb(db, agent, task.id, { operation: "archive_task" }));
    assert.equal(archived.task.ownerId, mark.userId);
    await admin().query("update crm.tasks set owner_id = null where id = $1", [task.id]);
    const restored = await withActor(agent, (db) => unarchiveTaskInDb(db, agent, task.id, { operation: "unarchive_task" }));
    assert.equal(restored.task.ownerId, mark.userId);
    assert.equal(restored.task.archivedAt, null);
  });

  it("keeps a title-only change by another agent a plain not found, never a reassign error", async () => {
    const task = (await createTask(agent, { title: "First agent's task" })).body.task;
    await admin().query("update crm.tasks set owner_id = null where id = $1", [task.id]);
    const other = (await createAgent(mark.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Other agent")).actor;
    await assert.rejects(updateTask(other, task.id, { title: "Renamed by the other agent" }), (error: unknown) => {
      return error instanceof CrmError && error.status === 404 && !/reassign/i.test(error.message);
    });
    const owner = await admin().query<{ owner_id: string | null; title: string }>("select owner_id, title from crm.tasks where id = $1", [task.id]);
    assert.deepEqual(owner.rows[0], { owner_id: null, title: "First agent's task" });
  });

  it("sends an endpoint subscribed to every event only the tasks its creator can see", async () => {
    const network = { lookup: async () => ["93.184.216.34"] };
    const everything = (await createWebhook(mark, { url: "https://hooks.example.com/everything", events: ["*"] }, network)).endpoint;
    const theirs = (await createTask(priya, { title: "Priya's own, for nobody's webhook" })).body.task;
    const mine = (await createTask(mark, { title: "Mark's own, for his webhook" })).body.task;
    const sent = await admin().query<{ entity: string }>(
      "select payload -> 'entity' ->> 'id' as entity from crm.webhook_deliveries where endpoint_id = $1 and payload -> 'entity' ->> 'type' = 'task'",
      [everything.id],
    );
    const ids = sent.rows.map((row) => row.entity);
    assert.ok(ids.includes(mine.id));
    assert.equal(ids.includes(theirs.id), false);
  });

  it("records who made a webhook even when the insert doesn't say, freezes where it sends for anyone else, and hands it over when they leave", async () => {
    const made = await queryAsUserKeep(mark.userId, "insert into crm.webhook_endpoints (workspace_id, url, secret, events) values ($1, 'https://hooks.example.com/old-app', 's', array['task.updated']) returning id, created_by_user_id", [mark.workspaceId]);
    assert.equal(made.created_by_user_id, mark.userId);
    await assert.rejects(
      queryAsUser(ada.userId, "update crm.webhook_endpoints set url = 'https://evil.example.com' where id = $1", [made.id]),
      /Only whoever made this webhook/,
    );
    const archived = await queryAsUser<{ id: string }>(ada.userId, "update crm.webhook_endpoints set enabled = false where id = $1 returning id", [made.id]);
    assert.equal(archived.length, 1);
    await queryAsUser(mark.userId, "update crm.webhook_endpoints set url = 'https://hooks.example.com/new-app' where id = $1", [made.id]);

    const person = await createUser("rita@policies.test", "Rita Leaver");
    await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [mark.workspaceId, person.userId]);
    const rita: UserActor = { ...person, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "admin", scopes: scopesForRole("admin") };
    const hers = (await createWebhook(rita, { url: "https://hooks.example.com/rita", events: ["task.created"] }, { lookup: async () => ["93.184.216.34"] })).endpoint;
    await removeMember(mark, rita.userId, { operation: "remove_member", source: "web" });
    const handed = await admin().query<{ created_by_user_id: string }>("select created_by_user_id from crm.webhook_endpoints where id = $1", [hers.id]);
    assert.equal(handed.rows[0].created_by_user_id, mark.userId);
  });
});

async function queryAsUserKeep(userId: string, text: string, values: unknown[]) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await client.query("set local role authenticated");
    const result = await client.query<{ id: string; created_by_user_id: string }>(text, values);
    await client.query("commit");
    return result.rows[0];
  } finally {
    client.release();
  }
}
