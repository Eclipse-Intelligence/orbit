import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { POST as restCreateTask } from "@/app/api/v1/tasks/route";
import { describeAction, runTool } from "@/lib/assistant/tools";
import { acceptActionItem, summariseCall } from "@/lib/crm/call-insights";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { fileInboundMessages, saveMailbox } from "@/lib/crm/inbox";
import { createOpportunity } from "@/lib/crm/opportunities";
import { getDueActions } from "@/lib/crm/relationships";
import { scopesForRole } from "@/lib/crm/scopes";
import { detectTaskRecordsInDb } from "@/lib/crm/task-detect";
import { detectPadRecords } from "@/lib/crm/task-pad";
import { backfillTaskLinks, linkTask, taskLinkCandidates } from "@/lib/crm/task-links";
import { taskTitleSegments } from "@/lib/crm/task-title";
import { addTaskParticipants, createTask, getTask, listTasks, updateTask } from "@/lib/crm/tasks";
import type { Actor, Task, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createWorkflow, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let sam: UserActor;
let acme: string;
let halden: string;
let jane: string;
let raj: string;
let renewal: string;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

function links(task: Pick<Task, "companyId" | "contactId" | "opportunityId">) {
  return { companyId: task.companyId, contactId: task.contactId, opportunityId: task.opportunityId };
}

async function detected(taskId: string) {
  const rows = await sql<{ changes: { detectedLinks?: string[] } }>(
    "select changes from crm.audit_events where entity_id = $1 and event_type = 'task.created'",
    [taskId],
  );
  return (rows[0]?.changes.detectedLinks ?? []).slice().sort();
}

async function mcp(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "task-links", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]?.text ?? "";
      if (result.isError) throw new Error(text);
      return JSON.parse(text) as Record<string, unknown>;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@links.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@links.test", "Sam Okafor"), "member");
  acme = (await createCompany(mark, { name: "Acme Widgets", domain: "acme-links.test" })).body.company.id;
  halden = (await createCompany(mark, { name: "Halden Group", domain: "halden-links.test" })).body.company.id;
  jane = (await createContact(mark, { companyId: acme, firstName: "Jane", lastName: "Doe", email: "jane@acme-links.test" })).body.contact.id;
  raj = (await createContact(mark, { companyId: halden, firstName: "Raj", lastName: "Mehta", email: "raj@halden-links.test" })).body.contact.id;
  await createContact(mark, { firstName: "John", lastName: "Smith", email: "john1@links.test" });
  await createContact(mark, { firstName: "John", lastName: "Smith", email: "john2@links.test" });
  await createContact(mark, { firstName: "Oliver", lastName: "Grant", email: "oliver@halden-links.test", companyId: halden });
  await createContact(mark, { firstName: "Oliver", lastName: "Shah", email: "oliver@shah-links.test" });
  await createContact(mark, { firstName: "Sam", lastName: "Okafor", email: "sam.okafor@outside-links.test" });
  renewal = (await createOpportunity(mark, { companyId: halden, name: "Halden rollout 2027" })).body.opportunity.id;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("linking tasks on creation", () => {
  it("links a unique full name, fills the contact's company and records what was detected", async () => {
    const task = (await createTask(mark, { title: "Call Jane Doe about pricing" })).body.task;
    assert.deepEqual(links(task), { companyId: acme, contactId: jane, opportunityId: null });
    assert.deepEqual(await detected(task.id), ["companyId", "contactId"]);

    const company = (await createTask(mark, { title: "Send Halden Group the dates" })).body.task;
    assert.deepEqual(links(company), { companyId: halden, contactId: null, opportunityId: null });
    const lower = (await createTask(mark, { title: "Send halden group the dates" })).body.task;
    assert.deepEqual(links(lower), { companyId: null, contactId: null, opportunityId: null });

    const deal = (await createTask(mark, { title: "Price the Halden rollout 2027 tiers" })).body.task;
    assert.deepEqual(links(deal), { companyId: halden, contactId: null, opportunityId: renewal });
    assert.deepEqual(await detected(deal.id), ["companyId", "opportunityId"]);
  });

  it("never links a first name, a surname or a name two contacts share", async () => {
    for (const title of ["Call Jane about pricing", "Ask Doe for the form", "Call John Smith back", "Follow up with Oliver", "Call Jane Doe and Raj Mehta"]) {
      const task = (await createTask(mark, { title })).body.task;
      assert.deepEqual(links(task), { companyId: null, contactId: null, opportunityId: null }, title);
      assert.deepEqual(await detected(task.id), [], title);
    }
  });

  it("never links a common word: names need their capitals, and a one-word opportunity never links alone", async () => {
    const zoom = (await createCompany(mark, { name: "Zoom", domain: "zoom-links.test" })).body.company.id;
    await createOpportunity(mark, { companyId: zoom, name: "Proposal" });
    for (const title of ["Set up a zoom with the team", "Send proposal to the board", "Send the Proposal"]) {
      const task = (await createTask(mark, { title })).body.task;
      assert.deepEqual(links(task), { companyId: null, contactId: null, opportunityId: null }, title);
    }
    const named = (await createTask(mark, { title: "Renew the Zoom licence" })).body.task;
    assert.deepEqual(links(named), { companyId: null, contactId: null, opportunityId: null });
    assert.deepEqual((await taskLinkCandidates(mark, named.id)).candidates.map((candidate) => [candidate.kind, candidate.name]), [["company", "Zoom"]]);
    const typed = await detectPadRecords(mark, "Renew the Zoom licence");
    assert.equal(typed.company?.id, zoom);
    const assistant = (await runTool(mark, "create_task", { title: "Book the Zoom renewal call", sendToClickUp: false })) as { task: Task };
    assert.equal(assistant.task.companyId, null);
    const confirmed = (await createTask(mark, { title: "Renew the Zoom licence", companyId: typed.company!.id })).body.task;
    assert.equal(confirmed.companyId, zoom);
  });

  it("prefers the longest name across kinds and never lets a contact's company replace a company named in full", async () => {
    const consulting = (await createCompany(mark, { name: "Jane Doe Consulting", domain: "janedoe-links.test" })).body.company.id;
    const invoice = (await createTask(mark, { title: "Invoice Jane Doe Consulting for March" })).body.task;
    assert.deepEqual(links(invoice), { companyId: consulting, contactId: null, opportunityId: null });
    const both = (await createTask(mark, { title: "Ask Raj Mehta about Acme Widgets" })).body.task;
    assert.deepEqual(links(both), { companyId: acme, contactId: null, opportunityId: null });
  });

  it("applies the longest name before uniqueness, and never matches part of a hyphenated name", async () => {
    const north = (await createCompany(mark, { name: "Northgate", domain: "northgate-links.test" })).body.company.id;
    const south = (await createCompany(mark, { name: "Southgate", domain: "southgate-links.test" })).body.company.id;
    await createOpportunity(mark, { companyId: north, name: "Jane Doe renewal" });
    await createOpportunity(mark, { companyId: south, name: "Jane Doe renewal" });
    const shared = (await createTask(mark, { title: "Price the Jane Doe renewal" })).body.task;
    assert.deepEqual(links(shared), { companyId: null, contactId: null, opportunityId: null });
    await createContact(mark, { firstName: "Anna", lastName: "Smith", email: "anna@links.test" });
    const hyphen = (await createTask(mark, { title: "Call Anna Smith-Jones" })).body.task;
    assert.deepEqual(links(hyphen), { companyId: null, contactId: null, opportunityId: null });
  });

  it("never fails to create a task because of what it detected", async () => {
    const old = (await createCompany(mark, { name: "Oldfield Mills", domain: "oldfield-links.test" })).body.company.id;
    const nora = (await createContact(mark, { companyId: old, firstName: "Nora", lastName: "Vance", email: "nora@oldfield-links.test" })).body.contact.id;
    await sql("update crm.companies set archived_at = now() where id = $1", [old]);
    const task = (await createTask(mark, { title: "Call Nora Vance about Halden Group" })).body.task;
    assert.deepEqual(links(task), { companyId: halden, contactId: null, opportunityId: null });
    const alone = (await createTask(mark, { title: "Call Nora Vance" })).body.task;
    assert.equal(alone.contactId, nora);
    const { actor } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"]);
    const agentTask = (await createTask(actor, { title: "Call Nora Vance at Halden Group" })).body.task;
    assert.equal(agentTask.title, "Call Nora Vance at Halden Group");
  });

  it("keeps supplied ids and deliberate nulls", async () => {
    const supplied = (await createTask(mark, { title: "Call Jane Doe", companyId: halden })).body.task;
    assert.deepEqual(links(supplied), { companyId: halden, contactId: null, opportunityId: null });
    assert.deepEqual(await detected(supplied.id), []);
    const none = (await createTask(mark, { title: "Call Jane Doe", contactId: null })).body.task;
    assert.deepEqual(links(none), { companyId: null, contactId: null, opportunityId: null });
    const contact = (await createTask(mark, { title: "Call Jane Doe", contactId: raj })).body.task;
    assert.deepEqual(links(contact), { companyId: halden, contactId: raj, opportunityId: null });
  });

  it("skips a contact who shares a teammate's name, and never changes the assignee", async () => {
    const task = (await createTask(mark, { title: "Ask Sam Okafor to price Jane Doe's order" })).body.task;
    assert.equal(task.contactId, jane);
    assert.equal(task.ownerId, mark.userId);
    const only = (await createTask(mark, { title: "Ask Sam Okafor for the deck" })).body.task;
    assert.deepEqual(links(only), { companyId: null, contactId: null, opportunityId: null });
  });

  it("detects for an agent through the REST API and MCP", async () => {
    const { actor, token } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"]);
    await withActor(actor, async (db) => {
      const found = await detectTaskRecordsInDb(db, mark.workspaceId, "Book a demo with Raj Mehta");
      assert.equal(found.contact?.id, raj);
      assert.equal(found.company?.id, halden);
    });
    const response = await restCreateTask(
      new Request("http://crm.test/api/v1/tasks", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Book a demo with Raj Mehta" }),
      }),
    );
    assert.equal(response.status, 201);
    const rest = ((await response.json()) as { task: Task }).task;
    assert.deepEqual(links(rest), { companyId: halden, contactId: raj, opportunityId: null });

    const client = await mcp(actor);
    try {
      const created = (await client.call("create_next_action", { title: "Send Jane Doe the order form" })) as { task: Task };
      assert.deepEqual(links(created.task), { companyId: acme, contactId: jane, opportunityId: null });
      const unlinked = (await client.call("create_next_action", { title: "Send Jane Doe the order form again", contactId: null })) as { task: Task };
      assert.deepEqual(links(unlinked.task), { companyId: null, contactId: null, opportunityId: null });
    } finally {
      await client.close();
    }
  });

  it("detects for the assistant and the quick add pad, and takes an opportunity from the assistant", async () => {
    const assistant = (await runTool(mark, "create_task", { title: "Email Raj Mehta the case study", sendToClickUp: false })) as { task: Task };
    assert.deepEqual(links(assistant.task), { companyId: halden, contactId: raj, opportunityId: null });
    const deal = (await runTool(mark, "create_task", { title: "Prepare the order form", opportunityId: renewal, sendToClickUp: false })) as { task: Task };
    assert.deepEqual(links(deal.task), { companyId: halden, contactId: null, opportunityId: renewal });
    const contact = (await runTool(mark, "create_task", { title: "Call Jane Doe", contactId: raj, sendToClickUp: false })) as { task: Task };
    assert.deepEqual(links(contact.task), { companyId: halden, contactId: raj, opportunityId: null });
  });

  it("relinks through the assistant's update_task: an id replaces, null takes off and a link left out stays", async () => {
    const made = (await runTool(mark, "create_task", { title: "Send the order form", contactId: jane, sendToClickUp: false })) as { task: Task };
    const id = made.task.id;
    assert.deepEqual(links(made.task), { companyId: acme, contactId: jane, opportunityId: null });
    const update = async (args: Record<string, unknown>) => ((await runTool(mark, "update_task", { taskId: id, ...args })) as { task: Task }).task;
    assert.deepEqual(links(await update({ contactId: raj, companyId: halden })), { companyId: halden, contactId: raj, opportunityId: null });
    assert.deepEqual(links(await update({ opportunityId: renewal })), { companyId: halden, contactId: raj, opportunityId: renewal });
    assert.deepEqual(links(await update({ title: "Send Raj the order form" })), { companyId: halden, contactId: raj, opportunityId: renewal });
    assert.deepEqual(links(await update({ contactId: null })), { companyId: halden, contactId: null, opportunityId: renewal });
    assert.deepEqual(links(await update({ opportunityId: null, contactId: "" })), { companyId: halden, contactId: null, opportunityId: null });
    assert.match(String(((await runTool(mark, "update_task", { taskId: id, contactId: jane })) as { error?: string }).error), /That contact belongs to a different company\./);
    assert.deepEqual(links(await update({ contactId: jane, companyId: acme, completed: true })), { companyId: acme, contactId: jane, opportunityId: null });
    assert.ok((await getTask(mark, id)).completedAt);
    const events = await sql<{ changes: Record<string, unknown>; operation: string }>(
      "select changes, operation from crm.audit_events where entity_id = $1 and event_type = 'task.updated' order by created_at",
      [id],
    );
    assert.ok(events.some((event) => event.operation === "update_task" && JSON.stringify(event.changes).includes(raj)));

    const card = describeAction("update_task", { taskId: id, contactId: raj, companyId: halden, opportunityId: null }, new Map([[id, "Send Raj the order form"], [raj, "Raj Mehta"], [halden, "Halden Group"]]));
    assert.deepEqual(card.lines, ["Person: Raj Mehta", "Company: Halden Group", "Opportunity: none"]);
    assert.deepEqual(describeAction("update_task", { taskId: id, title: "Send it" }, new Map()).lines, ["Title: Send it"]);
  });

  it("refuses a relink through the assistant from someone only tagged or who can't see the task", async () => {
    const lee = await join(await createUser("lee@links.test", "Lee Tagged"), "member");
    const olly = await join(await createUser("olly@links.test", "Olly Outside"), "member");
    const task = (await createTask(mark, { title: "Book the Halden review", contactId: raj, ownerId: sam.userId })).body.task;
    assert.deepEqual(await addTaskParticipants(sam, task.id, [lee.userId]), [lee.userId]);
    assert.equal((await getTask(lee, task.id)).id, task.id);
    const relink = async (actor: UserActor) => String(((await runTool(actor, "update_task", { taskId: task.id, contactId: jane, companyId: acme })) as { error?: string }).error);
    assert.match(await relink(lee), /Only the assignee/);
    assert.match(await relink(olly), /not found|Couldn't find/i);
    assert.deepEqual(links(await getTask(mark, task.id)), { companyId: halden, contactId: raj, opportunityId: null });
    assert.match(String(((await runTool(mark, "update_task", { taskId: task.id, contactId: 42 })) as { error?: string }).error), /contactId takes a record id, or null/);
    assert.match(String(((await runTool(mark, "update_task", { taskId: task.id, opportunityId: { id: renewal } })) as { error?: string }).error), /opportunityId takes a record id/);
    assert.deepEqual(links(await getTask(mark, task.id)), { companyId: halden, contactId: raj, opportunityId: null });
  });

  it("refuses moving a task with an opportunity to another company unless the opportunity moves too", async () => {
    const task = (await createTask(mark, { title: "Send the rollout plan", contactId: raj, opportunityId: renewal })).body.task;
    const moved = (await runTool(mark, "update_task", { taskId: task.id, contactId: jane, companyId: acme })) as { error?: string };
    assert.match(String(moved.error), /That opportunity belongs to a different company\./);
    const cleared = ((await runTool(mark, "update_task", { taskId: task.id, contactId: jane, companyId: acme, opportunityId: null })) as { task: Task }).task;
    assert.deepEqual(links(cleared), { companyId: acme, contactId: jane, opportunityId: null });
  });

  it("keeps the time blocking rules when the assistant relinks a teammate's timed task", async () => {
    const theirs = (await createTask(mark, { title: "Walk Sam through the rollout", dueAt: "2027-01-12T14:30", ownerId: sam.userId, companyId: null, contactId: null, opportunityId: null })).body.task;
    assert.equal(theirs.dueHasTime, false);
    const own = (await createTask(sam, { title: "Plan the Halden rollout", dueAt: "2027-01-12T14:30", ownerId: sam.userId, companyId: null, contactId: null, opportunityId: null })).body.task;
    assert.equal(own.dueHasTime, true);
    const relinked = ((await runTool(mark, "update_task", { taskId: own.id, contactId: raj, dueAt: "2027-01-13T09:00" })) as { task: Task }).task;
    assert.deepEqual(links(relinked), { companyId: halden, contactId: raj, opportunityId: null });
    assert.equal(relinked.dueHasTime, false);
    assert.equal(relinked.dueDate, "2027-01-13");
    const timed = (await updateTask(sam, own.id, { dueAt: "2027-01-13T09:00" })).body.task;
    assert.equal(timed.dueHasTime, true);
    assert.match(String(((await runTool(mark, "update_task", { taskId: own.id, durationMinutes: 45, opportunityId: renewal })) as { error?: string }).error), /Only the owner can change the length of a timed task\./);
    assert.equal((await getTask(sam, own.id)).opportunityId, null);
  });

  it("links workflow tasks unless the step says none, and defaults to the run's contact", async () => {
    const run = async (link: string | undefined, record: { type: "contact"; id: string } | null, title: string) => {
      const workflow = await createWorkflow(mark, { name: `Task ${title}` });
      const definition = {
        version: 2,
        trigger: { type: "manual", object: "contact" },
        triggerPosition: { x: 0, y: 0 },
        nodes: [{ id: "create_task_1", type: "create_task", config: { title, dueInDays: "", assignee: "owner", ...(link ? { link } : {}) }, position: { x: 300, y: 0 } }],
        edges: [{ source: "trigger", handle: "out", target: "create_task_1" }],
      } as WorkflowDefinition;
      await saveWorkflow(mark, workflow.id, { definition });
      await setWorkflowStatus(mark, workflow.id, "active");
      const result = await startRun(mark, workflow.id, { test: false, record });
      assert.equal(result.status, "succeeded", title);
      return (await listTasks(mark, { query: title })).data[0];
    };
    assert.deepEqual(links(await run("contact", { type: "contact", id: raj }, "Workflow call one")), { companyId: halden, contactId: raj, opportunityId: null });
    assert.deepEqual(links(await run("none", { type: "contact", id: raj }, "Workflow Jane Doe none")), { companyId: null, contactId: null, opportunityId: null });
    const solo = (await createContact(mark, { firstName: "Nia", lastName: "Solo", email: "nia@solo-links.test" })).body.contact.id;
    assert.deepEqual(links(await run("company", { type: "contact", id: solo }, "Workflow ring Jane Doe")), { companyId: null, contactId: null, opportunityId: null });
    assert.deepEqual(links(await run(undefined, { type: "contact", id: solo }, "Workflow older Jane Doe")), { companyId: null, contactId: null, opportunityId: null });
  });

  it("links a call action item to the person it names, not the person on the call", async () => {
    const previous = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "test-llm-key";
    try {
      const call = (await createActivity(mark, { type: "call", title: "Call with Jane Doe", contactId: jane, companyId: acme, occurredAt: "2026-10-15T13:00:00.000Z" })).body.activity;
      const reply = {
        summary: "Jane wants Raj looped in.",
        keyPoints: ["Raj owns procurement"],
        actionItems: [
          { title: "Call Raj Mehta about procurement", owner: "me", dueDate: null },
          { title: "Send Jane the quote", owner: "me", dueDate: null },
        ],
      };
      const fetchImpl: typeof fetch = async () =>
        Response.json({ model: "claude-haiku-5-5", choices: [{ message: { role: "assistant", content: JSON.stringify(reply) }, finish_reason: "stop" }] });
      const insight = await summariseCall(mark, call.id, "Me: hello\nJane Doe: hi", { source: "manual", fetchImpl, autoAccept: false });
      const named = await acceptActionItem(mark, insight.id, insight.actionItems[0].id);
      assert.deepEqual(links(named.task!), { companyId: halden, contactId: raj, opportunityId: null });
      assert.deepEqual(await detected(named.task!.id), ["companyId", "contactId"]);
      const onCall = await acceptActionItem(mark, insight.id, insight.actionItems[1].id);
      assert.deepEqual(links(onCall.task!), { companyId: acme, contactId: jane, opportunityId: null });
    } finally {
      if (previous === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previous;
    }
  });
});

describe("mail follow-ups carry their thread", () => {
  it("adds the thread link to follow-ups from the inbox and the Mail mirror", async () => {
    const owner = await createUser("follow@links.test", "Fran Follow");
    const company = (await createCompany(owner, { name: "Northwind", domain: "northwind-links.test" })).body.company.id;
    await createContact(owner, { companyId: company, firstName: "Ada", lastName: "Lovell", email: "ada@northwind-links.test" });
    await saveMailbox(owner, { email: "fran@orbit-links.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const sourceId = (
      await sql<{ id: string }>(
        `insert into crm.mail_sources (workspace_id, user_id, email, connection_id)
         select $1, $2, 'fran@orbit-links.test', id from crm.mailbox_connections where user_id = $2 returning id`,
        [owner.workspaceId, owner.userId],
      )
    )[0].id;
    const filed = await fileInboundMessages(owner, [
      { providerMessageId: "links-1", conversationId: "conv-links", subject: "Pilot [draft]", fromEmail: "ada@northwind-links.test", fromName: "Ada Lovell", receivedAt: new Date().toISOString() },
    ]);
    assert.equal(filed.followUps, 1);
    const task = (await listTasks(owner, { companyId: company })).data[0];
    assert.equal(task.title, "Reply to Ada Lovell: Pilot draft");
    assert.ok(task.description?.endsWith(`[Pilot draft](/mail?thread=${encodeURIComponent(`${sourceId}|conv-links`)})`), task.description ?? "");

    const other = (await createCompany(owner, { name: "Fernhill", domain: "fernhill-links.test" })).body.company.id;
    await createContact(owner, { companyId: other, firstName: "Emma", lastName: "Lowe", email: "emma@fernhill-links.test" });
    const folder = (
      await sql<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'inbox', 'inbox', 'inbox') returning id",
        [owner.workspaceId, owner.userId, sourceId],
      )
    )[0].id;
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await sql(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
         from_email, to_recipients, cc_recipients, sent_at, received_at)
       values ($1, $2, $3, $4, 'mirror-1', '<mirror-1@links.test>', 'thread-emma', 'Intro to the CFO', 'Hello', 'emma@fernhill-links.test',
         '[{"name":"","address":"fran@orbit-links.test"}]'::jsonb, '[]'::jsonb, $5, $5)`,
      [owner.workspaceId, owner.userId, sourceId, folder, at],
    );
    await fileMailOnTimeline(owner, {});
    const mirrored = (await listTasks(owner, { companyId: other })).data[0];
    assert.ok(mirrored, "a follow-up task");
    assert.equal(mirrored.title, "Reply to Emma Lowe: Intro to the CFO");
    assert.ok(mirrored.description?.endsWith(`[Intro to the CFO](/mail?thread=${encodeURIComponent(`${sourceId}|thread-emma`)})`), mirrored.description ?? "");
  });
});

describe("Link a person and the backfill", () => {
  it("offers first names, surnames and shared names on demand, and links one with its company", async () => {
    const task = (await createTask(mark, { title: "Follow up with Oliver about the order form" })).body.task;
    const { candidates, reason } = await taskLinkCandidates(mark, task.id);
    assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), ["Oliver Grant", "Oliver Shah"]);
    assert.equal(reason, "Oliver matches 2 contacts, so nothing was linked.");
    await sql(
      `insert into crm.contacts (workspace_id, first_name, last_name, owner_id, created_by_user_id)
       select $1, 'Quinn', 'Many' || n, $2, $2 from generate_series(1, 45) n`,
      [mark.workspaceId, mark.userId],
    );
    const many = (await createTask(mark, { title: "Ask Quinn about the brief" })).body.task;
    assert.equal((await taskLinkCandidates(mark, many.id)).reason, "Quinn matches 45 contacts, so nothing was linked.");
    assert.equal(candidates.find((candidate) => candidate.name === "Oliver Grant")?.detail, "Halden Group");
    const teammate = (await createTask(mark, { title: "Ask Sam about the deck" })).body.task;
    assert.deepEqual((await taskLinkCandidates(mark, teammate.id)).candidates, []);
    await createContact(mark, { firstName: "Sam", lastName: "Reid", email: "sam.reid@links.test" });
    assert.deepEqual((await taskLinkCandidates(mark, teammate.id)).candidates.map((candidate) => candidate.name), ["Sam Reid"]);
    assert.equal((await taskLinkCandidates(mark, teammate.id)).reason, null);
    const possessive = (await createTask(mark, { title: "check raj's numbers", contactId: null })).body.task;
    assert.deepEqual((await taskLinkCandidates(mark, possessive.id)).candidates.map((candidate) => candidate.name), ["Raj Mehta"]);
    const grant = candidates.find((candidate) => candidate.name === "Oliver Grant")!;
    const linked = await linkTask(mark, task.id, { contactId: grant.id }, { operation: "link_task", source: "web" });
    assert.equal(linked.contactId, grant.id);
    assert.equal(linked.companyId, halden);
    assert.deepEqual((await taskLinkCandidates(mark, task.id)).candidates, []);
    await assert.rejects(linkTask(mark, task.id, { contactId: raj }, { operation: "link_task", source: "web" }), /already linked/);
    const audit = await sql<{ operation: string }>("select operation from crm.audit_events where entity_id = $1 and event_type = 'task.updated'", [task.id]);
    assert.deepEqual(audit.map((row) => row.operation), ["link_task"]);
    await assert.rejects(linkTask(sam, (await createTask(mark, { title: "Mark's own task Oliver" })).body.task.id, { contactId: grant.id }, { operation: "link_task" }), /Task not found/);
  });

  it("links open unlinked tasks by full name once, and leaves the rest", async () => {
    const owner = await createUser("backfill@links.test", "Bea Backfill");
    const company = (await createCompany(owner, { name: "Kestrel Logistics", domain: "kestrel-links.test" })).body.company.id;
    await createContact(owner, { companyId: company, firstName: "Lucy", lastName: "Hart", email: "lucy@kestrel-links.test" });
    const ids: Record<string, string> = {};
    for (const title of ["Call Lucy Hart", "Call Lucy", "Plan the week", "Book Kestrel Logistics", "Done Lucy Hart"]) {
      ids[title] = (await createTask(owner, { title, contactId: null })).body.task.id;
    }
    await sql("update crm.tasks set completed_at = now() where id = $1", [ids["Done Lucy Hart"]]);
    const dry = await backfillTaskLinks(owner, { dryRun: true });
    assert.equal(dry.linked, 2);
    assert.equal((await getTask(owner, ids["Call Lucy Hart"])).contactId, null);
    const first = await backfillTaskLinks(owner, { batch: 2 });
    assert.deepEqual({ checked: first.checked, linked: first.linked, failed: first.failed }, { checked: 4, linked: 2, failed: 0 });
    assert.equal((await getTask(owner, ids["Call Lucy Hart"])).companyId, company);
    assert.equal((await getTask(owner, ids["Book Kestrel Logistics"])).companyId, company);
    assert.equal((await getTask(owner, ids["Call Lucy"])).contactId, null);
    assert.equal((await getTask(owner, ids["Done Lucy Hart"])).contactId, null);
    const again = await backfillTaskLinks(owner);
    assert.deepEqual({ checked: again.checked, linked: again.linked }, { checked: 2, linked: 0 });

    const unlinked = (await createTask(owner, { title: "Call Lucy Hart again" })).body.task.id;
    await updateTask(owner, unlinked, { contactId: null, companyId: null });
    const fromWorkflow = (await createTask(owner, { title: "Workflow Lucy Hart", contactId: null }, { provenance: { operation: "workflow_create_task", source: "workflow" } })).body.task.id;
    const reopened = (await createTask(owner, { title: "Reopened Lucy Hart", completed: true })).body.task.id;
    await updateTask(owner, reopened, { completed: false, contactId: null, companyId: null });
    const reopenEvent = await sql<{ event_type: string }>("select event_type from crm.audit_events where entity_id = $1 and event_type <> 'task.created'", [reopened]);
    assert.deepEqual(reopenEvent.map((row) => row.event_type), ["task.reopened"]);
    const later = await backfillTaskLinks(owner);
    assert.equal(later.linked, 0);
    assert.equal((await getTask(owner, unlinked)).contactId, null);
    assert.equal((await getTask(owner, fromWorkflow)).contactId, null);
    assert.equal((await getTask(owner, reopened)).contactId, null);
    const events = await sql<{ count: string }>("select count(*) from crm.workflow_events where entity_id = any($1::uuid[]) and event_type = 'task.updated'", [Object.values(ids)]);
    assert.equal(Number(events[0].count), 0);
  });
});

describe("Show more", () => {
  it("pages the tasks view and the companies view past 100", async () => {
    const owner = await createUser("paging@links.test", "Pat Paging");
    await sql(
      `insert into crm.tasks (workspace_id, title, owner_id, created_by_user_id)
       select $1, 'Paged task ' || n, $2, $2 from generate_series(1, 130) n`,
      [owner.workspaceId, owner.userId],
    );
    const first = await getDueActions(owner, "all", { mine: true });
    assert.equal(first.tasks.length, 100);
    assert.equal(first.total, 130);
    const second = await getDueActions(owner, "all", { mine: true, pages: 2 });
    assert.equal(second.tasks.length, 130);
    assert.equal(second.total, 130);
    assert.equal(new Set(second.tasks.map((task) => task.id)).size, 130);
    assert.deepEqual(second.tasks.slice(0, 100).map((task) => task.id), first.tasks.map((task) => task.id));
    const done = second.tasks[120];
    await sql("update crm.tasks set completed_at = now() where id = $1", [done.id]);
    await sql(
      `insert into crm.tasks (workspace_id, title, owner_id, created_by_user_id, due_at)
       values ($1, 'Paged task urgent', $2, $2, now() - interval '1 day')`,
      [owner.workspaceId, owner.userId],
    );
    const refreshed = await getDueActions(owner, "all", { mine: true, pages: 2 });
    assert.equal(refreshed.tasks.length, 130);
    assert.equal(refreshed.tasks[0].title, "Paged task urgent");
    assert.ok(!refreshed.tasks.some((task) => task.id === done.id));
    assert.equal(new Set(refreshed.tasks.map((task) => task.id)).size, 130);

    await sql(
      `insert into crm.companies (workspace_id, name, normalized_name, domain, owner_id, created_by_user_id)
       select $1, 'Paged company ' || n, 'paged company ' || n, 'paged-' || n || '.test', $2, $2 from generate_series(1, 105) n`,
      [owner.workspaceId, owner.userId],
    );
    const none = await getDueActions(owner, "none");
    assert.equal(none.companies.length, 100);
    assert.equal(none.total, 105);
    const rest = await getDueActions(owner, "none", { pages: 2 });
    assert.equal(rest.companies.length, 105);
    assert.equal(rest.total, 105);
    assert.equal(new Set(rest.companies.map((company) => company.id)).size, 105);
    assert.equal((await getDueActions(owner, "none", { pages: 999 })).companies.length, 105);
  });
});

describe("names in the title", () => {
  const task = {
    title: "Email Raj the case study Sam wrote for Halden Group, mark it urgent",
    companyId: "c1",
    companyName: "Halden Group",
    contactId: "p1",
    contactName: "Raj Mehta",
    contactFirstName: "Raj",
    contactLastName: "Mehta",
    opportunityId: null,
    opportunityName: null,
  };

  it("links the linked records by full name, first name or surname, and colleagues to a message", () => {
    const segments = taskTitleSegments(task, [
      { id: "u1", name: "Sam Okafor" },
      { id: "u2", name: "Mark Ridgeon" },
    ]);
    const linked = segments.filter((segment) => segment.target).map((segment) => [segment.text, segment.target?.kind]);
    assert.deepEqual(linked, [
      ["Raj", "contact"],
      ["Sam", "colleague"],
      ["Halden Group", "company"],
    ]);
    assert.equal(segments.map((segment) => segment.text).join(""), task.title);
  });

  it("never links a colleague's first name followed by a surname or shared with another colleague, and keeps the linked person's", () => {
    const named = taskTitleSegments({ ...task, title: "Ask Sam Brown about the deck" }, [{ id: "u1", name: "Sam Okafor" }]);
    assert.deepEqual(named.filter((segment) => segment.target).map((segment) => segment.text), []);
    const dated = taskTitleSegments({ ...task, title: "Call Raj Monday" }, []);
    assert.deepEqual(dated.filter((segment) => segment.target).map((segment) => segment.text), ["Raj"]);
    const shared = taskTitleSegments({ ...task, title: "Ask Sam for the deck" }, [
      { id: "u1", name: "Sam Okafor" },
      { id: "u3", name: "Sam Lee" },
    ]);
    assert.deepEqual(shared.filter((segment) => segment.target).map((segment) => segment.text), []);
    const own = taskTitleSegments({ ...task, title: "Email Raj Northwind proposal" }, []);
    assert.deepEqual(own.filter((segment) => segment.target).map((segment) => segment.text), ["Raj"]);
    const hyphen = taskTitleSegments({ ...task, title: "Ask Raj-Kumar about Halden Group-wide pricing" }, []);
    assert.deepEqual(hyphen.filter((segment) => segment.target).map((segment) => segment.text), []);
    const here = taskTitleSegments({ ...task, title: "Email Raj about Halden Group" }, [{ id: "u4", name: "Raj Patel" }], null, { kind: "contact", id: "p1" });
    assert.deepEqual(here.filter((segment) => segment.target).map((segment) => segment.text), ["Halden Group"]);
  });

  it("never links the viewer, and prefers the linked person over a colleague with the same first name", () => {
    const own = taskTitleSegments({ ...task, title: "Mark to call Mehta" }, [{ id: "u2", name: "Mark Ridgeon" }], "u2");
    assert.deepEqual(own.filter((segment) => segment.target).map((segment) => segment.text), ["Mehta"]);
    const clash = taskTitleSegments({ ...task, title: "Call Raj today" }, [{ id: "u3", name: "Raj Patel" }]);
    assert.deepEqual(clash.filter((segment) => segment.target).map((segment) => segment.target?.kind), ["contact"]);
  });
});
