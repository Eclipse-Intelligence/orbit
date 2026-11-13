import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET as restGetTask } from "@/app/api/v1/tasks/[id]/route";
import { pageContext } from "@/lib/assistant/page-context";
import { runTool } from "@/lib/assistant/tools";
import { outsideRead, webGateState } from "@/lib/assistant/web-gate";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { createOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { mailThreadLine, withMailThread } from "@/lib/crm/task-description";
import { detailOfTask, taskDetail, taskDetailOrNull, type TaskDetail } from "@/lib/crm/task-detail";
import { addTaskParticipants, archiveTask, createTask, getTask } from "@/lib/crm/tasks";
import type { Actor, AgentActor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

type Box = { sourceId: string; inbox: string; sent: string };

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let outsider: UserActor;
let second: UserActor;
let agent: AgentActor;
let agentToken: string;
let northwind: string;
let jane: string;
let renewal: string;
let stageName: string;
let markBox: Box;
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
  const folder = async (role: string) =>
    (
      await sql<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $4, $5) returning id",
        [actor.workspaceId, actor.userId, sourceId, `${role}-${sourceId}`, role],
      )
    )[0].id;
  return { sourceId, inbox: await folder("inbox"), sent: await folder("sent") };
}

async function message(actor: UserActor, box: Box, values: { thread: string; from: string; to: string[]; subject: string; at: string; sent?: boolean }) {
  counter += 1;
  const rows = await sql<{ id: string }>(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
       from_email, to_recipients, cc_recipients, sent_at, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'Hello', $9, $10::jsonb, '[]'::jsonb, $11, $11) returning id`,
    [
      actor.workspaceId,
      actor.userId,
      box.sourceId,
      values.sent ? box.sent : box.inbox,
      `detail-${counter}`,
      `<detail-${counter}@mail.test>`,
      values.thread,
      values.subject,
      values.from,
      JSON.stringify(values.to.map((address) => ({ name: "", address }))),
      values.at,
    ],
  );
  return rows[0].id;
}

async function mcpCall(actor: Actor, name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor, actor.type === "user" ? { personal: { tokenId: crypto.randomUUID(), canSend: false } } : {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "task-detail", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { names, error: Boolean(result.isError), text: result.content[0]?.text ?? "" };
  } finally {
    await client.close();
    await server.close();
  }
}

async function rejects(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && error.code === code);
}

let callJane: string;
let threadEmail: string;

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@detail.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@detail.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@detail.test", "Priya Shah"), "member");
  outsider = await createUser("olly@elsewhere.test", "Olly Outside");
  const created = await createWorkspace(mark, { name: "Second brand" });
  second = { ...mark, workspaceId: created.id, workspaceName: "Second brand" };
  const issued = await createAgent(mark.workspaceId, scopesForRole("owner"), "Detail agent");
  agent = issued.actor;
  agentToken = issued.token;
  northwind = (await createCompany(mark, { name: "Northwind Trading", domain: "northwind-detail.test" })).body.company.id;
  await sql("update crm.companies set phone = '+44 20 7946 0101' where id = $1", [northwind]);
  jane = (
    await createContact(mark, { companyId: northwind, firstName: "Jane", lastName: "Cooper", email: "jane@northwind-detail.test", phone: "07700 900412", jobTitle: "Head of Operations" })
  ).body.contact.id;
  await sql("update crm.contacts set source = 'Referral' where id = $1", [jane]);
  await sql("update crm.companies set source = 'Website' where id = $1", [northwind]);
  const stage = (await listPipeline(mark)).stages[0];
  stageName = stage.name;
  renewal = (await createOpportunity(mark, { companyId: northwind, name: "Northwind renewal 2027", stageId: stage.id, value: 48000, currency: "GBP", primaryContactId: jane })).body.opportunity.id;
  await createActivity(mark, { type: "call", title: "Call with Jane", contactId: jane, occurredAt: "2026-11-04T10:00:00Z" });
  markBox = await mailbox(mark);
  const samBox = await mailbox(sam);
  await message(mark, markBox, { thread: "renewal", from: "jane@northwind-detail.test", to: ["mark@detail.test"], subject: "Renewal terms", at: "2026-11-05T09:00:00Z" });
  threadEmail = await message(mark, markBox, { thread: "renewal", from: "mark@detail.test", to: ["jane@northwind-detail.test"], subject: "Re: Renewal terms", at: "2026-11-06T09:00:00Z", sent: true });
  await message(sam, samBox, { thread: "secret", from: "jane@northwind-detail.test", to: ["sam@detail.test"], subject: "Sam's private pricing", at: "2026-11-10T09:00:00Z" });
  const description = withMailThread("Ask about the three-year price.", mailThreadLine(markBox.sourceId, "renewal", "Renewal terms"));
  callJane = (
    await createTask(mark, { title: "Call Jane about the renewal", description, dueDate: "2026-11-20", ownerId: sam.userId, contactId: jane, opportunityId: renewal })
  ).body.task.id;
  await addTaskParticipants(mark, callJane, [priya.userId]);
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

function assertCrmFields(detail: TaskDetail) {
  assert.equal(detail.task.id, callJane);
  assert.equal(detail.task.title, "Call Jane about the renewal");
  assert.equal(detail.task.dueDate, "2026-11-20");
  assert.equal(detail.task.ownerId, sam.userId);
  assert.equal(detail.task.ownerName, "Sam Okafor");
  assert.equal(detail.task.description, "Ask about the three-year price.");
  assert.deepEqual(detail.contact, { id: jane, name: "Jane Cooper", jobTitle: "Head of Operations", phone: "07700 900412", email: "jane@northwind-detail.test", source: "Referral" });
  assert.deepEqual(detail.company, { id: northwind, name: "Northwind Trading", phone: "+44 20 7946 0101", source: "Website" });
  assert.deepEqual(detail.opportunity, { id: renewal, name: "Northwind renewal 2027", stage: stageName, status: "open", value: "48000.00", currency: "GBP", linked: true });
  assert.deepEqual(detail.people, []);
  assert.equal(detail.lastActivity?.type, "call");
  assert.equal(detail.lastActivity?.title, "Call with Jane");
  assert.doesNotMatch(JSON.stringify(detail), /\/mail\?thread=/);
}

describe("the full detail of one task", () => {
  it("gives the viewer every field, their own last email and the thread the task came from", async () => {
    const detail = await taskDetail(mark, callJane);
    assertCrmFields(detail);
    assert.deepEqual(detail.workspace, { id: mark.workspaceId, name: mark.workspaceName, current: true });
    assert.equal(detail.readOnly, false);
    assert.equal(detail.canChange, true);
    assert.equal(detail.assignedToViewer, false);
    assert.deepEqual(detail.mail?.lastEmail, { subject: "Re: Renewal terms", at: "2026-11-06T09:00:00.000Z" });
    assert.deepEqual(detail.mail?.thread, { emailId: threadEmail, subject: "Re: Renewal terms", messages: 2, latest: "2026-11-06T09:00:00.000Z", fromNames: ["jane@northwind-detail.test", "mark@detail.test"].sort() });
  });

  it("offers the company's people and their open opportunity when only the company is linked", async () => {
    const id = (await createTask(mark, { title: "Ring the Northwind switchboard", companyId: northwind, contactId: null, opportunityId: null })).body.task.id;
    const detail = await taskDetail(mark, id);
    assert.equal(detail.contact, null);
    assert.equal(detail.opportunity?.id, renewal);
    assert.equal(detail.opportunity?.linked, false);
    assert.deepEqual(detail.people.map((person) => person.id), [jane]);
    assert.equal(detail.mail?.lastEmail, null);
  });

  it("shows a teammate and a tagged person the task, but never the creator's mail", async () => {
    const theirs = await taskDetail(sam, callJane);
    assertCrmFields(theirs);
    assert.equal(theirs.assignedToViewer, true);
    assert.equal(theirs.canChange, true);
    assert.equal(theirs.mail?.thread, null);
    assert.equal(theirs.mail?.lastEmail?.subject, "Sam's private pricing");
    assert.doesNotMatch(JSON.stringify(theirs), /Renewal terms/);
    assert.ok(!JSON.stringify(theirs).includes(threadEmail));

    const tagged = await taskDetail(priya, callJane);
    assertCrmFields(tagged);
    assert.equal(tagged.canChange, false);
    assert.deepEqual(tagged.mail, { lastEmail: null, thread: null });
    assert.doesNotMatch(JSON.stringify(tagged), /Renewal terms|private pricing/);
  });

  it("gives an agent token every CRM field and no mail, without an error", async () => {
    const detail = await taskDetail(agent, callJane);
    assertCrmFields(detail);
    assert.equal(detail.mail, null);
    assert.equal(detail.canChange, true);
    assert.equal(detail.assignedToViewer, false);
    assert.deepEqual(detail.workspace, { id: mark.workspaceId, name: null, current: true });
    await rejects(taskDetail({ ...agent, scopes: ["tasks:write"] }, callJane), "forbidden");
  });

  it("reads a task in another of the user's workspaces as read only, and fails closed for everyone else", async () => {
    const elsewhere = (await createTask(second, { title: "Second brand renewal call", ownerId: mark.userId, companyId: null, contactId: null, opportunityId: null })).body.task.id;
    const detail = await taskDetail(mark, elsewhere, { anyWorkspace: true });
    assert.equal(detail.readOnly, true);
    assert.equal(detail.canChange, false);
    assert.deepEqual(detail.workspace, { id: second.workspaceId, name: "Second brand", current: false });
    await rejects(taskDetail(mark, elsewhere), "not_found");
    await rejects(taskDetail(sam, elsewhere, { anyWorkspace: true }), "not_found");
    await rejects(taskDetail(outsider, callJane, { anyWorkspace: true }), "not_found");
    await rejects(taskDetail(agent, elsewhere), "not_found");
    assert.equal(await taskDetailOrNull(outsider, elsewhere), null);
    assert.equal(await taskDetailOrNull(mark, "not-a-task"), null);
    const hidden = (await createTask(mark, { title: "Mark's own follow-up", ownerId: mark.userId, contactId: jane })).body.task.id;
    assert.equal(await taskDetailOrNull(sam, hidden), null);
  });
});

describe("list_tasks with a task id", () => {
  it("returns that one task with its full detail, read as the user", async () => {
    const result = (await runTool(mark, "list_tasks", { taskId: callJane, view: "overdue" })) as TaskDetail & { task: { contactHref: string | null } };
    assert.equal(result.task.id, callJane);
    assert.ok(result.task.contactHref?.includes(jane));
    assert.equal(result.contact?.jobTitle, "Head of Operations");
    assert.equal(result.opportunity?.stage, stageName);
    assert.equal(result.mail?.lastEmail?.subject, "Re: Renewal terms");
    assert.equal(result.mail?.thread?.emailId, threadEmail);
    const tagged = (await runTool(priya, "list_tasks", { taskId: callJane })) as TaskDetail;
    assert.deepEqual(tagged.mail, { lastEmail: null, thread: null });
    const elsewhere = (await createTask(second, { title: "Another brand call", ownerId: mark.userId, companyId: null, contactId: null, opportunityId: null })).body.task.id;
    assert.equal(((await runTool(mark, "list_tasks", { taskId: elsewhere })) as TaskDetail).readOnly, true);
    assert.deepEqual(await runTool(outsider, "list_tasks", { taskId: callJane }), { error: "Task not found.", field: null });
  });
});

describe("list_tasks with a task id and a workspace", () => {
  it("returns the one task without fanning out, with its flags worked out for the chat's own workspace", async () => {
    for (const workspace of ["all", "Second brand", mark.workspaceName]) {
      const result = (await runTool(mark, "list_tasks", { taskId: callJane, workspace }, { multiWorkspace: true })) as TaskDetail & { workspaces?: unknown; note?: unknown };
      assert.equal(result.workspaces, undefined, workspace);
      assert.equal(result.note, undefined, workspace);
      assert.equal(result.task.id, callJane, workspace);
      assert.equal(result.readOnly, false, workspace);
      assert.equal(result.canChange, true, workspace);
      assert.deepEqual(result.workspace, { id: mark.workspaceId, name: mark.workspaceName, current: true }, workspace);
    }
    const elsewhere = (await createTask(second, { title: "Fan-out check", ownerId: mark.userId, companyId: null, contactId: null, opportunityId: null })).body.task.id;
    const away = (await runTool(mark, "list_tasks", { taskId: elsewhere, workspace: "all" }, { multiWorkspace: true })) as TaskDetail;
    assert.equal(away.task.id, elsewhere);
    assert.equal(away.readOnly, true);
    assert.equal(away.canChange, false);
    assert.equal(away.workspace.name, "Second brand");
    const listed = (await runTool(mark, "list_tasks", { workspace: "all" }, { multiWorkspace: true })) as { workspaces?: unknown[] };
    assert.ok(Array.isArray(listed.workspaces));
  });
});

describe("what a task block tells the model", () => {
  it("says when the user can't change the task, and offers something else", async () => {
    const tagged = await pageContext(priya, null, { taggedTaskIds: [callJane] });
    assert.match(tagged, /\nThe user can't change that task: only its assignee, its creator, an owner or an admin can\. Don't propose update_task on it; offer what they can do instead, such as logging the activity or a new task\.\n/);
    assert.doesNotMatch(await pageContext(sam, null, { taggedTaskIds: [callJane] }), /can't change that task/);
    const gone = (await createTask(mark, { title: "Archived follow-up", ownerId: mark.userId, contactId: jane })).body.task.id;
    await archiveTask(mark, gone);
    assert.match(await pageContext(mark, null, { taggedTaskIds: [gone] }), /task "Archived follow-up" \[task id [^\]]+\], archived, [^\n]*\nThe user can't change that task \(it is archived\)\./);
  });

  it("marks a lead-form person and the last activity as outside content, in the block and in list_tasks", async () => {
    const lead = (await createContact(mark, { firstName: "Lena", lastName: "Leadform", email: "lena@leads-detail.test" })).body.contact.id;
    await sql("update crm.contacts set source = 'Meta Lead Ad' where id = $1", [lead]);
    const leadTask = (await createTask(mark, { title: "Call Lena back", ownerId: mark.userId, contactId: lead })).body.task.id;
    const block = await pageContext(mark, null, { taggedTaskIds: [leadTask] });
    assert.match(block, /\nFrom a lead form: the person or company on that task was added from a Meta lead ad/);
    assert.doesNotMatch(block, /Last activity with them/);
    assert.equal(webGateState([{ role: "user", content: "Hi", page_context: block }]).outside, true);
    const fromLead = await runTool(mark, "list_tasks", { taskId: leadTask });
    assert.equal((fromLead as TaskDetail).contact?.source, "Meta Lead Ad");
    assert.equal(outsideRead("list_tasks", JSON.stringify(fromLead)), true);

    const plain = (await createTask(mark, { title: "Tidy the notes", ownerId: mark.userId, companyId: null, contactId: null, opportunityId: null })).body.task.id;
    const quiet = await pageContext(mark, null, { taggedTaskIds: [plain] });
    assert.equal(webGateState([{ role: "user", content: "Hi", page_context: quiet }]).outside, false);
    assert.equal(outsideRead("list_tasks", JSON.stringify(await runTool(mark, "list_tasks", { taskId: plain }))), false);

    const active = await pageContext(sam, null, { taggedTaskIds: [callJane] });
    assert.match(active, /\nLast activity with them: call "Call with Jane"/);
    assert.equal(webGateState([{ role: "user", content: "Hi", page_context: active }]).outside, true);
    assert.equal(outsideRead("list_tasks", JSON.stringify(await runTool(priya, "list_tasks", { taskId: callJane }))), true);
  });
});

describe("MCP get_next_action", () => {
  it("is registered for agent and personal tokens with crm:read, and gives agents no mail", async () => {
    const asAgent = await mcpCall(agent, "get_next_action", { id: callJane });
    assert.ok(asAgent.names.includes("get_next_action"));
    assert.equal(asAgent.error, false);
    const body = JSON.parse(asAgent.text) as TaskDetail;
    assertCrmFields(body);
    assert.equal(body.mail, null);

    const noRead = await mcpCall({ ...agent, scopes: ["tasks:write"] }, "get_next_action", { id: callJane });
    assert.equal(noRead.error, true);
    assert.match(noRead.text, /^forbidden: Missing scope crm:read\./);

    const missing = await mcpCall(agent, "get_next_action", { id: crypto.randomUUID() });
    assert.equal(missing.error, true);
    assert.match(missing.text, /^not_found:/);
  });

  it("gives a personal token its own mail parts", async () => {
    const own = JSON.parse((await mcpCall(mark, "get_next_action", { id: callJane })).text) as TaskDetail;
    assert.equal(own.mail?.lastEmail?.subject, "Re: Renewal terms");
    assert.equal(own.mail?.thread?.emailId, threadEmail);
    const theirs = JSON.parse((await mcpCall(sam, "get_next_action", { id: callJane })).text) as TaskDetail;
    assert.equal(theirs.mail?.thread, null);
    assert.doesNotMatch(JSON.stringify(theirs), /Renewal terms/);
  });
});

describe("GET /api/v1/tasks/:id", () => {
  it("returns the task and its full detail, with no mail for an agent token", async () => {
    const response = await restGetTask(new Request(`http://crm.test/api/v1/tasks/${callJane}`, { headers: { authorization: `Bearer ${agentToken}` } }), {
      params: Promise.resolve({ id: callJane }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { task: { description: string }; detail: TaskDetail };
    assert.match(body.task.description, /\/mail\?thread=/);
    assertCrmFields(body.detail);
    assert.equal(body.detail.mail, null);
  });

  it("still returns the task when its detail can't be read", async () => {
    const task = await getTask(agent, callJane);
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(await detailOfTask(agent, { ...task, contactId: "not-a-uuid" }), null);
    } finally {
      console.error = original;
    }
    assertCrmFields((await detailOfTask(agent, task))!);
  });
});
