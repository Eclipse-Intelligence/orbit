import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { PoolClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PATCH as restUpdateTask } from "@/app/api/v1/tasks/[id]/route";
import { POST as restCreateTask } from "@/app/api/v1/tasks/route";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { ingestLead } from "@/lib/crm/leads";
import { completeTaskWithOutcome } from "@/lib/crm/task-act";
import { addTaskParticipants, archiveTask, completeTask, createTask, getTask, placeTask, unarchiveTaskInDb, updateTask } from "@/lib/crm/tasks";
import type { AgentActor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, listRuns, saveWorkflow, setWorkflowStatus } from "@/lib/workflows/store";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

const HOUR = 3_600_000;

let mark: UserActor;
let sam: UserActor;
let agent: AgentActor;
let token = "";
let northwind: string;
let ashby: string;

const admin = () => getAdminPool();

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await admin().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function events(taskId: string, type?: string) {
  return sql<{ event_type: string; changes: Record<string, unknown> }>(
    `select event_type, changes from crm.audit_events where entity_id = $1${type ? " and event_type = $2" : ""} order by created_at`,
    type ? [taskId, type] : [taskId],
  );
}

async function row(taskId: string) {
  return (
    await sql<{
      owner_id: string | null;
      due_has_time: boolean;
      remind_minutes: number | null;
      due_at: Date | null;
      completed_at: Date | null;
      archived_at: Date | null;
      clickup_task_id: string | null;
      clickup_list_id: string | null;
      clickup_url: string | null;
      clickup_sync: Record<string, unknown>;
    }>("select * from crm.tasks where id = $1", [taskId])
  )[0];
}

async function lockWaiters() {
  const result = await sql<{ total: number }>(
    "select count(*)::int as total from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return result[0].total;
}

async function untilWaiting(count = 1) {
  for (let tries = 0; tries < 400; tries += 1) {
    if ((await lockWaiters()) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Nothing waited on the task row.");
}

async function holding<T>(change: string, values: unknown[], race: () => Promise<T>, waiters = 1) {
  const client: PoolClient = await admin().connect();
  try {
    await client.query("begin");
    await client.query(change, values);
    const running = race().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await untilWaiting(waiters);
    await client.query("commit");
    return await running;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function outcome(values: { note?: string; next?: { title: string; dueAt: string | null } | null } = {}) {
  return { outcomeId: randomUUID(), note: values.note ?? "", kind: "call" as const, next: values.next ?? null };
}

function request(path: string, method: string, body: unknown) {
  return new Request(`http://crm.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rest(body: unknown) {
  const response = await restCreateTask(request("/tasks", "POST", body));
  return { status: response.status, body: (await response.json()) as { task: { id: string; remindMinutes: number | null }; error: { message: string; details: { field?: string } | null } } };
}

async function restPatch(id: string, body: unknown) {
  const response = await restUpdateTask(request(`/tasks/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as { task: { id: string }; error: { message: string; details: { field?: string } | null } } };
}

async function mcp(name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(agent);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "task-domain", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0]?.text ?? "";
    let json: { task?: { id: string; completedAt: string | null } } | null = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { error: Boolean(result.isError), text, json };
  } finally {
    await client.close();
    await server.close();
  }
}

function londonWall(at: number) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@domain-fixes.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@domain-fixes.test", "Sam Okafor"), "member");
  const created = await createAgent(mark.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Domain agent");
  agent = created.actor;
  token = created.token;
  northwind = (await createCompany(mark, { name: "Northwind Trading", domain: "northwind-fixes.test" })).body.company.id;
  ashby = (await createCompany(mark, { name: "Ashby Freight", domain: "ashby-fixes.test" })).body.company.id;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("Done with an outcome after the person changed company", () => {
  it("completes the task and lets the company follow the person, dropping the old company's opportunity", async () => {
    const jane = (await createContact(mark, { companyId: northwind, firstName: "Jane", lastName: "Cooper", email: "jane@northwind-fixes.test" })).body.contact.id;
    const renewal = (await createOpportunity(mark, { companyId: northwind, name: "Northwind renewal 2027", primaryContactId: jane })).body.opportunity.id;
    const task = (await createTask(mark, { title: "Call Jane about the renewal", contactId: jane, opportunityId: renewal })).body.task;
    await sql("update crm.contacts set company_id = $2 where id = $1", [jane, ashby]);
    const result = await completeTaskWithOutcome(mark, task.id, outcome({ note: "Jane has moved to Ashby", next: { title: "Send Jane the Ashby pricing", dueAt: null } }));
    assert.ok(result.task.completedAt);
    assert.ok((await getTask(mark, task.id)).completedAt);
    const [activity] = await sql<{ company_id: string | null; contact_id: string | null; opportunity_id: string | null }>(
      "select company_id, contact_id, opportunity_id from crm.activities where id = $1",
      [result.activityId],
    );
    assert.deepEqual(activity, { company_id: ashby, contact_id: jane, opportunity_id: null });
    assert.deepEqual([result.next?.companyId, result.next?.contactId, result.next?.opportunityId], [ashby, jane, null]);
  });

  it("keeps an opportunity that still fits and a company when the person has left every company", async () => {
    const lee = (await createContact(mark, { companyId: northwind, firstName: "Lee", lastName: "Hart", email: "lee@northwind-fixes.test" })).body.contact.id;
    const pilot = (await createOpportunity(mark, { companyId: northwind, name: "Northwind pilot", primaryContactId: lee })).body.opportunity.id;
    const task = (await createTask(mark, { title: "Call Lee about the pilot", contactId: lee, opportunityId: pilot })).body.task;
    await sql("update crm.contacts set company_id = null where id = $1", [lee]);
    const result = await completeTaskWithOutcome(mark, task.id, outcome({ note: "Lee went freelance", next: { title: "Ask Lee who took over", dueAt: null } }));
    assert.deepEqual([result.next?.companyId, result.next?.contactId, result.next?.opportunityId], [northwind, lee, pilot]);
  });

  it("keeps a company deliberately left empty, and the completed task keeps its own links", async () => {
    const kim = (await createContact(mark, { companyId: northwind, firstName: "Kim", lastName: "Lowe", email: "kim@northwind-fixes.test" })).body.contact.id;
    const task = (await createTask(mark, { title: "Call Kim", contactId: kim })).body.task;
    await updateTask(mark, task.id, { companyId: null });
    const moved = (await createTask(mark, { title: "Call Kim again", contactId: kim })).body.task;
    await sql("update crm.contacts set company_id = $2 where id = $1", [kim, ashby]);
    const result = await completeTaskWithOutcome(mark, task.id, outcome({ next: { title: "Kim follow-up", dueAt: null } }));
    assert.deepEqual([result.next?.companyId, result.next?.contactId], [null, kim]);
    const done = await completeTaskWithOutcome(mark, moved.id, outcome({ next: { title: "Kim second follow-up", dueAt: null } }));
    assert.equal(done.next?.companyId, ashby);
    assert.equal((await getTask(mark, moved.id)).companyId, northwind);
  });

  it("runs a Create task step set to Same as the task", async () => {
    const ravi = (await createContact(mark, { companyId: northwind, firstName: "Ravi", lastName: "Shah", email: "ravi@northwind-fixes.test" })).body.contact.id;
    const deal = (await createOpportunity(mark, { companyId: northwind, name: "Northwind freight lanes", primaryContactId: ravi })).body.opportunity.id;
    const workflow = await createWorkflow(mark, { name: "Next step" });
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "task_completed" },
      triggerPosition: { x: 0, y: 0 },
      nodes: [{ id: "create_task_1", type: "create_task", config: { title: "Follow up {{task.title}}", link: "task" }, position: { x: 300, y: 0 } }],
      edges: [{ source: "trigger", handle: "out", target: "create_task_1" }],
    };
    await saveWorkflow(mark, workflow.id, { definition });
    await setWorkflowStatus(mark, workflow.id, "active");
    const task = (await createTask(mark, { title: "Ravi lanes", contactId: ravi, opportunityId: deal })).body.task;
    await sql("update crm.contacts set company_id = $2 where id = $1", [ravi, ashby]);
    await completeTask(mark, task.id);
    await runWorkflowTick({ budgetMs: 30_000 });
    const runs = await listRuns(mark, workflow.id);
    assert.ok(runs.length > 0);
    assert.deepEqual(runs.filter((run) => run.status !== "succeeded"), []);
    const [made] = await sql<{ company_id: string | null; contact_id: string | null; opportunity_id: string | null }>(
      "select company_id, contact_id, opportunity_id from crm.tasks where title = 'Follow up Ravi lanes'",
    );
    assert.deepEqual(made, { company_id: ashby, contact_id: ravi, opportunity_id: null });
    await setWorkflowStatus(mark, workflow.id, "paused");
  });
});

describe("writers read the task under a row lock", () => {
  it("saves a time set while the task is handed to someone else as date only", async () => {
    const task = (await createTask(mark, { title: "Book the venue", dueDate: "2027-03-10" })).body.task;
    const raced = await holding("update crm.tasks set owner_id = $2 where id = $1", [task.id, sam.userId], () => updateTask(mark, task.id, { dueAt: "2027-03-10T14:00" }));
    assert.equal(raced.ok, true);
    const saved = await row(task.id);
    assert.equal(saved.owner_id, sam.userId);
    assert.equal(saved.due_has_time, false);
  });

  it("refuses a reminder on a task made date only at the same moment", async () => {
    const task = (await createTask(mark, { title: "Call the printer", dueAt: "2027-03-11T10:00" })).body.task;
    const raced = await holding(
      "update crm.tasks set due_has_time = false, scheduled_by = null, remind_minutes = null, due_at = '2027-03-11T00:00:00Z' where id = $1",
      [task.id],
      () => updateTask(mark, task.id, { remindMinutes: 15 }),
    );
    assert.equal(raced.ok, false);
    assert.equal((await row(task.id)).remind_minutes, null);
  });

  it("refuses to move a task completed at the same moment", async () => {
    const task = (await createTask(mark, { title: "Send the brochure", dueAt: "2027-03-12T10:00" })).body.task;
    const raced = await holding("update crm.tasks set completed_at = now() where id = $1", [task.id], () =>
      placeTask(mark, task.id, { at: "2027-03-12T15:00:00.000Z", durationMinutes: 30 }),
    );
    assert.equal(raced.ok, false);
    assert.match(String((raced as { error: Error }).error.message), /done/);
    assert.equal((await row(task.id)).due_at?.toISOString(), "2027-03-12T10:00:00.000Z");
  });

  it("doesn't wait behind a key share lock, such as a foreign key check from the Outlook queue", async () => {
    const task = (await createTask(mark, { title: "Key share" })).body.task;
    const client = await admin().connect();
    try {
      await client.query("begin");
      await client.query("select 1 from crm.tasks where id = $1 for key share", [task.id]);
      const outcome = await Promise.race([
        updateTask(mark, task.id, { title: "Key share, renamed" }).then(() => "saved"),
        new Promise((resolve) => setTimeout(() => resolve("waited"), 3000)),
      ]);
      assert.equal(outcome, "saved");
    } finally {
      await client.query("commit");
      client.release();
    }
  });

  it("archives once when two people archive together, and restores once", async () => {
    const task = (await createTask(mark, { title: "Old lead" })).body.task;
    const both = () => Promise.all([archiveTask(mark, task.id), archiveTask(mark, task.id)]);
    const archived = await holding("select 1 from crm.tasks where id = $1 for update", [task.id], both, 2);
    assert.equal(archived.ok, true);
    assert.equal((await events(task.id, "task.archived")).length, 1);
    const restore = () =>
      Promise.all([
        withActor(mark, (db) => unarchiveTaskInDb(db, mark, task.id, { operation: "undo", source: "web" })),
        withActor(mark, (db) => unarchiveTaskInDb(db, mark, task.id, { operation: "undo", source: "web" })),
      ]);
    const restored = await holding("select 1 from crm.tasks where id = $1 for update", [task.id], restore, 2);
    assert.equal(restored.ok, true);
    assert.equal((await events(task.id)).filter((event) => event.event_type === "task.updated" && JSON.stringify(event.changes).includes("archivedAt")).length, 1);
  });
});

describe("an update that changes nothing", () => {
  it("records no event", async () => {
    const task = (await createTask(mark, { title: "Chase the PO", dueDate: "2027-03-15", priority: "high", companyId: northwind })).body.task;
    const before = (await events(task.id)).length;
    const same = await updateTask(mark, task.id, { title: "Chase the PO", priority: "high", dueDate: "2027-03-15", ownerId: mark.userId, companyId: northwind, description: null });
    assert.equal(same.body.task.id, task.id);
    assert.equal((await events(task.id)).length, before);
    await updateTask(mark, task.id, { title: "Chase the PO", priority: "low" });
    const changed = await events(task.id, "task.updated");
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0].changes.fields, ["priority"]);
  });

  it("still refuses someone who can't change the task", async () => {
    const task = (await createTask(mark, { title: "Mark's own", priority: "high" })).body.task;
    await addTaskParticipants(mark, task.id, [sam.userId]);
    await assert.rejects(() => updateTask(sam, task.id, { priority: "high" }), (error: { status?: number }) => error.status === 403);
  });
});

describe("a task can't be created done", () => {
  it("refuses completed: true on create over REST and leaves nothing behind", async () => {
    const { status, body } = await rest({ title: "Born done", completed: true });
    assert.equal(status, 400);
    assert.match(body.error.message, /Create the task, then complete it/);
    assert.equal((await sql("select 1 from crm.tasks where title = 'Born done'")).length, 0);
    const open = await rest({ title: "Born open", completed: false });
    assert.equal(open.status, 201);
  });
});

describe("a reminder that can never go off", () => {
  it("is refused on create and update over REST, and in the app, with what to do instead", async () => {
    const past = await rest({ title: "Past reminder", dueAt: "2026-11-01T10:00", remindMinutes: 15 });
    assert.equal(past.status, 201, "an agent's task belongs to the workspace owner, so it keeps the day and no reminder");
    assert.equal(past.body.task.remindMinutes, null);
    const soon = londonWall(Date.now() + 2 * HOUR);
    const moved = await restPatch(past.body.task.id, { dueAt: "2026-11-02T09:00", remindMinutes: 30 });
    assert.equal(moved.status, 200);
    const timed = (await createTask(mark, { title: "Yesterday's call", dueAt: "2026-11-10T09:00" })).body.task;
    await assert.rejects(() => updateTask(mark, timed.id, { remindMinutes: 0 }), /That time has passed/);
    const kept = (await createTask(mark, { title: "Reminder kept", dueAt: soon, remindMinutes: 15 })).body.task;
    await sql("update crm.tasks set due_at = now() - interval '1 day' where id = $1", [kept.id]);
    const retitled = await updateTask(mark, kept.id, { title: "Reminder kept, renamed" });
    assert.equal(retitled.body.task.remindMinutes, 15);
  });

  it("drops the reminder from a lead's task due in the past instead of refusing the lead", async () => {
    const lead = await ingestLead(mark, { contact: { firstName: "Pat", email: "pat@lead-fixes.test" }, task: { title: "Call Pat", dueAt: "2026-11-01T10:00", remindMinutes: 15 } });
    assert.equal(lead.body.task?.dueHasTime, true);
    assert.equal(lead.body.task?.remindMinutes, null);
  });
});

describe("MCP create_next_action", () => {
  it("takes an idempotency key and creates the task once", async () => {
    const key = randomUUID();
    const first = await mcp("create_next_action", { title: "Send the MCP pack", idempotency_key: key });
    const again = await mcp("create_next_action", { title: "Send the MCP pack", idempotency_key: key });
    assert.equal(first.error, false, first.text);
    assert.equal(again.json?.task?.id, first.json?.task?.id);
    assert.equal((await sql("select 1 from crm.tasks where title = 'Send the MCP pack'")).length, 1);
    const clash = await mcp("create_next_action", { title: "Something else", idempotency_key: key });
    assert.equal(clash.error, true);
    assert.match(clash.text, /already used/);
  });

  it("treats an empty idempotency key as none", async () => {
    const first = await mcp("create_next_action", { title: "Blank key", idempotency_key: "" });
    const second = await mcp("create_next_action", { title: "Blank key", idempotency_key: "  " });
    assert.equal(first.error, false, first.text);
    assert.equal(second.error, false, second.text);
    assert.notEqual(first.json?.task?.id, second.json?.task?.id);
  });

  it("can't create a done task", async () => {
    const made = await mcp("create_next_action", { title: "MCP born open", completed: true });
    assert.equal(made.json?.task?.completedAt ?? null, null);
  });
});
