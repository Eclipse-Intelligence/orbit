import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET as restGetTask, PATCH as restPatchTask } from "@/app/api/v1/tasks/[id]/route";
import { POST as restCreateTask } from "@/app/api/v1/tasks/route";
import { runTool } from "@/lib/assistant/tools";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import { taskDetail } from "@/lib/crm/task-detail";
import { changeTaskDoc } from "@/lib/crm/task-doc-links";
import { listDocTasks, listTaskDocs } from "@/lib/crm/task-docs";
import { addTaskParticipants, createTask, getTask, listTasks, updateTask } from "@/lib/crm/tasks";
import { listRecentChanges, undoAuditEvent } from "@/lib/crm/undo";
import type { Actor, AgentActor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createFolder } from "@/lib/docs/folders";
import { archiveDoc, createDoc } from "@/lib/docs/store";
import { appendToDailyNote, openDailyNote } from "@/lib/docs/daily-notes";
import { docPickTargets } from "@/lib/docs/view";
import { docQueryAt, withoutDocQuery } from "@/lib/task-pad";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase, useServerlessPool } from "./helpers";

const WEB = { operation: "link_task_doc", source: "web" } as const;

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let agent: AgentActor;
let agentToken: string;
let readOnlyAgent: AgentActor;
let elsewhere: UserActor;
let shared: string;
let privateDoc: string;
let samsPrivate: string;
let otherWorkspaceDoc: string;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, owner: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [owner.workspaceId, user.userId, role]);
  return { ...user, workspaceId: owner.workspaceId, workspaceName: owner.workspaceName, role, scopes: scopesForRole(role) };
}

async function mcpCall(actor: Actor, name: string, args: Record<string, unknown>) {
  const server = createCrmMcpServer(actor, actor.type === "user" ? { personal: { tokenId: crypto.randomUUID(), canSend: false } } : {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "task-docs", version: "1.0.0" });
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

function forbidden(error: unknown) {
  return error instanceof CrmError && error.code === "forbidden";
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-tasks.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@docs-tasks.test", "Sam Okafor"), mark, "member");
  priya = await join(await createUser("priya@docs-tasks.test", "Priya Nair"), mark, "member");
  const issued = await createAgent(mark.workspaceId, scopesForRole("owner"), "Docs agent");
  agent = issued.actor;
  agentToken = issued.token;
  readOnlyAgent = (await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Tasks only")).actor;
  const sales = await createFolder(mark, { name: "Sales", shared: true });
  const northwind = await createFolder(mark, { name: "Northwind", parentId: sales.id, shared: true });
  shared = (await createDoc(mark, { title: "Northwind renewal terms", content: "Three-year option.", folderId: northwind.id, shared: true })).id;
  privateDoc = (await createDoc(mark, { title: "Renewal pricing model", content: "Margins and floor price." })).id;
  samsPrivate = (await createDoc(sam, { title: "Sam's renewal scratchpad", content: "Rough notes." })).id;
  const olga = await createUser("olga@docs-tasks.test", "Olga Other");
  elsewhere = await join({ ...mark }, olga, "member");
  otherWorkspaceDoc = (await createDoc(elsewhere, { title: "Renewal elsewhere", content: "Other workspace.", shared: true })).id;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("linking docs to a task", () => {
  useServerlessPool();

  it("stores links per task, shows titles only to people who can read the doc, and never stores a title on the task", async () => {
    const task = (await createTask(mark, { title: "Call Jane about the renewal terms", ownerId: mark.userId, docIds: [shared, privateDoc] })).body.task;
    assert.deepEqual(task.docIds, [shared, privateDoc]);
    assert.deepEqual(task.docs, [
      { id: shared, title: "Northwind renewal terms", readable: true },
      { id: privateDoc, title: "Renewal pricing model", readable: true },
    ]);
    await addTaskParticipants(mark, task.id, [priya.userId]);

    const seen = await getTask(priya, task.id);
    assert.deepEqual(seen.docIds, [shared, privateDoc]);
    assert.deepEqual(seen.docs, [
      { id: shared, title: "Northwind renewal terms", readable: true },
      { id: privateDoc, title: null, readable: false },
    ]);
    assert.doesNotMatch(JSON.stringify(seen), /pricing model/);
    const listed = (await listTasks(priya, { tagged: true })).data.find((item) => item.id === task.id);
    assert.deepEqual(listed?.docs.map((doc) => doc.readable), [true, false]);

    const asAgent = await getTask(agent, task.id);
    assert.deepEqual(asAgent.docs, [
      { id: shared, title: "Northwind renewal terms", readable: true },
      { id: privateDoc, title: null, readable: false },
    ]);
    const noDocs = await getTask(readOnlyAgent, task.id);
    assert.deepEqual(noDocs.docs.map((doc) => doc.readable), [false, false]);
    assert.doesNotMatch(JSON.stringify(noDocs), /Northwind renewal terms/);

    await assert.rejects(getTask(sam, task.id));
    const rows = await sql<{ page_id: string; workspace_id: string; created_by: string }>("select page_id, workspace_id, created_by from crm.task_docs where task_id = $1 order by created_at", [task.id]);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.workspace_id === mark.workspaceId && row.created_by === mark.userId));
    const columns = await sql<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'crm' and table_name = 'task_docs'");
    assert.ok(!columns.some((column) => column.column_name === "title"));
  });

  it("lists linked docs and docs that mention the task, hiding mentions and titles from people who can't read the doc", async () => {
    const task = (await createTask(mark, { title: "Price the three-year option", docIds: [privateDoc, shared] })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    const mention = `@[Price the three-year option](task:${task.id})`;
    const mentioning = (await createDoc(mark, { title: "Call notes: Jane Cooper", content: `Ask ${mention} first.`, shared: true })).id;
    await createDoc(mark, { title: "Mark's private plan", content: `Secret ${mention}` });
    await createDoc(mark, { title: "Both", content: `Linked and ${mention}`, shared: true }).then((doc) => updateTask(mark, task.id, { docIds: [privateDoc, shared, doc.id] }));
    const daily = await appendToDailyNote(mark, { text: `Remember ${mention}` });

    const markList = await listTaskDocs(mark, task.id);
    assert.deepEqual(
      markList.map((entry) => [entry.title, entry.reason]),
      [
        ["Both", "linked"],
        ["Northwind renewal terms", "linked"],
        ["Renewal pricing model", "linked"],
        [daily.page.title, "mention"],
        ["Mark's private plan", "mention"],
        ["Call notes: Jane Cooper", "mention"],
      ],
    );
    assert.equal(markList.find((entry) => entry.id === shared)?.folderPath, "Sales › Northwind");
    assert.equal(markList.find((entry) => entry.id === mentioning)?.shared, true);
    assert.equal(markList.find((entry) => entry.id === privateDoc)?.shared, false);

    const priyaList = await listTaskDocs(priya, task.id);
    assert.deepEqual(
      priyaList.map((entry) => [entry.title, entry.reason, entry.readable]),
      [
        ["Both", "linked", true],
        ["Northwind renewal terms", "linked", true],
        [null, "linked", false],
        ["Call notes: Jane Cooper", "mention", true],
      ],
    );
    assert.doesNotMatch(JSON.stringify(priyaList), /private plan|pricing model|Remember/);

    const detail = await taskDetail(agent, task.id);
    assert.deepEqual(
      detail.docs.map((entry) => [entry.title, entry.readable]),
      [
        ["Both", true],
        ["Northwind renewal terms", true],
        [null, false],
        ["Call notes: Jane Cooper", true],
      ],
    );
    assert.deepEqual(detail.task.docs.map((doc) => doc.readable), [false, true, true]);
    const ownerDetail = await taskDetail(mark, task.id);
    assert.equal(ownerDetail.docs.length, 6);
  });

  it("refuses docs from another workspace, daily notes, archived docs and docs the person can't open", async () => {
    await assert.rejects(createTask(mark, { title: "Mixed workspaces", docIds: [otherWorkspaceDoc] }), invalid("docIds"));
    const task = (await createTask(mark, { title: "Mixed workspaces" })).body.task;
    await assert.rejects(updateTask(mark, task.id, { docIds: [otherWorkspaceDoc] }), invalid("docIds"));
    await assert.rejects(
      sql("insert into crm.task_docs (task_id, page_id, workspace_id) values ($1, $2, $3)", [task.id, otherWorkspaceDoc, mark.workspaceId]),
      /doc belongs to another workspace/,
    );
    await assert.rejects(
      sql("insert into crm.task_docs (task_id, page_id, workspace_id) values ($1, $2, $3)", [task.id, shared, elsewhere.workspaceId]),
      /task belongs to another workspace/,
    );
    const daily = await openDailyNote(mark);
    await assert.rejects(updateTask(mark, task.id, { docIds: [daily.page.id] }), invalid("docIds"));
    await assert.rejects(updateTask(mark, task.id, { docIds: [samsPrivate] }), invalid("docIds"));
    await assert.rejects(updateTask(mark, task.id, { docIds: ["not-a-uuid"] as string[] }), invalid("docIds"));
    const archived = (await createDoc(mark, { title: "Old terms", shared: true })).id;
    await archiveDoc(mark, archived);
    await assert.rejects(updateTask(mark, task.id, { docIds: [archived] }), invalid("docIds"));
    await assert.rejects(updateTask(readOnlyAgent, task.id, { docIds: [shared] }), forbidden);
    await assert.rejects(updateTask(agent, task.id, { docIds: [privateDoc] }), invalid("docIds"));
    const viaAgent = (await updateTask(agent, task.id, { docIds: [shared] })).body.task;
    assert.deepEqual(viaAgent.docIds, [shared]);
    const agentRow = await sql<{ created_by: string | null; created_by_agent_id: string | null }>("select created_by, created_by_agent_id from crm.task_docs where task_id = $1", [task.id]);
    assert.deepEqual(agentRow, [{ created_by: null, created_by_agent_id: agent.agentId }]);
    assert.deepEqual((await updateTask(readOnlyAgent, task.id, { docIds: [] })).body.task.docIds, []);
  });

  it("needs the same rights as editing the task's links, and keeps a private doc a teammate can't read when they change other links", async () => {
    const task = (await createTask(mark, { title: "Send Northwind the revised terms", docIds: [privateDoc] })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    await assert.rejects(changeTaskDoc(priya, task.id, shared, "link", WEB), forbidden);
    await assert.rejects(
      changeTaskDoc(priya, task.id, privateDoc, "unlink", WEB),
      (error: unknown) => forbidden(error),
    );
    const handed = (await updateTask(mark, task.id, { ownerId: priya.userId })).body.task;
    assert.deepEqual(handed.docIds, [privateDoc]);
    const linked = await changeTaskDoc(priya, task.id, shared, "link", WEB);
    assert.deepEqual(linked.docIds, [privateDoc, shared]);
    assert.deepEqual(linked.docs, [
      { id: privateDoc, title: null, readable: false },
      { id: shared, title: "Northwind renewal terms", readable: true },
    ]);
    const unlinked = await changeTaskDoc(priya, task.id, privateDoc, "unlink", WEB);
    assert.deepEqual(unlinked.docIds, [shared]);
    await assert.rejects(changeTaskDoc(priya, task.id, privateDoc, "link", WEB), invalid("docIds"));
  });

  it("records links as task updates that undo, webhooks and workflows read, and undoes them", async () => {
    const task = (await createTask(mark, { title: "Chase the signed terms" })).body.task;
    await changeTaskDoc(mark, task.id, shared, "link", WEB);
    const events = await sql<{ event_type: string; operation: string; source: string; changes: { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> } }>(
      "select event_type, operation, source, changes from crm.audit_events where entity_id = $1 and event_type = 'task.updated' order by created_at",
      [task.id],
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, "link_task_doc");
    assert.equal(events[0].source, "web");
    assert.deepEqual(events[0].changes.fields, ["docIds"]);
    assert.deepEqual(events[0].changes.before.docIds, []);
    assert.deepEqual(events[0].changes.after.docIds, [shared]);
    assert.doesNotMatch(JSON.stringify(events[0].changes), /Northwind renewal terms/);

    const created = (await createTask(mark, { title: "Created with a doc", docIds: [privateDoc] })).body.task;
    const createdEvent = await sql<{ changes: { after: Record<string, unknown> } }>("select changes from crm.audit_events where entity_id = $1 and event_type = 'task.created'", [created.id]);
    assert.deepEqual(createdEvent[0].changes.after.docIds, [privateDoc]);
    assert.equal("docs" in createdEvent[0].changes.after, false);
    assert.doesNotMatch(JSON.stringify(createdEvent[0].changes), /pricing model/);

    const change = (await listRecentChanges(mark, { entityType: "task" })).find((item) => item.entityId === task.id && item.type === "task.updated");
    assert.ok(change, "the link is listed");
    assert.equal(change.canUndo, true, change.reason);
    assert.match(change.summary, /Docs from none to 1 doc/);
    await undoAuditEvent(mark, change.id, { operation: "undo_change", source: "web" });
    assert.deepEqual((await getTask(mark, task.id)).docIds, []);

    await changeTaskDoc(mark, task.id, shared, "link", WEB);
    await changeTaskDoc(mark, task.id, shared, "unlink", WEB);
    const removal = (await listRecentChanges(mark, { entityType: "task" })).find((item) => item.entityId === task.id && item.type === "task.updated");
    assert.ok(removal?.canUndo, removal?.reason);
    await undoAuditEvent(mark, removal.id, { operation: "undo_change", source: "web" });
    assert.deepEqual((await getTask(mark, task.id)).docIds, [shared]);

    const noChange = await changeTaskDoc(mark, task.id, shared, "link", WEB);
    assert.deepEqual(noChange.docIds, [shared]);
    const count = await sql<{ total: number }>("select count(*)::int as total from crm.audit_events where entity_id = $1 and event_type = 'task.updated'", [task.id]);
    assert.equal(count[0].total, 5);
  });

  it("drops a link when the doc is deleted, hides an archived doc, and drops links when the task moves workspace", async () => {
    const gone = (await createDoc(mark, { title: "Short lived", shared: true })).id;
    const archived = (await createDoc(mark, { title: "Archived later", shared: true })).id;
    const task = (await createTask(mark, { title: "Tidy the links", docIds: [gone, archived, shared] })).body.task;
    await sql("delete from crm.pages where id = $1", [gone]);
    await archiveDoc(mark, archived);
    const after = await getTask(mark, task.id);
    assert.deepEqual(after.docIds, [archived, shared]);
    assert.deepEqual(after.docs.map((doc) => doc.id), [shared]);
    await sql("update crm.tasks set workspace_id = $2, company_id = null, contact_id = null, opportunity_id = null, owner_id = null where id = $1", [task.id, elsewhere.workspaceId]);
    assert.deepEqual(await sql("select page_id from crm.task_docs where task_id = $1", [task.id]), []);
  });

  it("shows a doc's tasks to each viewer, only the ones they can see", async () => {
    const markOnly = (await createTask(mark, { title: "Mark's private call", docIds: [shared] })).body.task;
    const priyas = (await createTask(priya, { title: "Priya's follow-up", docIds: [shared] })).body.task;
    await updateTask(priya, priyas.id, { completed: true });
    const markSees = (await listDocTasks(mark, shared)).map((task) => task.title);
    assert.ok(markSees.includes("Mark's private call"));
    assert.ok(markSees.includes("Priya's follow-up"));
    assert.equal(markSees[markSees.length - 1], "Priya's follow-up");
    const priyaSees = await listDocTasks(priya, shared);
    assert.ok(!priyaSees.some((task) => task.id === markOnly.id));
    assert.deepEqual(priyaSees.filter((task) => task.id === priyas.id).map((task) => Boolean(task.completedAt)), [true]);
    await assert.rejects(listDocTasks(priya, privateDoc), (error: unknown) => error instanceof CrmError && error.code === "not_found");
    const agentSees = await listDocTasks(agent, shared);
    assert.ok(agentSees.some((task) => task.id === markOnly.id));
  });

  it("finds docs to link: recent first without a query, then matches by title, with the folder path, never daily notes or others' private docs", async () => {
    const recent = await docPickTargets(mark, "");
    assert.ok(recent.length > 0);
    assert.ok(recent.every((doc) => doc.title !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(doc.title)));
    const found = await docPickTargets(mark, "renew");
    const titles = found.map((doc) => doc.title);
    assert.ok(titles.includes("Northwind renewal terms"));
    assert.ok(titles.includes("Renewal pricing model"));
    assert.ok(!titles.includes("Sam's renewal scratchpad"));
    assert.ok(!titles.includes("Renewal elsewhere"));
    assert.equal(found.find((doc) => doc.id === shared)?.folderPath, "Sales › Northwind");
    assert.equal(found.find((doc) => doc.id === privateDoc)?.shared, false);
    const priyaFound = (await docPickTargets(priya, "renew")).map((doc) => doc.title);
    assert.ok(priyaFound.includes("Northwind renewal terms"));
    assert.ok(!priyaFound.includes("Renewal pricing model"));
    assert.deepEqual(await docPickTargets(mark, "zzzz nothing like this"), []);
  });
});

describe("the [[ picker in the Add task card", () => {
  it("finds the query before the caret and takes it out of the title when a doc is picked", () => {
    assert.deepEqual(docQueryAt("Call Jane about the renewal terms [[", 36), { start: 34, end: 36, query: "" });
    assert.deepEqual(docQueryAt("Call Jane [[renew", 17), { start: 10, end: 17, query: "renew" });
    assert.deepEqual(docQueryAt("Call Jane [[renewal terms", 25), { start: 10, end: 25, query: "renewal terms" });
    assert.equal(docQueryAt("Call Jane [renew", 16), null);
    assert.equal(docQueryAt("Call [[Jane]] now", 17), null);
    assert.equal(docQueryAt("Call [[Jane\nnow", 15), null);
    assert.equal(docQueryAt("No brackets", 11), null);
    assert.deepEqual(docQueryAt("[[a]] then [[b", 14), { start: 11, end: 14, query: "b" });

    assert.deepEqual(withoutDocQuery("Call Jane about the renewal terms [[renew", { start: 34, end: 41 }), { text: "Call Jane about the renewal terms ", caret: 34 });
    assert.deepEqual(withoutDocQuery("Call Jane [[renew tomorrow", { start: 10, end: 17 }), { text: "Call Jane tomorrow", caret: 10 });
    assert.deepEqual(withoutDocQuery("Call Jane [[renew]] tomorrow", { start: 10, end: 17 }), { text: "Call Jane tomorrow", caret: 10 });
    assert.deepEqual(withoutDocQuery("[[renew", { start: 0, end: 7 }), { text: "", caret: 0 });
    assert.deepEqual(withoutDocQuery("[[renew call Jane", { start: 0, end: 7 }), { text: "call Jane", caret: 0 });
  });
});

describe("docIds through the assistant, MCP and REST", () => {
  it("takes docIds on create and update, clears them with null or [], and keeps private titles from agent tokens", async () => {
    const created = (await runTool(mark, "create_task", { title: "Draft the board pack", docIds: [shared, privateDoc], sendToClickUp: false })) as { task: { id: string; docIds: string[] } };
    assert.deepEqual(created.task.docIds, [shared, privateDoc]);
    const cleared = (await runTool(mark, "update_task", { taskId: created.task.id, docIds: null })) as { task: { docIds: string[] } };
    assert.deepEqual(cleared.task.docIds, []);
    const again = (await runTool(mark, "update_task", { taskId: created.task.id, docIds: [shared] })) as { task: { docIds: string[] } };
    assert.deepEqual(again.task.docIds, [shared]);
    const refused = (await runTool(mark, "update_task", { taskId: created.task.id, docIds: [samsPrivate] })) as { error?: string };
    assert.equal(refused.error, "Choose a doc you can open in this workspace.");

    const viaMcp = await mcpCall(mark, "create_next_action", { title: "From MCP", docIds: [privateDoc] });
    assert.equal(viaMcp.error, false, viaMcp.text);
    const mcpTask = JSON.parse(viaMcp.text) as { task: { id: string; docIds: string[] } };
    assert.deepEqual(mcpTask.task.docIds, [privateDoc]);
    const updatedMcp = await mcpCall(mark, "update_next_action", { id: mcpTask.task.id, docIds: [] });
    assert.equal(updatedMcp.error, false, updatedMcp.text);
    assert.deepEqual((JSON.parse(updatedMcp.text) as { task: { docIds: string[] } }).task.docIds, []);
    const agentGet = await mcpCall(agent, "get_next_action", { id: created.task.id });
    assert.match(agentGet.text, /Northwind renewal terms/);
    await updateTask(mark, created.task.id, { docIds: [shared, privateDoc] });
    const agentPrivate = await mcpCall(agent, "get_next_action", { id: created.task.id });
    assert.doesNotMatch(agentPrivate.text, /pricing model/);

    const posted = await restCreateTask(
      new Request("http://crm.test/api/v1/tasks", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "From REST", docIds: [shared] }),
      }),
    );
    assert.equal(posted.status, 201);
    const restTask = ((await posted.json()) as { task: { id: string; docIds: string[]; docs: unknown } }).task;
    assert.deepEqual(restTask.docIds, [shared]);
    assert.deepEqual(restTask.docs, [{ id: shared, title: "Northwind renewal terms", readable: true }]);
    const refusedRest = await restPatchTask(
      new Request(`http://crm.test/api/v1/tasks/${restTask.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ docIds: [privateDoc] }),
      }),
      { params: Promise.resolve({ id: restTask.id }) },
    );
    assert.equal(refusedRest.status, 400);
    const cleared2 = await restPatchTask(
      new Request(`http://crm.test/api/v1/tasks/${restTask.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ docIds: null }),
      }),
      { params: Promise.resolve({ id: restTask.id }) },
    );
    assert.equal(cleared2.status, 200);
    assert.deepEqual(((await cleared2.json()) as { task: { docIds: string[] } }).task.docIds, []);
    const got = await restGetTask(new Request(`http://crm.test/api/v1/tasks/${created.task.id}`, { headers: { authorization: `Bearer ${agentToken}` } }), {
      params: Promise.resolve({ id: created.task.id }),
    });
    const text = await got.text();
    assert.match(text, /"reason":"linked"/);
    assert.doesNotMatch(text, /pricing model/);
  });
});
