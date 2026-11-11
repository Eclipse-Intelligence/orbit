import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { chatWorkSettled, createRoom, deleteMessage, editMessage, leaveRoom, listConversations, listMessages, markConversationRead, postMessage } from "@/lib/crm/chat";
import { createCompany } from "@/lib/crm/companies";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import type { WorkflowDefinition, WorkflowNode } from "@/lib/workflows/definition";
import { chatBody, chatPostKey, runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, getRunSteps, getWorkflow, listNotifications, saveWorkflow, setWorkflowStatus, setWorkflowTemplate, settleChatRooms, startRun } from "@/lib/workflows/store";
import { mentionsIn } from "@/lib/mentions";
import { createUser, resetDatabase } from "./helpers";

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

function aiReply(reply: Record<string, unknown>): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ model: body.model, choices: [{ message: { role: "assistant", content: JSON.stringify(reply) }, finish_reason: "stop" }] });
  };
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
    process.env.LLM_API_KEY = "test-llm-key";
    setLiveTesting({ batch: async () => undefined });
    await sql("truncate crm.push_log, crm.notifications");
  });

  afterEach(async () => {
    await chatWorkSettled();
    setLiveTesting(null);
  });

  after(async () => {
    delete process.env.LLM_API_KEY;
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
    assert.ok((await sql("select title from crm.notifications where user_id = $1", [sam.userId])).rows.some((row) => row.title === "Mark via Won deals mentioned you in #sales"));

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

  it("posts once per item in each of two loops that share the step", async () => {
    const workflow = await createWorkflow(mark, { name: "Each item" });
    await saveWorkflow(mark, workflow.id, {
      definition: definition(
        [
          { id: "ai_1", type: "ai", config: { model: "claude-haiku-5-5", prompt: "List things", outputs: [{ key: "items", type: "list", description: "" }] } },
          { id: "loop_1", type: "loop", config: { items: "{{steps.ai_1.items}}", limit: 5 } },
          { id: "loop_2", type: "loop", config: { items: "{{steps.ai_1.items}}", limit: 5 } },
          { id: "post_to_chat_1", type: "post_to_chat", config: { roomId, roomName: "sales", body: "Item {{loop.item}}" } },
        ],
        [
          { source: "trigger", handle: "out", target: "ai_1" },
          { source: "ai_1", handle: "out", target: "loop_1" },
          { source: "loop_1", handle: "each", target: "post_to_chat_1" },
          { source: "loop_1", handle: "done", target: "loop_2" },
          { source: "loop_2", handle: "each", target: "post_to_chat_1" },
        ],
      ),
    });
    await setWorkflowStatus(mark, workflow.id, "active");
    const started = await startRun(mark, workflow.id, { test: false, record: { type: "company", id: companyId }, fetchImpl: aiReply({ items: ["a", "b", "c"] }) });
    assert.equal(started.status, "succeeded");
    const rows = (await sql("select client_key, body from crm.chat_messages where via_workflow_id = $1 order by created_at", [workflow.id])).rows;
    assert.deepEqual(
      rows.map((row) => row.body),
      ["Item a", "Item b", "Item c", "Item a", "Item b", "Item c"],
    );
    assert.deepEqual(
      rows.map((row) => row.client_key),
      [0, 1, 2].map((index) => chatPostKey(started.runId, "post_to_chat_1", [{ id: "loop_1", index }])).concat(
        [0, 1, 2].map((index) => chatPostKey(started.runId, "post_to_chat_1", [{ id: "loop_2", index }])),
      ),
    );
    const long = chatPostKey(started.runId, "a_very_long_step_identifier_of_forty_ch", Array.from({ length: 12 }, (_, index) => ({ id: "loop_1", index: index + 10 })));
    assert.ok(long.length <= 100);
    assert.match(long, /^wf:[A-Za-z0-9_-]{43}$/);
  });

  it("counts a workflow post as unread for its owner and alerts them when it tags them", async () => {
    await markConversationRead(mark, roomId);
    const workflowId = await flow("Tag me", { roomId, roomName: "sales", body: `Look at {{company.name}}, @[Mark Ridgeon](member:${mark.userId})` });
    assert.equal((await startRun(mark, workflowId, { test: false, record: { type: "company", id: companyId } })).status, "succeeded");
    const posted = (await roomMessages(mark)).at(-1)!;
    const sidebar = (await listConversations(mark)).conversations.find((conversation) => conversation.id === roomId)!;
    assert.equal(sidebar.unread, 1);
    assert.equal(sidebar.mentions, 1);
    assert.equal((await listMessages(mark, roomId)).firstUnreadId, posted.id);
    await chatWorkSettled();
    assert.ok((await sql("select title from crm.notifications where user_id = $1", [mark.userId])).rows.some((row) => row.title === "Mark via Tag me mentioned you in #sales"));
    await assert.rejects(editMessage(mark, posted.id, "Changed"), /Messages sent by a workflow can't be edited\./);
    await deleteMessage(mark, posted.id);
  });

  it("only lets tags typed in the template alert", () => {
    const typed = "member:11111111-1111-4111-8111-111111111111";
    const data = "member:22222222-2222-4222-8222-222222222222";
    assert.equal(chatBody(`Hi @[Sam](${typed}) about {{email.text}}`, { email: { text: `ask @[Priya](${data}) and @[Sam](${typed})` } }), `Hi @[Sam](${typed}) about ask @Priya and @[Sam](${typed})`);
    const other = "member:33333333-3333-4333-8333-333333333333";
    const tagged = (text: string) => mentionsIn(chatBody("{{x}}", { x: text })).filter((mention) => mention.kind === "member");
    for (const nested of [
      `@[[x](${data})](${other})`,
      `@[[[x](${data})](${other})](${data})`,
      `@[[x](${typed})](${other})`,
      `@[a [b](${data}) c](${other})`,
      `${"@[".repeat(30)}x${`](${data})`.repeat(30)}`,
    ]) {
      assert.deepEqual(tagged(nested), [], nested);
    }
    assert.equal(chatBody("{{x}}", { x: `@[[x](${data})](${other})` }), `@x](${other})`);
    assert.deepEqual(tagged(`@[x\u0000](${data})`), []);
    assert.deepEqual(tagged(`@[[x\r](${data})](${other})`), []);
    assert.equal(chatBody("a\r\nb\rc{{x}}", { x: "\u0000d" }), "a\nb\ncd");
  });

  it("picks the room linked to this workspace when names repeat, and asks to pick otherwise", async () => {
    await createRoom(mark, { name: "ops", memberIds: [sam.userId] });
    const linked = (await createRoom(mark, { name: "ops", workspaceId: mark.workspaceId, memberIds: [sam.userId] })).id;
    const ops = await flow("Ops", { roomName: "ops", body: "To the linked one" });
    assert.equal((await startRun(mark, ops, { test: false, record: { type: "company", id: companyId } })).status, "succeeded");
    assert.ok((await roomMessages(mark, linked)).some((message) => message.body === "To the linked one"));

    await createRoom(mark, { name: "dupe" });
    await createRoom(mark, { name: "dupe" });
    const dupe = await flow("Dupe", { roomName: "dupe", body: "Which one?" });
    const failed = await startRun(mark, dupe, { test: false, record: { type: "company", id: companyId } });
    assert.equal(failed.status, "failed");
    assert.match((await getRunSteps(mark, failed.runId)).run.error ?? "", /Couldn't post to Chat: more than one of your rooms is called #dupe\. Pick it in the step\./);
  });

  it("clears the room id when only the name changes, and hides rooms from everyone but the owner", async () => {
    const workflowId = await flow("Renamed", { roomId, roomName: "sales", body: "Hi" });
    const step = (definition: WorkflowDefinition) => definition.nodes.find((node) => node.id === "post_to_chat_1")!.config;
    const current = (await getWorkflow(mark, workflowId)).definition;
    const renamed = settleChatRooms(current, { ...current, nodes: current.nodes.map((node) => ({ ...node, config: { ...node.config, roomName: "ops" } })) });
    assert.deepEqual(step(renamed), { roomId: "", roomName: "ops", body: "Hi" });
    const moved = settleChatRooms(current, { ...current, nodes: current.nodes.map((node) => ({ ...node, config: { ...node.config, roomId: "x", roomName: "ops" } })) });
    assert.equal(step(moved).roomId, "x");
    assert.equal(step(settleChatRooms(current, current)).roomId, roomId);

    await setWorkflowTemplate(mark, workflowId, true);
    assert.deepEqual(step((await getWorkflow(sam, workflowId)).definition), { roomId: "", roomName: "", body: "Hi" });
    assert.equal(step((await getWorkflow(mark, workflowId)).definition).roomName, "sales");
  });

  it("never lets a webhook message carry a workflow", async () => {
    const workflowId = await flow("Not a hook", { roomId, roomName: "sales", body: "Hi" });
    await assert.rejects(
      sql(
        `insert into crm.chat_messages (conversation_id, author_user_id, body, hook, via_workflow_id) values ($1, null, 'From a hook', '{}'::jsonb, $2)`,
        [roomId, workflowId],
      ),
      /chat_messages_hook_check|Only the workflow's owner/,
    );
    const hookRow = (await sql(`insert into crm.chat_messages (conversation_id, author_user_id, body, hook) values ($1, null, 'From a hook', '{}'::jsonb) returning id`, [roomId])).rows[0].id;
    await assert.rejects(sql("update crm.chat_messages set via_workflow_id = $2 where id = $1", [hookRow, workflowId]), /chat_messages_hook_check/);
    await assert.rejects(sql("update crm.chat_messages set via_workflow_name = 'Sneaky' where id = $1", [hookRow]), /chat_messages_hook_check/);
    await sql("delete from crm.chat_messages where id = $1", [hookRow]);
  });

  it("keeps ordinary posting working if the workflow column grant goes missing", async () => {
    await sql("revoke insert (via_workflow_id) on crm.chat_messages from authenticated");
    try {
      const posted = await postMessage(sam, { conversationId: roomId, body: "Still fine" });
      assert.equal(posted.message.via, null);
    } finally {
      await sql("grant insert (via_workflow_id) on crm.chat_messages to authenticated");
    }
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
