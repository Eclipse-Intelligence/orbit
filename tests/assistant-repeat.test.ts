import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { repeatAnchorDay } from "@/lib/assistant/repeat-anchor";
import { describeAction, recordNames, runTool, taskRepeatRefusalFor } from "@/lib/assistant/tools";
import { SCOPES } from "@/lib/crm/scopes";
import { createRepeatingTask } from "@/lib/crm/task-series";
import { createTask, getTask } from "@/lib/crm/tasks";
import type { AgentActor, Task, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function weekly(title: string, day = "2027-03-02") {
  return (await createRepeatingTask(mark, { title, dueAt: `${day}T14:00:00.000Z` }, { every: "week" })).body.task;
}

async function card(name: string, args: Record<string, unknown>) {
  return describeAction(name, args, await recordNames(mark, [args], [name]));
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@assistant-repeat.test", "Mark Ridgeon");
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

describe("repeatAnchorDay", () => {
  it("keeps a live series on its open date and reads any date format for a plain task", () => {
    assert.equal(repeatAnchorDay({ occursOn: "2027-03-02", dueAt: "2027-03-05T00:00:00.000Z", live: true }, { dueDate: "2027-03-05" }), "2027-03-02");
    assert.equal(repeatAnchorDay({ occursOn: null, dueAt: "2027-03-02T00:00:00.000Z", live: false }, { dueDate: "20/11/2026" }), "2026-11-20");
    assert.equal(repeatAnchorDay({ occursOn: null, dueAt: "2027-03-02T00:00:00.000Z", live: false }, {}), "2027-03-02");
    assert.equal(repeatAnchorDay(null, { dueAt: "2027-03-05T10:00" }), "2027-03-05");
  });
});

describe("assistant repeat cards", () => {
  it("names the open date's day when repeat and a new due day are sent to a repeating task", async () => {
    const task = await weekly("Team call");
    const shown = await card("update_task", { taskId: task.id, dueDate: "2027-03-05", repeat: { every: "week" } });
    assert.ok(shown.lines.includes("Repeats: Every Tuesday"), shown.lines.join(" | "));
  });

  it("reads a due day that isn't YYYY-MM-DD the way the server does", async () => {
    const plain = (await createTask(mark, { title: "Invoice", dueDate: "2027-03-02" })).body.task;
    const shown = await card("update_task", { taskId: plain.id, dueDate: "20/11/2026", repeat: { every: "month" } });
    assert.ok(shown.lines.includes("Repeats: Every month on the 20th"), shown.lines.join(" | "));
    const created = await card("create_task", { title: "Invoice", dueDate: "20/11/2026", repeat: { every: "month" } });
    assert.ok(created.lines.includes("Repeats: Every month on the 20th"), created.lines.join(" | "));
  });

  it("says archive_records skips the open one of a repeating task, and the result says so", async () => {
    const task = await weekly("Walk the dog");
    const plain = (await createTask(mark, { title: "One off" })).body.task;
    const onlyRepeat = await card("archive_records", { taskIds: [task.id] });
    assert.equal(onlyRepeat.title, "Skip 1 repeating task");
    assert.ok(onlyRepeat.lines.some((line) => /skips this one/.test(line)), onlyRepeat.lines.join(" | "));
    assert.ok(!onlyRepeat.lines.includes("Nothing is deleted."));
    const both = await card("archive_records", { taskIds: [task.id, plain.id] });
    assert.equal(both.title, "Archive 1 record and skip 1 repeating task");

    const result = (await runTool(mark, "archive_records", { taskIds: [task.id, plain.id] })) as { archived: number; skipped?: { taskId: string; skipped: string; next: { dueAt: string | null } }[] };
    assert.equal(result.archived, 1);
    assert.equal(result.skipped?.length, 1);
    assert.equal(result.skipped?.[0].taskId, task.id);
    assert.equal(result.skipped?.[0].skipped, "2027-03-02");
    assert.equal(result.skipped?.[0].next.dueAt, "2027-03-09T14:00:00.000Z");
    const after = await getTask(mark, task.id);
    assert.equal(after.archivedAt, null);
    assert.equal(after.occursOn, "2027-03-09");
  });

  it("skips once when the same approved update_task call runs again", async () => {
    const task = await weekly("Standup");
    const first = (await runTool(mark, "update_task", { taskId: task.id, skip: true }, { callId: "call-skip-1" })) as { task: Task };
    assert.equal(first.task.occursOn, "2027-03-09");
    const again = (await runTool(mark, "update_task", { taskId: task.id, skip: true }, { callId: "call-skip-1" })) as { task: Task };
    assert.equal(again.task.occursOn, "2027-03-09");
    assert.equal((await getTask(mark, task.id)).occursOn, "2027-03-09");
  });
});

describe("assistant repeat review fixes", () => {
  it("refuses a skip with no date before the card, and a skip approved after the task moved on", async () => {
    const task = await weekly("Gym");
    const refused = await taskRepeatRefusalFor(mark, "update_task", { taskId: task.id, skip: true });
    assert.equal(refused?.field, "occursOn");
    const shown = await card("update_task", { taskId: task.id, skip: true, occursOn: "2027-03-02" });
    assert.ok(shown.lines.some((line) => /^Skip .*2 Mar only$/.test(line)), shown.lines.join(" | "));
    await runTool(mark, "update_task", { taskId: task.id, skip: true, occursOn: "2027-03-02" }, { callId: "call-skip-dated-1" });
    const late = (await runTool(mark, "update_task", { taskId: task.id, skip: true, occursOn: "2027-03-02" }, { callId: "call-skip-dated-2" })) as { error?: string };
    assert.ok(late.error, "a skip approved after the date moved on is refused");
    assert.equal((await getTask(mark, task.id)).occursOn, "2027-03-09");
  });

  it("says archive_records archives the last one, and skips once when the same call runs again", async () => {
    const last = (await createRepeatingTask(mark, { title: "Last one", dueAt: "2027-03-02T14:00:00.000Z" }, { every: "week", ends: { after: 1 } })).body.task;
    assert.equal((await card("archive_records", { taskIds: [last.id] })).title, "Archive 1 record");
    const task = await weekly("Retried archive");
    await runTool(mark, "archive_records", { taskIds: [task.id] }, { callId: "call-archive-1" });
    await runTool(mark, "archive_records", { taskIds: [task.id] }, { callId: "call-archive-1" });
    assert.equal((await getTask(mark, task.id)).occursOn, "2027-03-09");
  });

  it("shows the first date on create_task and the kept end on a pattern change", async () => {
    const created = await card("create_task", { title: "Gym", dueDate: "2027-03-05", repeat: { every: "week", days: ["mo"] } });
    assert.ok(created.lines.some((line) => /^Due: .*8 Mar/.test(line)), created.lines.join(" | "));
    const ending = (await createRepeatingTask(mark, { title: "Ends", dueAt: "2027-03-02T14:00:00.000Z" }, { every: "week", ends: { on: "2027-06-01" } })).body.task;
    const changed = await card("update_task", { taskId: ending.id, repeat: { every: "day" } });
    assert.ok(changed.lines.some((line) => /^Repeats: Every day, until /.test(line)), changed.lines.join(" | "));
  });
});

describe("MCP repeat retries", () => {
  it("never skips a second date on a retried skip, and archive_next_action says it skipped", async () => {
    const agent: AgentActor = (await createAgent(mark.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Repeat agent")).actor;
    const server = createCrmMcpServer(agent);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "assistant-repeat", version: "1.0.0" });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      if (result.isError) return { error: result.content[0]?.text } as { error: string; task?: Task; skipped?: string };
      return JSON.parse(result.content[0].text) as { task: Task; skipped?: string; error?: string };
    };
    try {
      const made = (await call("create_next_action", { title: "Report", dueAt: "2027-03-02T10:00", repeat: { every: "week" } })).task!;
      const keyed = await call("update_next_action", { id: made.id, skip: true, idempotency_key: "skip-once" });
      assert.equal(keyed.task?.occursOn, "2027-03-09");
      const keyedAgain = await call("update_next_action", { id: made.id, skip: true, idempotency_key: "skip-once" });
      assert.equal(keyedAgain.task?.occursOn, "2027-03-09");
      const dated = await call("update_next_action", { id: made.id, skip: true, occursOn: "2027-03-09" });
      assert.equal(dated.task?.occursOn, "2027-03-16");
      const datedAgain = await call("update_next_action", { id: made.id, skip: true, occursOn: "2027-03-09" });
      assert.ok(datedAgain.error, "a retry naming the date already skipped is refused");
      const archived = await call("archive_next_action", { id: made.id });
      assert.equal(archived.skipped, "2027-03-16");
      assert.equal(archived.task?.archivedAt, null);
      assert.equal(archived.task?.occursOn, "2027-03-23");
    } finally {
      await client.close();
    }
  });
});
