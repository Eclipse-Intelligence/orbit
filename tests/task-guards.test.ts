import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import { upsertContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { detectPadRecords } from "@/lib/crm/task-pad";
import { archiveTask, completeTask, createTask, getTask, updateTask } from "@/lib/crm/tasks";
import { removeMember } from "@/lib/crm/team";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { agentSource, companyMutationSchema, parseInput } from "@/lib/crm/validation";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, resetDatabase } from "@/tests/helpers";
import { createCrmMcpServer } from "@/server/mcp/server";

let eclipse: UserActor;
let ridgeon: UserActor;
let priya: UserActor;
let agent: AgentActor;

const admin = () => getAdminPool();

function inWorkspace(actor: UserActor, workspaceId: string, workspaceName: string, role: UserActor["role"]): UserActor {
  return { ...actor, workspaceId, workspaceName, role, scopes: scopesForRole(role) };
}

async function mcp(actor: Actor, name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "guards", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0]?.text ?? "";
    let json: { task?: { id: string; dueHasTime: boolean; remindMinutes: number | null } } | null = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { error: Boolean(result.isError), text, json };
  } finally {
    await client.close();
    await server.close();
  }
}

async function audits(entityId: string) {
  const result = await admin().query<{ workspace_id: string; event_type: string; source: string | null; changes: Record<string, unknown> }>(
    "select workspace_id, event_type, source, changes from crm.audit_events where entity_id = $1 order by created_at",
    [entityId],
  );
  return result.rows;
}

async function addMember(workspaceId: string, userId: string, role = "member") {
  await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3) on conflict do nothing", [workspaceId, userId, role]);
}

const notFoundError = (error: unknown) => error instanceof CrmError && error.status === 404;

before(async () => {
  await resetDatabase();
  const mark = await createUser("mark@guards.test", "Mark Ridgeon");
  await admin().query("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
  eclipse = { ...mark, workspaceName: "Eclipse" };
  const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
  ridgeon = inWorkspace(eclipse, created.id, "Mark Ridgeon", "owner");
  const person = await createUser("priya@guards.test", "Priya Shah");
  await addMember(eclipse.workspaceId, person.userId);
  priya = inWorkspace(person, eclipse.workspaceId, "Eclipse", "member");
  agent = (await createAgent(eclipse.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Guard agent")).actor;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("tasks in another workspace", () => {
  it("never changes another workspace's task through the domain functions", async () => {
    const task = (await createTask(ridgeon, { title: "Send the retainer" })).body.task;
    await assert.rejects(updateTask(eclipse, task.id, { title: "Renamed" }), notFoundError);
    await assert.rejects(completeTask(eclipse, task.id), notFoundError);
    await assert.rejects(archiveTask(eclipse, task.id), notFoundError);
    await assert.rejects(getTask(eclipse, task.id), notFoundError);
    const kept = await getTask(ridgeon, task.id);
    assert.equal(kept.title, "Send the retainer");
    assert.equal(kept.completedAt, null);
    assert.equal(kept.archivedAt, null);
    assert.deepEqual((await audits(task.id)).map((row) => row.event_type), ["task.created"]);
  });

  it("names the workspace to use when MCP gets another workspace's task", async () => {
    const task = (await createTask(ridgeon, { title: "Book the venue" })).body.task;
    for (const [name, args] of [
      ["update_next_action", { id: task.id, title: "Renamed" }],
      ["complete_next_action", { id: task.id }],
      ["archive_next_action", { id: task.id }],
      ["get_next_action", { id: task.id }],
    ] as const) {
      const result = await mcp(eclipse, name, args);
      assert.equal(result.error, true, name);
      assert.match(result.text, /^not_found: That task is in Mark Ridgeon, and this token works in Eclipse\. Use a personal token made in Mark Ridgeon\.$/, name);
    }
    const kept = await getTask(ridgeon, task.id);
    assert.equal(kept.title, "Book the venue");
    assert.equal(kept.completedAt, null);
    assert.equal(kept.archivedAt, null);
    assert.equal((await admin().query("select 1 from crm.workflow_events where entity_id = $1 and workspace_id = $2", [task.id, eclipse.workspaceId])).rowCount, 0);
  });
});

describe("archived tasks", () => {
  it("refuses to edit or complete an archived task", async () => {
    const task = (await createTask(eclipse, { title: "Archived call" })).body.task;
    await archiveTask(eclipse, task.id);
    await assert.rejects(updateTask(eclipse, task.id, { title: "Changed after archive" }), notFoundError);
    await assert.rejects(completeTask(eclipse, task.id), notFoundError);
    const viaAgent = await mcp(agent, "complete_next_action", { id: task.id });
    assert.equal(viaAgent.error, true);
    assert.match(viaAgent.text, /^not_found/);
    const viaAssistant = (await runTool(eclipse, "update_task", { taskId: task.id, completed: true })) as { error?: string };
    assert.ok(viaAssistant.error);
    const events = (await audits(task.id)).map((row) => row.event_type);
    assert.deepEqual(events, ["task.created", "task.archived"]);
    const stored = await admin().query("select title, completed_at from crm.tasks where id = $1", [task.id]);
    assert.deepEqual(stored.rows[0], { title: "Archived call", completed_at: null });
  });
});

describe("assistant reminders", () => {
  it("removes a reminder when the assistant sends null, and the card says so", async () => {
    const task = (await createTask(eclipse, { title: "Call Bob", dueAt: "2027-03-01T10:00", remindMinutes: 15 })).body.task;
    assert.equal(task.remindMinutes, 15);
    const card = describeAction("update_task", { taskId: task.id, remindMinutes: null });
    assert.ok(card.lines.includes("Reminder: none"), card.lines.join("\n"));
    const out = (await runTool(eclipse, "update_task", { taskId: task.id, remindMinutes: null })) as { error?: string; task?: { remindMinutes: number | null } };
    assert.equal(out.error, undefined);
    assert.equal(out.task?.remindMinutes, null);
    assert.equal((await getTask(eclipse, task.id)).remindMinutes, null);
  });
});

describe("agent provenance", () => {
  it("drops sources that Orbit uses for its own writes", () => {
    for (const source of ["web", "Email", " clickup ", "workflow", "communication", "assistant", "mcp", "granola"]) assert.equal(agentSource(source), null, source);
    assert.equal(agentSource("research-agent"), "research-agent");
    assert.equal(agentSource(null), null);
    const parsed = parseInput(companyMutationSchema, { name: "Acme", provenance: { source: "email", sourceUrl: "https://example.com" } });
    assert.equal(parsed.provenance?.source, null);
  });

  it("keeps workflows and alerts running when an agent claims an internal source", async () => {
    const created = await mcp(agent, "create_next_action", { title: "From the inbox", ownerId: priya.userId, provenanceSource: "clickup" });
    const id = created.json!.task!.id;
    await mcp(agent, "complete_next_action", { id, provenanceSource: "email" });
    const rows = await audits(id);
    assert.deepEqual(rows.map((row) => [row.event_type, row.source]), [["task.created", null], ["task.completed", null]]);
    const events = await admin().query<{ event_type: string }>("select event_type from crm.workflow_events where entity_id = $1 order by created_at", [id]);
    assert.deepEqual(events.rows.map((row) => row.event_type), ["task.completed"]);
  });
});

describe("task approval cards", () => {
  it("shows a teammate's task as date only with no reminder, and ClickUp only when it's set up", async () => {
    const args = { title: "Call Bob", ownerId: priya.userId, dueAt: "2027-03-01T10:00", remindMinutes: 15 };
    const names = await recordNames(eclipse, [args], ["create_task"]);
    const card = describeAction("create_task", args, names);
    assert.ok(card.lines.includes("Due: Mon 1 Mar 2027"), card.lines.join("\n"));
    assert.ok(card.lines.includes("Date only: only the owner sets a time"), card.lines.join("\n"));
    assert.ok(!card.lines.some((line) => line.startsWith("Reminder")), card.lines.join("\n"));
    assert.ok(!card.lines.some((line) => line.startsWith("ClickUp: yes")), card.lines.join("\n"));
    const created = (await runTool(eclipse, "create_task", args)) as { task: { id: string; dueHasTime: boolean; remindMinutes: number | null; dueDate: string } };
    assert.equal(created.task.dueHasTime, false);
    assert.equal(created.task.remindMinutes, null);
    assert.equal(created.task.dueDate, "2027-03-01");

    const own = { title: "Call Ann", dueAt: "2027-03-01T10:00", remindMinutes: 15 };
    const ownCard = describeAction("create_task", own, await recordNames(eclipse, [own], ["create_task"]));
    assert.ok(ownCard.lines.some((line) => /^Due: .*10:00$/.test(line)), ownCard.lines.join("\n"));
    assert.ok(ownCard.lines.some((line) => line.startsWith("Reminder: ")), ownCard.lines.join("\n"));

    const update = { taskId: created.task.id, dueAt: "2027-03-02T11:00", remindMinutes: 30 };
    const updateCard = describeAction("update_task", update, await recordNames(eclipse, [update], ["update_task"]));
    assert.ok(updateCard.lines.includes("Due: Tue 2 Mar 2027"), updateCard.lines.join("\n"));
    assert.ok(!updateCard.lines.some((line) => line.startsWith("Reminder")), updateCard.lines.join("\n"));
  });
});

describe("midnight times", () => {
  it("sets a midnight time on a date-only task, with a reminder in the same call", async () => {
    const task = (await createTask(eclipse, { title: "Midnight call", dueDate: "2027-03-01" })).body.task;
    assert.equal(task.dueHasTime, false);
    const timed = (await updateTask(eclipse, task.id, { dueAt: "2027-03-01T00:00", remindMinutes: 15 })).body.task;
    assert.equal(timed.dueHasTime, true);
    assert.equal(timed.remindMinutes, 15);
    const viaMcp = (await createTask(eclipse, { title: "Midnight MCP", dueDate: "2027-03-01" })).body.task;
    const moved = await mcp(eclipse, "update_next_action", { id: viaMcp.id, dueAt: "2027-03-01T00:00" });
    assert.equal(moved.json?.task?.dueHasTime, true);
  });

  it("still keeps a date-only task date only when its own dueAt is sent back", async () => {
    const task = (await createTask(eclipse, { title: "Echo day", dueDate: "2027-03-01" })).body.task;
    const echoed = (await updateTask(eclipse, task.id, { dueAt: task.dueAt, title: "Echo day renamed" })).body.task;
    assert.equal(echoed.dueHasTime, false);
  });
});

describe("removing a member", () => {
  it("records an audit event for every record handed to the remover, and leaves done tasks with them", async () => {
    const leaver = await createUser("sam@guards.test", "Sam Leaver");
    await addMember(eclipse.workspaceId, leaver.userId);
    const sam = inWorkspace(leaver, eclipse.workspaceId, "Eclipse", "member");
    const company = (await createCompany(sam, { name: "Sam's Accounts Ltd", ownerId: sam.userId })).body.company;
    const contact = (await upsertContact(sam, { firstName: "Lee", lastName: "Handover", email: "lee@handover.test", ownerId: sam.userId })).body.contact;
    const open = (await createTask(sam, { title: "Sam's call", dueAt: "2027-03-01T10:00", remindMinutes: 15 })).body.task;
    const done = (await createTask(sam, { title: "Sam's done call" })).body.task;
    await completeTask(sam, done.id);
    await removeMember(eclipse, sam.userId, { operation: "remove_member", source: "web" });

    const companyEvents = await audits(company.id);
    const updated = companyEvents.find((row) => row.event_type === "company.updated");
    assert.ok(updated);
    assert.equal(updated.source, "web");
    assert.deepEqual(updated.changes, { fields: ["ownerId"], before: { ownerId: sam.userId }, after: { ownerId: eclipse.userId } });
    assert.ok((await audits(contact.id)).some((row) => row.event_type === "contact.updated"));
    const taskEvent = (await audits(open.id)).find((row) => row.event_type === "task.updated");
    assert.ok(taskEvent);
    assert.deepEqual(taskEvent.changes.fields, ["ownerId", "dueAt", "dueHasTime", "scheduledBy", "remindMinutes"]);
    assert.deepEqual((taskEvent.changes.after as Record<string, unknown>).dueHasTime, false);
    const workflows = await admin().query("select 1 from crm.workflow_events where entity_id = $1 and event_type = 'company.updated'", [company.id]);
    assert.equal(workflows.rowCount, 1);

    const stillDone = await admin().query<{ owner_id: string }>("select owner_id from crm.tasks where id = $1", [done.id]);
    assert.equal(stillDone.rows[0].owner_id, sam.userId);
    assert.ok(!(await audits(done.id)).some((row) => row.event_type === "task.updated"));
  });
});

describe("curly apostrophes", () => {
  it("links names whatever apostrophe the title or the record uses", async () => {
    const straight = (await upsertContact(eclipse, { firstName: "Mary", lastName: "O'Brien", email: "mary@obrien.test" })).body.contact;
    const curly = (await upsertContact(eclipse, { firstName: "Sean", lastName: "O’Neill", email: "sean@oneill.test" })).body.contact;
    const first = (await createTask(eclipse, { title: "Call Mary O’Brien" })).body.task;
    assert.equal(first.contactId, straight.id);
    const second = (await createTask(eclipse, { title: "Call Sean O'Neill" })).body.task;
    assert.equal(second.contactId, curly.id);
    const surname = (await createTask(eclipse, { title: "Call O’Brien" })).body.task;
    assert.equal(surname.contactId, null);
    const pad = await detectPadRecords(eclipse, "Call O’Brien");
    assert.equal(pad.contact?.id, straight.id);
    assert.equal(pad.word, "O’Brien");
  });
});
