import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET as restGetTask } from "@/app/api/v1/tasks/[id]/route";
import { GET as restListTasks, POST as restCreateTask } from "@/app/api/v1/tasks/route";
import { runTool } from "@/lib/assistant/tools";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import { mailThreadSubject } from "@/lib/crm/task-mail";
import { createTask, getTask, listTasks, updateTask } from "@/lib/crm/tasks";
import { listRecentChanges, undoAuditEvent } from "@/lib/crm/undo";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { queueMailWorkflowEvents } from "@/lib/workflows/mail-events";
import { createWorkflow, saveWorkflow, setWorkflowStatus } from "@/lib/workflows/store";
import type { Actor, AgentActor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

type Box = { sourceId: string; inbox: string };

const MIGRATION = "supabase/migrations/20270127100000_task_mail_thread.sql";
const AGAIN = "supabase/migrations/20270127200000_task_mail_thread_again.sql";
const SUBJECT = "Renewal terms for Northwind";

let mark: UserActor;
let sam: UserActor;
let ada: UserActor;
let agent: AgentActor;
let agentToken: string;
let markBox: Box;
let samBox: Box;
let markEmail: string;
let counter = 0;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function mailbox(actor: UserActor): Promise<Box> {
  const connection = await sql<{ id: string }>(
    `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
     values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id`,
    [actor.workspaceId, actor.userId, actor.email],
  );
  const sourceId = (
    await sql<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id", [
      actor.workspaceId,
      actor.userId,
      connection[0].id,
      actor.email,
    ])
  )[0].id;
  const inbox = (
    await sql<{ id: string }>(
      "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, 'inbox', 'inbox') returning id",
      [actor.workspaceId, actor.userId, sourceId, `inbox-${sourceId}`],
    )
  )[0].id;
  return { sourceId, inbox };
}

async function message(actor: UserActor, box: Box, thread: string | null, subject: string) {
  counter += 1;
  const rows = await sql<{ id: string }>(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
       from_email, to_recipients, cc_recipients, sent_at, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'Hello', 'jane@northwind-thread.test', '[]'::jsonb, '[]'::jsonb, now(), now()) returning id`,
    [actor.workspaceId, actor.userId, box.sourceId, box.inbox, `thread-${counter}`, `<thread-${counter}@mail.test>`, thread, subject],
  );
  return rows[0].id;
}

async function mcpCall(actor: Actor, name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor, actor.type === "user" ? { personal: { tokenId: crypto.randomUUID(), canSend: false } } : {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "task-mail-thread", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { error: Boolean(result.isError), text: result.content[0]?.text ?? "" };
  } finally {
    await client.close();
    await server.close();
  }
}

function invalid(field: string) {
  return (error: unknown) => error instanceof CrmError && error.code === "invalid_input" && error.details?.field === field;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@thread.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@thread.test", "Sam Okafor"), "member");
  ada = await join(await createUser("ada@thread.test", "Ada Admin"), "admin");
  const issued = await createAgent(mark.workspaceId, scopesForRole("owner"), "Thread agent");
  agent = issued.actor;
  agentToken = issued.token;
  markBox = await mailbox(mark);
  samBox = await mailbox(sam);
  await message(mark, markBox, "renewal", "Renewal terms");
  markEmail = await message(mark, markBox, "renewal", `Re: ${SUBJECT}`);
  await message(sam, samBox, "sams", "Sam's private pricing");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("the thread link migration", () => {
  it("moves a Mail link line out of the description into mail_thread_key, keeps updated_at, and changes nothing the second time", async () => {
    const source = markBox.sourceId;
    const encoded = (key: string) => encodeURIComponent(`${source}|${key}`);
    const client = await getAdminPool().connect();
    try {
      await client.query("begin");
      const insert = async (title: string, description: string | null) =>
        (
          await client.query<{ id: string }>(
            "insert into crm.tasks (workspace_id, title, description, updated_at) values ($1, $2, $3, now() - interval '3 days') returning id",
            [mark.workspaceId, title, description],
          )
        ).rows[0].id;
      const cases: [string, string | null, string | null, string | null][] = [
        ["follow-up", `Suggested after an email arrived.\n\n[Re: Pilot terms](/mail?thread=${encoded("conv=+/A1")})`, `${source}|conv=+/A1`, "Suggested after an email arrived."],
        ["link only", `[The email](/mail?thread=${encoded("m:abc")})`, `${source}|m:abc`, null],
        ["middle", `Ask about price.\n  [Pricing](/mail?thread=${encoded("mid")})  \r\nThen book a call.`, `${source}|mid`, "Ask about price.\nThen book a call."],
        ["upper case and more params", `Note\n[Deck](/mail?thread=${encodeURIComponent(`${source.toUpperCase()}|Up`)}&compose=reply)`, `${source}|Up`, "Note"],
        ["unicode", `[Café](/mail?thread=${encoded("café-ü")})`, `${source}|café-ü`, null],
        ["two links", `[First](/mail?thread=${encoded("one")})\nKeep me\n[Second](/mail?thread=${encoded("two")})`, `${source}|one`, "Keep me"],
        ["nbsp", `Note\n\u00a0\u00a0[Pricing](/mail?thread=${encoded("nbsp")})\u00a0`, `${source}|nbsp`, "Note"],
        ["bad first, good second", `[Odd](/mail?thread=not-a-uuid%7Ckey)\n[Good](/mail?thread=${encoded("good")})`, `${source}|good`, "[Odd](/mail?thread=not-a-uuid%7Ckey)"],
        ["inline", `See [this](/mail?thread=${encoded("inline")}) first`, null, `See [this](/mail?thread=${encoded("inline")}) first`],
        ["bad source", "[Odd](/mail?thread=not-a-uuid%7Ckey)", null, "[Odd](/mail?thread=not-a-uuid%7Ckey)"],
        ["no key", `[Odd](/mail?thread=${encodeURIComponent(`${source}|`)})`, null, `[Odd](/mail?thread=${encodeURIComponent(`${source}|`)})`],
        ["broken escape", `[Odd](/mail?thread=${source}%7Cab%E2%28)`, null, `[Odd](/mail?thread=${source}%7Cab%E2%28)`],
        ["too long", `[Long](/mail?thread=${encoded("k".repeat(451))})`, null, `[Long](/mail?thread=${encoded("k".repeat(451))})`],
        ["other link", "[Docs](/docs/abc)\nKeep this", null, "[Docs](/docs/abc)\nKeep this"],
        ["plain", "Just text", null, "Just text"],
        ["empty", null, null, null],
      ];
      const ids = new Map<string, string>();
      for (const [title, description] of cases) ids.set(title, await insert(title, description));
      const before = new Map(
        (await client.query<{ id: string; updated_at: Date }>("select id, updated_at from crm.tasks where workspace_id = $1", [mark.workspaceId])).rows.map((row) => [
          row.id,
          row.updated_at.toISOString(),
        ]),
      );
      const migration = readFileSync(MIGRATION, "utf8");
      await client.query(migration);
      const first = (await client.query<{ id: string; mail_thread_key: string | null; description: string | null; updated_at: Date }>(
        "select id, mail_thread_key, description, updated_at from crm.tasks where workspace_id = $1 order by id",
        [mark.workspaceId],
      )).rows;
      await client.query(migration);
      const second = (await client.query<{ id: string; mail_thread_key: string | null; description: string | null; updated_at: Date }>(
        "select id, mail_thread_key, description, updated_at from crm.tasks where workspace_id = $1 order by id",
        [mark.workspaceId],
      )).rows;
      assert.deepEqual(second, first);
      const byId = new Map(first.map((row) => [row.id, row]));
      for (const [title, , key, description] of cases) {
        const row = byId.get(ids.get(title)!)!;
        assert.equal(row.mail_thread_key, key, title);
        assert.equal(row.description, description, title);
        assert.equal(row.updated_at.toISOString(), before.get(row.id), title);
      }
      const enabled = await client.query<{ tgenabled: string }>("select tgenabled from pg_trigger where tgname = 'tasks_set_updated_at' and tgrelid = 'crm.tasks'::regclass");
      assert.equal(enabled.rows[0].tgenabled, "O");
      const moved = (await client.query<{ total: number }>("select count(*)::int as total from crm.tasks where workspace_id = $1 and mail_thread_key is not null", [mark.workspaceId])).rows[0];
      assert.equal(moved.total, 8);
      const late = await insert("written by the old code after the first migration", `Suggested after an email arrived.\n\n[Late](/mail?thread=${encoded("late")})`);
      const lateBefore = (await client.query<{ updated_at: Date }>("select updated_at from crm.tasks where id = $1", [late])).rows[0].updated_at.toISOString();
      const again = readFileSync(AGAIN, "utf8");
      await client.query(again);
      await client.query(again);
      const lateRow = (await client.query<{ mail_thread_key: string | null; description: string | null; updated_at: Date }>("select mail_thread_key, description, updated_at from crm.tasks where id = $1", [late])).rows[0];
      assert.equal(lateRow.mail_thread_key, `${source}|late`);
      assert.equal(lateRow.description, "Suggested after an email arrived.");
      assert.equal(lateRow.updated_at.toISOString(), lateBefore);
      const unchanged = (await client.query<{ id: string; mail_thread_key: string | null; description: string | null; updated_at: Date }>(
        "select id, mail_thread_key, description, updated_at from crm.tasks where workspace_id = $1 and id <> $2 order by id",
        [mark.workspaceId, late],
      )).rows;
      assert.deepEqual(unchanged, first);
      const checks = await client.query("select 1 from pg_constraint where conname = 'tasks_mail_thread_key_check' and conrelid = 'crm.tasks'::regclass");
      assert.equal(checks.rowCount, 1);
      const queued = await client.query("select 1 from crm.task_outlook_queue q join crm.tasks t on t.id = q.task_id where t.workspace_id = $1", [mark.workspaceId]);
      assert.equal(queued.rowCount, 0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("a task's email thread, read by each viewer", () => {
  it("shows the owner the subject and a teammate, an admin and an agent only Email", async () => {
    const key = `${markBox.sourceId}|renewal`;
    const task = (await createTask(mark, { title: "Call Jane about the renewal", description: "Ask about the price.", mailThreadKey: key, ownerId: sam.userId })).body.task;
    assert.equal(task.mailThreadKey, key);
    assert.deepEqual(task.mailThread, { subject: `Re: ${SUBJECT}`, readable: true });
    assert.equal(task.description, "Ask about the price.");

    assert.deepEqual((await getTask(mark, task.id)).mailThread, { subject: `Re: ${SUBJECT}`, readable: true });
    for (const viewer of [sam, ada]) {
      const seen = await getTask(viewer, task.id);
      assert.equal(seen.mailThreadKey, key);
      assert.deepEqual(seen.mailThread, { subject: null, readable: false });
      assert.doesNotMatch(JSON.stringify(seen), /Renewal terms/);
    }
    const listed = (await listTasks(ada, { view: "all" })).data.find((item) => item.id === task.id);
    assert.deepEqual(listed?.mailThread, { subject: null, readable: false });
    const mine = (await listTasks(sam, { mine: true })).data.find((item) => item.id === task.id);
    assert.deepEqual(mine?.mailThread, { subject: null, readable: false });

    const changed = (await updateTask(sam, task.id, { title: "Call Jane about the three-year renewal" })).body.task;
    assert.deepEqual(changed.mailThread, { subject: null, readable: false });
    assert.equal(changed.mailThreadKey, key);

    const asAgent = await getTask(agent, task.id);
    assert.deepEqual(asAgent.mailThread, { subject: null, readable: false });
    const rest = await restGetTask(new Request(`http://crm.test/api/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${agentToken}` } }), {
      params: Promise.resolve({ id: task.id }),
    });
    const restText = await rest.text();
    assert.equal(rest.status, 200);
    assert.doesNotMatch(restText, /Renewal terms/);
    assert.match(restText, /"mailThread":\{"subject":null,"readable":false\}/);
    const restList = await restListTasks(new Request("http://crm.test/api/v1/tasks?view=all", { headers: { authorization: `Bearer ${agentToken}` } }));
    assert.doesNotMatch(await restList.text(), /Renewal terms/);
    const agentMcp = await mcpCall(agent, "get_next_action", { id: task.id });
    assert.equal(agentMcp.error, false);
    assert.doesNotMatch(agentMcp.text, /Renewal terms/);
    const ownerMcp = await mcpCall(mark, "get_next_action", { id: task.id });
    assert.match(ownerMcp.text, /Renewal terms for Northwind/);

    const audit = await sql<{ changes: Record<string, unknown> }>("select changes from crm.audit_events where entity_id = $1 and event_type = 'task.created'", [task.id]);
    assert.doesNotMatch(JSON.stringify(audit[0].changes), /Renewal terms/);
    assert.equal((audit[0].changes.after as Record<string, unknown>).mailThreadKey, key);
  });

  it("only pins a thread in the person's own mailbox, and lets an agent pin a key it was given", async () => {
    await assert.rejects(createTask(sam, { title: "Borrow Mark's thread", mailThreadKey: `${markBox.sourceId}|renewal` }), invalid("mailThreadKey"));
    await assert.rejects(createTask(mark, { title: "Bad key", mailThreadKey: "not a key" }), invalid("mailThreadKey"));
    await assert.rejects(createTask(mark, { title: "Bad key", mailThreadKey: `${markBox.sourceId}|${"k".repeat(451)}` }), invalid("mailThreadKey"));
    const own = (await createTask(sam, { title: "Sam's thread", mailThreadKey: `${samBox.sourceId.toUpperCase()}|sams` })).body.task;
    assert.equal(own.mailThreadKey, `${samBox.sourceId}|sams`);
    assert.deepEqual(own.mailThread, { subject: "Sam's private pricing", readable: true });
    await assert.rejects(updateTask(mark, own.id, { mailThreadKey: `${samBox.sourceId}|missing` }), invalid("mailThreadKey"));
    const kept = (await updateTask(mark, own.id, { mailThreadKey: `${samBox.sourceId}|sams`, title: "Sam's thread, checked" })).body.task;
    assert.equal(kept.mailThreadKey, `${samBox.sourceId}|sams`);
    const unpinned = (await updateTask(mark, own.id, { mailThreadKey: null })).body.task;
    assert.equal(unpinned.mailThreadKey, null);
    assert.equal(unpinned.mailThread, null);

    const created = await restCreateTask(
      new Request("http://crm.test/api/v1/tasks", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Agent pinned", mailThreadKey: `${markBox.sourceId}|renewal` }),
      }),
    );
    assert.equal(created.status, 201);
    const body = (await created.json()) as { task: { id: string; mailThread: unknown } };
    assert.deepEqual(body.task.mailThread, { subject: null, readable: false });
    assert.deepEqual((await getTask(mark, body.task.id)).mailThread, { subject: `Re: ${SUBJECT}`, readable: true });
  });

  it("pins a thread from Mail's Add task and from the assistant's emailId", async () => {
    assert.deepEqual(await mailThreadSubject(mark, `${markBox.sourceId}|renewal`), { key: `${markBox.sourceId}|renewal`, subject: `Re: ${SUBJECT}` });
    assert.equal(await mailThreadSubject(sam, `${markBox.sourceId}|renewal`), null);
    await assert.rejects(mailThreadSubject(mark, "nonsense"), invalid("mailThreadKey"));

    assert.deepEqual(await mailThreadSubject(mark, `  ${markBox.sourceId}|renewal  `), { key: `${markBox.sourceId}|renewal`, subject: `Re: ${SUBJECT}` });
    await assert.rejects(mailThreadSubject(mark, `${markBox.sourceId}|renewal\u0000`), invalid("mailThreadKey"));
    await assert.rejects(createTask(mark, { title: "Control character", mailThreadKey: `${markBox.sourceId}|re\nnewal` }), invalid("mailThreadKey"));

    const lone = await message(mark, markBox, null, "No conversation id");
    const loneTool = (await runTool(mark, "create_task", { title: "Answer the lone email", emailId: lone, sendToClickUp: false })) as { task: { mailThreadKey: string; mailThread: unknown } };
    assert.equal(loneTool.task.mailThreadKey, `${markBox.sourceId}|m:${lone}`);
    assert.deepEqual(loneTool.task.mailThread, { subject: "No conversation id", readable: true });

    const result = (await runTool(mark, "create_task", { title: "Reply to Jane on the renewal", emailId: markEmail, sendToClickUp: false })) as { task: { id: string; mailThreadKey: string; mailThread: unknown } };
    assert.equal(result.task.mailThreadKey, `${markBox.sourceId}|renewal`);
    assert.deepEqual(result.task.mailThread, { subject: `Re: ${SUBJECT}`, readable: true });
    const cleared = (await runTool(mark, "update_task", { taskId: result.task.id, emailId: null })) as { task: { mailThreadKey: string | null } };
    assert.equal(cleared.task.mailThreadKey, null);
    const refused = (await runTool(sam, "create_task", { title: "Not Sam's", emailId: markEmail, sendToClickUp: false })) as { error?: string };
    assert.equal(refused.error, "That email isn\'t in your own Mail. Only emails in your mailbox can be pinned to a task, not ones in a thread shared with you.");
  });

  it("undoes a change to the title and the pinned thread together", async () => {
    const task = (await createTask(mark, { title: "Chase the renewal" })).body.task;
    await updateTask(mark, task.id, { title: "Chase the renewal with Jane", mailThreadKey: `${markBox.sourceId}|renewal` });
    const change = (await listRecentChanges(mark, { entityType: "task" })).find((item) => item.entityId === task.id && item.type === "task.updated");
    assert.ok(change, "the update is listed");
    assert.equal(change.canUndo, true, change.reason);
    await undoAuditEvent(mark, change.id, { operation: "undo_change", source: "web" });
    const restored = await getTask(mark, task.id);
    assert.equal(restored.title, "Chase the renewal");
    assert.equal(restored.mailThreadKey, null);
    assert.equal(restored.mailThread, null);

    const unpin = (await createTask(mark, { title: "Reply on the renewal", mailThreadKey: `${markBox.sourceId}|renewal` })).body.task;
    await updateTask(mark, unpin.id, { mailThreadKey: null });
    const unpinned = (await listRecentChanges(mark, { entityType: "task" })).find((item) => item.entityId === unpin.id && item.type === "task.updated");
    assert.ok(unpinned?.canUndo, unpinned?.reason);
    await undoAuditEvent(mark, unpinned.id, { operation: "undo_change", source: "web" });
    assert.deepEqual((await getTask(mark, unpin.id)).mailThread, { subject: `Re: ${SUBJECT}`, readable: true });
  });
});

describe("a workflow task from an email", () => {
  async function emailWorkflow(name: string, delay: boolean) {
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "email_received", kind: "any", fromContactsOnly: false },
      triggerPosition: { x: 0, y: 0 },
      nodes: [
        ...(delay ? [{ id: "delay_1", type: "delay" as const, config: { amount: 1, unit: "hours" }, position: { x: 0, y: 0 } }] : []),
        { id: "create_task_1", type: "create_task", config: { title: `${name}: {{email.subject}}`, link: "none" }, position: { x: 0, y: 0 } },
      ],
      edges: delay
        ? [
            { source: "trigger", handle: "out", target: "delay_1" },
            { source: "delay_1", handle: "out", target: "create_task_1" },
          ]
        : [{ source: "trigger", handle: "out", target: "create_task_1" }],
    };
    const workflow = await createWorkflow(mark, { name });
    await saveWorkflow(mark, workflow.id, { definition });
    await setWorkflowStatus(mark, workflow.id, "active");
    return workflow.id;
  }

  async function workflowTask(prefix: string) {
    return (await listTasks(mark, { view: "all", query: prefix })).data.find((task) => task.title.startsWith(prefix));
  }

  it("pins the email's thread, and still creates the task when the email has gone from Mail", async () => {
    const pinning = await emailWorkflow("Pinned", false);
    const email = await message(mark, markBox, "workflow-thread", "Order form question");
    assert.equal(await queueMailWorkflowEvents(mark, [email]), 1);
    await runWorkflowTick({ budgetMs: 15_000 });
    const pinned = await workflowTask("Pinned");
    assert.ok(pinned, "the workflow made a task");
    assert.equal(pinned.mailThreadKey, `${markBox.sourceId}|workflow-thread`);
    assert.deepEqual(pinned.mailThread, { subject: "Order form question", readable: true });
    await setWorkflowStatus(mark, pinning, "paused");

    await emailWorkflow("Later", true);
    const gone = await message(mark, markBox, "gone-thread", "Soon deleted");
    assert.equal(await queueMailWorkflowEvents(mark, [gone]), 1);
    await runWorkflowTick({ budgetMs: 15_000 });
    await sql("delete from crm.mail_messages where id = $1", [gone]);
    await sql("update crm.workflow_runs set resume_at = now() - interval '1 minute' where status = 'waiting' and workspace_id = $1", [mark.workspaceId]);
    await runWorkflowTick({ budgetMs: 15_000 });
    const later = await workflowTask("Later");
    assert.ok(later, "the workflow still made a task");
    assert.equal(later.mailThreadKey, null);
    assert.equal(later.mailThread, null);
  });
});
