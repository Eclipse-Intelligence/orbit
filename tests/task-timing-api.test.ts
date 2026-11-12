import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PATCH as restUpdateTask } from "@/app/api/v1/tasks/[id]/route";
import { POST as restCreateTask } from "@/app/api/v1/tasks/route";
import { describeAction, runTool, toolDefinitions } from "@/lib/assistant/tools";
import { SCOPES } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

type TaskBody = {
  id: string;
  dueAt: string | null;
  dueDate: string | null;
  dueHasTime: boolean;
  durationMinutes: number;
  scheduledBy: string | null;
  remindMinutes: number | null;
};
type ErrorBody = { error: { code: string; message: string; details: { field?: string } | null } };

let owner: UserActor;
let agent: AgentActor;
let token = "";

function request(path: string, method: string, body: unknown) {
  return new Request(`http://crm.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rest(body: unknown) {
  const response = await restCreateTask(request("/tasks", "POST", body));
  return { status: response.status, body: (await response.json()) as { task: TaskBody } & ErrorBody };
}

async function restPatch(id: string, body: unknown) {
  const response = await restUpdateTask(request(`/tasks/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as { task: TaskBody } & ErrorBody };
}

async function mcp(name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(agent);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "task-timing", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { error: Boolean(result.isError), text: result.content[0]?.text ?? "" };
  } finally {
    await client.close();
    await server.close();
  }
}

before(async () => {
  await resetDatabase();
  owner = await createUser("timing-api@example.com", "Mark Ridgeon");
  const created = await createAgent(owner.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Timing agent");
  agent = created.actor;
  token = created.token;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("task due day or time over REST", () => {
  it("makes dueDate date only at London midnight, even in summer", async () => {
    const { status, body } = await rest({ title: "Send the order form", dueDate: "2027-07-02", durationMinutes: 30 });
    assert.equal(status, 201);
    assert.equal(body.task.dueDate, "2027-07-02");
    assert.equal(body.task.dueAt, "2027-07-01T23:00:00.000Z");
    assert.equal(body.task.dueHasTime, false);
    assert.equal(body.task.durationMinutes, 30);
    assert.equal(body.task.scheduledBy, null);
  });

  it("makes dueAt with a time timed, placed by a person, and a bare date date only", async () => {
    const timed = await rest({ title: "Ring Ashby Freight", dueAt: "2027-01-12T14:30", remindMinutes: 15 });
    assert.equal(timed.status, 201);
    assert.equal(timed.body.task.dueAt, "2027-01-12T14:30:00.000Z");
    assert.equal(timed.body.task.dueHasTime, true);
    assert.equal(timed.body.task.scheduledBy, "person");
    assert.equal(timed.body.task.remindMinutes, 15);
    assert.equal(timed.body.task.durationMinutes, 15);
    const bare = await rest({ title: "Book a demo", dueAt: "2027-01-13" });
    assert.equal(bare.body.task.dueHasTime, false);
    assert.equal(bare.body.task.dueDate, "2027-01-13");
  });

  it("refuses both fields, a time in dueDate, a reminder without a time and durations out of range", async () => {
    const both = await rest({ title: "Both", dueDate: "2027-01-12", dueAt: "2027-01-12T10:00" });
    assert.equal(both.status, 400);
    assert.equal(both.body.error.details?.field, "dueDate");
    const timeInDate = await rest({ title: "Time in date", dueDate: "2027-01-12T10:00" });
    assert.equal(timeInDate.status, 400);
    const reminder = await rest({ title: "Remind", dueDate: "2027-01-12", remindMinutes: 15 });
    assert.equal(reminder.status, 400);
    assert.equal(reminder.body.error.message, "Pick a time for the reminder.");
    assert.equal(reminder.body.error.details?.field, "remindMinutes");
    for (const durationMinutes of [4, 481, 12.5]) {
      const result = await rest({ title: "Duration", durationMinutes });
      assert.equal(result.status, 400, String(durationMinutes));
    }
    assert.equal((await rest({ title: "Five", durationMinutes: 5 })).status, 201);
    assert.equal((await rest({ title: "Eight hours", durationMinutes: 480 })).status, 201);
  });

  it("drops the time and the reminder when PATCH sends dueDate", async () => {
    const timed = await rest({ title: "Call Jane", dueAt: "2027-01-12T09:15", remindMinutes: 10 });
    const patched = await restPatch(timed.body.task.id, { dueDate: "2027-01-14" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.task.dueHasTime, false);
    assert.equal(patched.body.task.dueDate, "2027-01-14");
    assert.equal(patched.body.task.remindMinutes, null);
    assert.equal(patched.body.task.scheduledBy, null);
    const cleared = await restPatch(timed.body.task.id, { dueDate: null });
    assert.equal(cleared.body.task.dueAt, null);
    assert.equal(cleared.body.task.dueHasTime, false);
  });
});

describe("task due day or time over MCP", () => {
  it("describes dueDate, dueAt and durationMinutes on both task tools", async () => {
    const server = createCrmMcpServer(agent);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "task-timing-list", version: "1.0.0" });
    await client.connect(clientSide);
    const tools = (await client.listTools()).tools;
    await client.close();
    await server.close();
    for (const name of ["create_next_action", "update_next_action"]) {
      const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, { description?: string }>;
      assert.ok(properties.dueDate, name);
      assert.match(properties.dueAt.description ?? "", /only when the person gave a time/i);
      assert.ok(properties.durationMinutes, name);
    }
  });

  it("creates date-only and timed tasks and returns the new fields", async () => {
    const day = await mcp("create_next_action", { title: "Email Raj the case study", dueDate: "2027-03-30", durationMinutes: 10 });
    assert.equal(day.error, false, day.text);
    const dayTask = (JSON.parse(day.text) as { task: TaskBody }).task;
    assert.equal(dayTask.dueHasTime, false);
    assert.equal(dayTask.dueDate, "2027-03-30");
    assert.equal(dayTask.dueAt, "2027-03-29T23:00:00.000Z");
    assert.equal(dayTask.durationMinutes, 10);
    const timed = await mcp("update_next_action", { id: dayTask.id, dueAt: "2027-03-30T11:00" });
    const timedTask = (JSON.parse(timed.text) as { task: TaskBody }).task;
    assert.equal(timedTask.dueHasTime, true);
    assert.equal(timedTask.scheduledBy, "person");
    assert.equal(timedTask.dueAt, "2027-03-30T10:00:00.000Z");
    const both = await mcp("create_next_action", { title: "Both", dueDate: "2027-03-30", dueAt: "2027-03-30T11:00" });
    assert.equal(both.error, true);
    const tooLong = await mcp("create_next_action", { title: "Too long", durationMinutes: 600 });
    assert.equal(tooLong.error, true);
  });
});

describe("task due day or time in the assistant", () => {
  it("offers dueDate and durationMinutes and says to send a time only when the user gave one", () => {
    const definitions = toolDefinitions();
    for (const name of ["create_task", "update_task"]) {
      const parameters = definitions.find((tool) => tool.function.name === name)?.function.parameters as { properties: Record<string, { description?: string }> };
      assert.ok(parameters.properties.dueDate, name);
      assert.ok(parameters.properties.durationMinutes, name);
      assert.match(parameters.properties.dueAt.description ?? "", /only when the user gave a time/i);
    }
  });

  it("shows date only and timed due dates and the duration on the approval card", () => {
    const day = describeAction("create_task", { title: "Call Jane", dueDate: "2027-01-12", durationMinutes: 30 });
    const dayText = JSON.stringify(day);
    assert.match(dayText, /Due: Tue 12 Jan 2027"/);
    assert.doesNotMatch(dayText, /00:00/);
    assert.match(dayText, /Duration: 30m/);
    const timed = JSON.stringify(describeAction("create_task", { title: "Call Jane", dueAt: "2027-01-12T14:30" }));
    assert.match(timed, /14:30/);
  });

  it("creates and updates with dueDate or dueAt, and refuses both", async () => {
    const created = (await runTool(owner, "create_task", { title: "Call Hannah Price", dueDate: "2027-02-02", durationMinutes: 45, sendToClickUp: false })) as { task: TaskBody };
    assert.equal(created.task.dueHasTime, false);
    assert.equal(created.task.dueDate, "2027-02-02");
    assert.equal(created.task.durationMinutes, 45);
    const timed = (await runTool(owner, "update_task", { taskId: created.task.id, dueAt: "2027-02-02T16:00", remindMinutes: 5 })) as { task: TaskBody };
    assert.equal(timed.task.dueHasTime, true);
    assert.equal(timed.task.remindMinutes, 5);
    const listed = (await runTool(owner, "list_tasks", { view: "all" })) as { data: TaskBody[] };
    const row = listed.data.find((task) => task.id === created.task.id);
    assert.equal(row?.dueDate, "2027-02-02");
    assert.equal(row?.dueHasTime, true);
    assert.equal(row?.durationMinutes, 45);
    const both = (await runTool(owner, "update_task", { taskId: created.task.id, dueDate: "2027-02-03", dueAt: "2027-02-03T10:00" })) as { error?: string };
    assert.match(both.error ?? "", /not both/);
  });
});
