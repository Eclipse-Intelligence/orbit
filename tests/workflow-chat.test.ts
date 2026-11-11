import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { chatWorkSettled, createRoom, leaveRoom, listMessages, postMessage } from "@/lib/crm/chat";
import { createCompany } from "@/lib/crm/companies";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import type { WorkflowDefinition, WorkflowNode } from "@/lib/workflows/definition";
import { chatPostKey, runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, getRunSteps, listNotifications, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

function definition(nodes: Omit<WorkflowNode, "position">[], edges: WorkflowDefinition["edges"]): WorkflowDefinition {
  return {
    version: 2,
    trigger: { type: "manual", object: "company" },
    triggerPosition: { x: 0, y: 0 },
    nodes: nodes.map((node, index) => ({ ...node, position: { x: 300 * (index + 1), y: 0 } })),
    edges,
  };
}

describe("Post to Chat workflow step", () => {
  let mark: UserActor;
  let sam: UserActor;
  let companyId: string;
  let roomId: string;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@wfchat.test", "Mark Ridgeon");
    const samUser = await createUser("sam@wfchat.test", "Sam Okafor");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, samUser.userId]);
    sam = { ...samUser, workspaceId: mark.workspaceId, role: "member" };
    companyId = (await createCompany(mark, { name: "Acme Chat", domain: "acme-chat.test" })).body.company.id;
    roomId = (await createRoom(mark, { name: "sales", memberIds: [sam.userId] })).id;
  });

  beforeEach(async () => {
    setLiveTesting({ batch: async () => undefined });
    await sql("truncate crm.push_log, crm.notifications");
  });

  afterEach(async () => {
    await chatWorkSettled();
    setLiveTesting(null);
  });

  after(async () => {
    await getPool().end();
  });

  async function flow(name: string, config: Record<string, unknown>) {
    const workflow = await createWorkflow(mark, { name });
    await saveWorkflow(mark, workflow.id, {
      definition: definition([{ id: "post_to_chat_1", type: "post_to_chat", config }], [{ source: "trigger", handle: "out", target: "post_to_chat_1" }]),
    });
    await setWorkflowStatus(mark, workflow.id, "active");
    return workflow.id;
  }

  async function roomMessages(viewer: UserActor, id = roomId) {
    return (await listMessages(viewer, id)).messages;
  }

  it("posts once with the run's fields, marked as sent by the workflow, and alerts tagged people", async () => {
    const before = (await roomMessages(sam)).length;
    const workflowId = await flow("Won deals", { roomId, roomName: "sales", body: `{{company.name}} signed. @[Sam Okafor](member:${sam.userId})` });
    const started = await startRun(mark, workflowId, { test: false, record: { type: "company", id: companyId } });
    assert.equal(started.status, "succeeded");
    const messages = await roomMessages(sam);
    assert.equal(messages.length, before + 1);
    const posted = messages.at(-1)!;
    assert.equal(posted.body, `Acme Chat signed. @[Sam Okafor](member:${sam.userId})`);
    assert.equal(posted.author.id, mark.userId);
    assert.deepEqual(posted.via, { workflowId, name: "Won deals" });
    assert.deepEqual(posted.mentions, [sam.userId]);
    const stored = await sql("select via_workflow_id, via_workflow_name, client_key from crm.chat_messages where id = $1", [posted.id]);
    assert.equal(stored.rows[0].via_workflow_id, workflowId);
    assert.equal(stored.rows[0].via_workflow_name, "Won deals");
    assert.equal(stored.rows[0].client_key, chatPostKey(started.runId, "post_to_chat_1"));
    const step = (await getRunSteps(mark, started.runId)).steps.find((item) => item.stepId === "post_to_chat_1")!;
    assert.equal((step.output as { room: string }).room, "#sales");
    assert.match((step.output as { url: string }).url, new RegExp(`/chat/${roomId}\\?message=${posted.id}$`));
    await chatWorkSettled();
    assert.ok((await sql("select title from crm.notifications where user_id = $1", [sam.userId])).rows.some((row) => row.title === "Mark mentioned you in #sales"));

    await sql("delete from crm.workflows where id = $1", [workflowId]);
    const kept = (await roomMessages(sam)).find((message) => message.id === posted.id)!;
    assert.deepEqual(kept.via, { workflowId: null, name: "Won deals" });
  });

  it("never posts twice when a stuck run is picked up again", async () => {
    const workflowId = await flow("Reclaimed", { roomId, roomName: "sales", body: "Ping for {{company.name}}" });
    const started = await startRun(mark, workflowId, { test: false, record: { type: "company", id: companyId } });
    assert.equal(started.status, "succeeded");
    const count = async () => (await sql("select count(*)::int as n from crm.chat_messages where via_workflow_id = $1", [workflowId])).rows[0].n as number;
    assert.equal(await count(), 1);
    await sql(
      `update crm.workflow_runs set status = 'running', claimed_at = now() - interval '11 minutes', finished_at = null,
         state = jsonb_set(state, '{at}', '"post_to_chat_1"') where id = $1`,
      [started.runId],
    );
    await runWorkflowTick({ budgetMs: 15_000 });
    const { run, steps } = await getRunSteps(mark, started.runId);
    assert.equal(run.status, "succeeded");
    assert.equal(await count(), 1);
    assert.equal((steps.filter((step) => step.stepId === "post_to_chat_1").at(-1)!.output as { duplicate: boolean }).duplicate, true);
  });

  it("posts once per loop item", async () => {
    const workflow = await createWorkflow(mark, { name: "Each item" });
    await saveWorkflow(mark, workflow.id, {
      definition: definition(
        [
          { id: "loop_1", type: "loop", config: { items: "{{company.name}}", limit: 5 } },
          { id: "post_to_chat_1", type: "post_to_chat", config: { roomId, roomName: "sales", body: "Item {{loop.index}}" } },
        ],
        [
          { source: "trigger", handle: "out", target: "loop_1" },
          { source: "loop_1", handle: "each", target: "post_to_chat_1" },
        ],
      ),
    });
    await setWorkflowStatus(mark, workflow.id, "active");
    const started = await startRun(mark, workflow.id, { test: false, record: { type: "company", id: companyId } });
    assert.equal(started.status, "succeeded");
    const keys = (await sql("select client_key from crm.chat_messages where via_workflow_id = $1", [workflow.id])).rows.map((row) => row.client_key);
    assert.deepEqual(keys, [chatPostKey(started.runId, "post_to_chat_1", [{ index: 0 }])]);
    assert.notEqual(chatPostKey(started.runId, "post_to_chat_1", [{ index: 0 }]), chatPostKey(started.runId, "post_to_chat_1", [{ index: 1 }]));
    const long = chatPostKey(started.runId, "a_very_long_step_identifier_of_forty_ch", Array.from({ length: 12 }, (_, index) => ({ index: index + 10 })));
    assert.ok(long.length <= 100);
    assert.match(long, /^wf:[A-Za-z0-9_-]{43}$/);
  });

  it("skips posting in test runs", async () => {
    const workflowId = await flow("Tested", { roomId, roomName: "sales", body: "Only a test" });
    const started = await startRun(mark, workflowId, { test: true, record: { type: "company", id: companyId } });
    assert.equal(started.status, "succeeded");
    assert.equal((await sql("select count(*)::int as n from crm.chat_messages where body = 'Only a test'")).rows[0].n, 0);
    const step = (await getRunSteps(mark, started.runId)).steps.find((item) => item.stepId === "post_to_chat_1")!;
    assert.equal((step.output as { testRun: boolean }).testRun, true);
  });

  it("finds a room by name for definitions written without an id", async () => {
    const workflowId = await flow("By name", { roomName: "#Sales", body: "Found by name" });
    assert.equal((await startRun(mark, workflowId, { test: false, record: { type: "company", id: companyId } })).status, "succeeded");
    assert.ok((await roomMessages(mark)).some((message) => message.body === "Found by name"));

    const missing = await flow("Wrong name", { roomName: "nope", body: "Nowhere" });
    const failed = await startRun(mark, missing, { test: false, record: { type: "company", id: companyId } });
    assert.equal(failed.status, "failed");
    assert.match((await getRunSteps(mark, failed.runId)).run.error ?? "", /Couldn't post to Chat: you're not in a room called #nope\./);
  });

  it("fails clearly when the room is empty or the message is blank", async () => {
    const noRoom = await flow("No room", { roomId: "", roomName: "", body: "Hi" });
    const first = await startRun(mark, noRoom, { test: false, record: { type: "company", id: companyId } });
    assert.match((await getRunSteps(mark, first.runId)).run.error ?? "", /Couldn't post to Chat: choose a room\./);
    const blank = await flow("Blank", { roomId, roomName: "sales", body: "{{company.missing}}" });
    const second = await startRun(mark, blank, { test: false, record: { type: "company", id: companyId } });
    assert.match((await getRunSteps(mark, second.runId)).run.error ?? "", /Couldn't post to Chat: the message is empty\./);
  });

  it("refuses to mark a message as sent by someone else's workflow", async () => {
    const workflowId = await flow("Mark's own", { roomId, roomName: "sales", body: "Hi" });
    await assert.rejects(postMessage(sam, { conversationId: roomId, body: "Pretending" }, { viaWorkflowId: workflowId }), /Only the workflow's owner can post from it\./);
    assert.equal((await sql("select count(*)::int as n from crm.chat_messages where body = 'Pretending'")).rows[0].n, 0);
  });

  it("fails with a clear error and alerts the owner once they have left the room", async () => {
    const lonely = (await createRoom(mark, { name: "deals", memberIds: [sam.userId] })).id;
    const workflowId = await flow("Left behind", { roomId: lonely, roomName: "deals", body: "Still here?" });
    await leaveRoom(mark, lonely);
    const started = await startRun(mark, workflowId, { test: false, record: { type: "company", id: companyId } });
    assert.equal(started.status, "failed");
    const { run, steps } = await getRunSteps(mark, started.runId);
    assert.equal(run.error, "post_to_chat_1: Couldn't post to Chat: you're no longer in #deals.");
    assert.equal(steps.find((step) => step.stepId === "post_to_chat_1")?.status, "failed");
    assert.equal((await roomMessages(sam, lonely)).some((message) => message.body === "Still here?"), false);
    const alerts = await listNotifications(mark);
    assert.ok(alerts.some((item) => item.title === "Left behind failed" && (item.body ?? "").includes("you're no longer in #deals")));
    assert.ok(!(await roomMessages(sam, lonely)).some((message) => message.via));
    assert.ok(!(await sql("select 1 from crm.chat_messages where via_workflow_id = $1", [workflowId])).rowCount);
  });
});
