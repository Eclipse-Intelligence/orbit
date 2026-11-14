import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyMigrationSql } from "@/lib/db/migration-sql";
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
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";
import { describeAction, recordNames } from "@/lib/assistant/tools";
import { withActor } from "@/lib/crm/context";
import { writeTaskDocsInDb } from "@/lib/crm/task-docs";
import { archiveWebhook, createWebhook, deliverDueWebhooks } from "@/lib/crm/webhooks";
import { restoreDoc } from "@/lib/docs/store";
import { textParts } from "@/lib/text-links";
import { docPickHeading, docPickNotice, privateDocWarning, showsDescriptionLinks, sourceOffset } from "@/lib/task-doc-picks";
import { parseTaskText } from "@/lib/task-pad";
import { shortDay } from "@/lib/docs/format";

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

    await assert.rejects(getTask(sam, task.id), (error: unknown) => error instanceof CrmError && error.code === "not_found");
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
        [shortDay(daily.date), "mention"],
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
    await assert.rejects(updateTask(agent, task.id, { docIds: [shared] }), forbidden);
    const agentTask = (await createTask(agent, { title: "Agent's own task" })).body.task;
    await assert.rejects(updateTask(agent, agentTask.id, { docIds: [privateDoc] }), invalid("docIds"));
    const viaAgent = (await updateTask(agent, agentTask.id, { docIds: [shared] })).body.task;
    assert.deepEqual(viaAgent.docIds, [shared]);
    const agentRow = await sql<{ created_by: string | null; created_by_agent_id: string | null }>("select created_by, created_by_agent_id from crm.task_docs where task_id = $1", [agentTask.id]);
    assert.deepEqual(agentRow, [{ created_by: null, created_by_agent_id: agent.agentId }]);
    await assert.rejects(updateTask(readOnlyAgent, agentTask.id, { docIds: [] }), forbidden);
    assert.deepEqual((await updateTask(agent, agentTask.id, { docIds: [] })).body.task.docIds, []);
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
    assert.deepEqual(after.docIds, [shared]);
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
    assert.deepEqual(docQueryAt("Call [[renewal now", 10), { start: 5, end: 14, query: "renewal" });
    assert.deepEqual(docQueryAt("Call Jane\n[[ren", 15), { start: 10, end: 15, query: "ren" });
    assert.equal(docQueryAt("[[old]] and more", 16), null);
    assert.deepEqual(withoutDocQuery("Call [[renewal now", { start: 5, end: 14 }), { text: "Call now", caret: 5 });

    assert.deepEqual(withoutDocQuery("Call Jane about the renewal terms [[renew", { start: 34, end: 41 }), { text: "Call Jane about the renewal terms ", caret: 34 });
    assert.deepEqual(withoutDocQuery("Call Jane [[renew tomorrow", { start: 10, end: 17 }), { text: "Call Jane tomorrow", caret: 10 });
    assert.deepEqual(withoutDocQuery("Call Jane [[renew]] tomorrow", { start: 10, end: 17 }), { text: "Call Jane tomorrow", caret: 10 });
    assert.deepEqual(withoutDocQuery("[[renew", { start: 0, end: 7 }), { text: "", caret: 0 });
    assert.deepEqual(withoutDocQuery("[[renew call Jane", { start: 0, end: 7 }), { text: "call Jane", caret: 0 });
  });
});

describe("Add task card and panel helpers", () => {
  it("doesn't read a date inside [[ ]] or an open [[ query", () => {
    const open = parseTaskText("Read [[Monday notes", new Date("2026-11-12T09:00:00Z"));
    assert.equal(open.due, null);
    assert.equal(open.title, "Read [[Monday notes");
    const closed = parseTaskText("Read [[Monday notes]] tomorrow", new Date("2026-11-12T09:00:00Z"));
    assert.equal(closed.due, "2026-11-13");
    assert.equal(closed.title, "Read [[Monday notes]]");
  });

  it("shows the description's links only while the field isn't focused, in the panel", () => {
    assert.equal(showsDescriptionLinks("See https://northwind.test", "panel", false), true);
    assert.equal(showsDescriptionLinks("See https://northwind.test", "panel", true), false);
    assert.equal(showsDescriptionLinks("See Https://northwind.test", "panel", false), true);
    assert.equal(showsDescriptionLinks("See https://northwind.test", "row", false), false);
    assert.equal(showsDescriptionLinks("No address", "panel", false), false);
    assert.equal(sourceOffset("a\u202eb c", 2), 3);
    assert.equal(sourceOffset("plain", 3), 3);
  });

  it("links web addresses safely, keeping balanced brackets and dropping trailing quotes", () => {
    const urls = (text: string) => textParts(text, { emails: true, markdown: true, balanced: true }).filter((part) => part.kind !== "text").map((part) => part.href);
    assert.deepEqual(urls("See https://en.wikipedia.org/wiki/Foo_(bar) now"), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    assert.deepEqual(urls("(see https://acme.test/a)"), ["https://acme.test/a"]);
    assert.deepEqual(urls("“https://acme.test/q”"), ["https://acme.test/q"]);
    assert.deepEqual(urls("Https://acme.test/x."), ["Https://acme.test/x"]);
    assert.deepEqual(urls("[deck](https://acme.test/d)"), ["https://acme.test/d"]);
    assert.deepEqual(urls("https://acme.test/a[1]"), ["https://acme.test/a[1]"]);
    assert.deepEqual(urls("javascript:alert(1) or ftp://x.test"), []);
    assert.deepEqual(urls("jane@acme.test"), ["mailto:jane@acme.test"]);
  });

  it("names the picker's state", () => {
    const doc = { id: "d", title: "Terms", folderPath: "Sales › Pricing", shared: false, updatedAt: "2026-11-12T09:00:00Z", updatedBy: { id: "u", name: "Mark", short: "Mark", initials: "M", color: "", kind: "person" as const } };
    assert.equal(docPickHeading("", [doc]), "Recent");
    assert.equal(docPickHeading("", []), "");
    assert.equal(docPickHeading("ter", [doc]), "1 match");
    assert.equal(docPickHeading("ter", [doc, doc, doc]), "3 matches");
    assert.equal(docPickNotice("", [], false), null);
    assert.equal(docPickNotice("zz", [], false), "No docs match");
    assert.equal(docPickNotice("zz", null, true), "Couldn't search. Try again.");
    assert.equal(privateDocWarning(doc), 'Pricing, private. Teammates will see "Doc" only');
    assert.equal(privateDocWarning({ folderPath: null }), 'Top level, private. Teammates will see "Doc" only');
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

describe("task docs under review", () => {
  it("lets the database itself refuse daily notes, other people's tasks, someone else's name and hidden docs for a signed-in member", async () => {
    const task = (await createTask(mark, { title: "Database checks" })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    const daily = await openDailyNote(mark);
    const insert = (user: UserActor, page: string, by = user.userId) =>
      queryAsUser(user.userId, "insert into crm.task_docs (task_id, page_id, workspace_id, created_by) values ($1, $2, $3, $4)", [task.id, page, mark.workspaceId, by]);
    await assert.rejects(insert(mark, daily.page.id), /row-level security|another workspace/);
    await assert.rejects(insert(priya, shared), /row-level security/);
    await assert.rejects(insert(mark, shared, priya.userId), /row-level security/);
    await assert.rejects(insert(mark, samsPrivate), /row-level security/);
    await insert(mark, shared);
    await assert.rejects(
      queryAsUser(mark.userId, "insert into crm.task_docs (task_id, page_id, workspace_id, created_by, created_by_agent_id) values ($1, $2, $3, $4, $5)", [task.id, shared, mark.workspaceId, mark.userId, agent.agentId]),
      /row-level security|task_docs_one_creator/,
    );
    await updateTask(mark, task.id, { docIds: [shared] });
    const seen = await queryAsUser<{ page_id: string }>(priya.userId, "select page_id from crm.task_docs where task_id = $1", [task.id]);
    assert.deepEqual(seen.map((row) => row.page_id), [shared]);
    const removed = await queryAsUser(priya.userId, "delete from crm.task_docs where task_id = $1 returning page_id", [task.id]);
    assert.deepEqual(removed, []);
    assert.deepEqual(await queryAsUser(sam.userId, "select page_id from crm.task_docs where task_id = $1", [task.id]), []);
  });

  it("hides an archived doc's link, leaves it out of the cap, and brings it back when the doc is restored", async () => {
    const docs: string[] = [];
    for (let index = 0; index < 20; index += 1) docs.push((await createDoc(mark, { title: `Cap doc ${index}`, shared: true })).id);
    const task = (await createTask(mark, { title: "Twenty docs", docIds: docs })).body.task;
    assert.equal(task.docIds.length, 20);
    const extra = (await createDoc(mark, { title: "One more", shared: true })).id;
    await assert.rejects(updateTask(mark, task.id, { docIds: [...docs, extra] }), invalid("docIds"));
    await archiveDoc(mark, docs[0]);
    const hidden = await getTask(mark, task.id);
    assert.deepEqual(hidden.docIds, docs.slice(1));
    assert.ok(!hidden.docs.some((doc) => doc.id === docs[0]));
    assert.ok(!(await listTaskDocs(mark, task.id)).some((entry) => entry.id === docs[0]));
    const added = (await updateTask(mark, task.id, { docIds: [...docs.slice(1), extra] })).body.task;
    assert.equal(added.docIds.length, 20);
    await restoreDoc(mark, docs[0]);
    const back = await getTask(mark, task.id);
    assert.ok(back.docIds.includes(docs[0]));
    assert.equal(back.docIds.length, 21);
    const trimmed = (await updateTask(mark, task.id, { docIds: back.docIds.slice(0, 5) })).body.task;
    assert.equal(trimmed.docIds.length, 5);
  });

  it("runs the migration again without changing anything", async () => {
    const before = await sql("select task_id, page_id, page_archived from crm.task_docs order by task_id, page_id");
    const migration = readFileSync("supabase/migrations/20270131100000_task_docs.sql", "utf8");
    await applyMigrationSql(getAdminPool(), migration);
    await applyMigrationSql(getAdminPool(), migration);
    assert.deepEqual(await sql("select task_id, page_id, page_archived from crm.task_docs order by task_id, page_id"), before);
    assert.equal((await sql("select 1 from pg_trigger where tgname = 'pages_task_docs_move'")).length, 0);
  });

  it("lets only the task's owner or creator change its docs, never an admin who is neither", async () => {
    const ada = await join(await createUser("ada@docs-tasks.test", "Ada Admin"), mark, "admin");
    const task = (await createTask(mark, { title: "Admin can't link", docIds: [shared] })).body.task;
    await assert.rejects(updateTask(ada, task.id, { docIds: [shared, privateDoc] }), forbidden);
    await assert.rejects(updateTask(ada, task.id, { docIds: [] }), forbidden);
    await assert.rejects(changeTaskDoc(ada, task.id, shared, "unlink", WEB), forbidden);
    await assert.rejects(
      queryAsUser(ada.userId, "insert into crm.task_docs (task_id, page_id, workspace_id, created_by) values ($1, $2, $3, $4)", [task.id, privateDoc, mark.workspaceId, ada.userId]),
      /row-level security/,
    );
    assert.deepEqual(await queryAsUser(ada.userId, "delete from crm.task_docs where task_id = $1 returning page_id", [task.id]), []);
    assert.deepEqual((await getTask(mark, task.id)).docIds, [shared]);
    const renamed = (await updateTask(ada, task.id, { title: "Admin renamed it" })).body.task;
    assert.deepEqual(renamed.docIds, [shared]);
  });

  it("answers invalid_input on docIds when the link write itself fails", async () => {
    const task = (await createTask(mark, { title: "Write failure" })).body.task;
    await assert.rejects(
      withActor(mark, (db) => writeTaskDocsInDb(db, mark, { id: task.id, workspaceId: mark.workspaceId }, { add: [crypto.randomUUID()], remove: [] })),
      invalid("docIds"),
    );
  });

  it("delivers the link change to webhooks with ids only", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "1";
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("ok");
    }) as typeof fetch;
    try {
      const hook = await createWebhook(mark, { url: "http://127.0.0.1:9/hook", events: ["task.updated"] });
      const task = (await createTask(mark, { title: "Hooked task" })).body.task;
      await changeTaskDoc(mark, task.id, privateDoc, "link", WEB);
      for (let attempt = 0; attempt < 10 && !bodies.some((body) => body.includes(task.id)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await sql("update crm.webhook_deliveries set status = 'pending', next_attempt_at = now() where endpoint_id = $1", [hook.endpoint.id]);
        await deliverDueWebhooks(50, { fetchImpl });
      }
      const body = bodies.find((item) => item.includes(task.id));
      assert.ok(body, "the change was delivered");
      const payload = JSON.parse(body) as { type: string };
      assert.equal(payload.type, "task.updated");
      assert.match(body, new RegExp(`"docIds":\\["${privateDoc}"\\]`));
      assert.doesNotMatch(body, /pricing model/);
      await archiveWebhook(mark, hook.endpoint.id);
    } finally {
      delete process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
    }
  });

  it("shows only the change on the approval card, naming a doc the person can't read as private", async () => {
    const task = (await createTask(mark, { title: "Card check", ownerId: priya.userId, docIds: [privateDoc, shared] })).body.task;
    const third = (await createDoc(mark, { title: "Card extra", shared: true })).id;
    const args = { taskId: task.id, docIds: [shared, third] };
    const card = describeAction("update_task", args, await recordNames(priya, [args], ["update_task"]));
    assert.ok(card.lines.includes("Link: Card extra"), card.lines.join(" | "));
    assert.ok(card.lines.includes("Unlink: 1 private doc"), card.lines.join(" | "));
    assert.doesNotMatch(card.lines.join(" "), /Unknown record|pricing model/);
    const clear = { taskId: task.id, docIds: [] };
    const markCard = describeAction("update_task", clear, await recordNames(mark, [clear], ["update_task"]));
    assert.ok(markCard.lines.includes("Unlink: Renewal pricing model, Northwind renewal terms"), markCard.lines.join(" | "));
    const fresh = { title: "New", docIds: [shared] };
    const createCard = describeAction("create_task", fresh, await recordNames(mark, [fresh], ["create_task"]));
    assert.ok(createCard.lines.includes("Docs: Northwind renewal terms"), createCard.lines.join(" | "));
  });

  it("keeps both of two links made at once, and a repeated link changes nothing", async () => {
    const task = (await createTask(mark, { title: "Concurrent links" })).body.task;
    const other = (await createDoc(mark, { title: "Concurrent other", shared: true })).id;
    await Promise.all([changeTaskDoc(mark, task.id, shared, "link", WEB), changeTaskDoc(mark, task.id, other, "link", WEB)]);
    assert.deepEqual([...(await getTask(mark, task.id)).docIds].sort(), [shared, other].sort());
    await changeTaskDoc(mark, task.id, other, "link", WEB);
    const events = await sql<{ total: number }>("select count(*)::int as total from crm.audit_events where entity_id = $1 and event_type = 'task.updated'", [task.id]);
    assert.equal(events[0].total, 2);
  });

  it("restores what the person can still link when undoing an unlink, and refuses only when nothing can be restored", async () => {
    const task = (await createTask(mark, { title: "Undo by Priya", docIds: [privateDoc, shared] })).body.task;
    await updateTask(mark, task.id, { ownerId: priya.userId });
    await changeTaskDoc(priya, task.id, privateDoc, "unlink", WEB);
    const only = (await listRecentChanges(priya, { entityType: "task" })).find((item) => item.entityId === task.id && item.type === "task.updated");
    assert.ok(only);
    assert.equal(only.canUndo, false);
    assert.equal(only.reason, "Can't undo: you can't open that doc any more.");

    const both = (await createTask(mark, { title: "Undo both by Priya", docIds: [privateDoc, shared] })).body.task;
    await updateTask(mark, both.id, { ownerId: priya.userId });
    await updateTask(priya, both.id, { docIds: [], title: "Undo both, renamed" });
    const change = (await listRecentChanges(priya, { entityType: "task" })).find((item) => item.entityId === both.id && item.type === "task.updated");
    assert.ok(change?.canUndo, change?.reason);
    await undoAuditEvent(priya, change.id, { operation: "undo_change", source: "web" });
    const restored = await getTask(mark, both.id);
    assert.deepEqual(restored.docIds, [shared]);
    assert.equal(restored.title, "Undo both by Priya");
  });

  it("refuses docIds from a tagged teammate and from a token without docs:read, over the API and MCP too", async () => {
    const task = (await createTask(mark, { title: "Tagged sends docs" })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    await assert.rejects(updateTask(priya, task.id, { docIds: [shared] }), forbidden);
    const readOnly = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "No docs");
    const own = (await createTask(readOnly.actor, { title: "No docs agent's task" })).body.task;
    const patched = await restPatchTask(
      new Request(`http://crm.test/api/v1/tasks/${own.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${readOnly.token}`, "content-type": "application/json" },
        body: JSON.stringify({ docIds: [shared] }),
      }),
      { params: Promise.resolve({ id: own.id }) },
    );
    assert.equal(patched.status, 403);
    assert.match(await patched.text(), /can't read docs/);
    const viaMcp = await mcpCall(readOnly.actor, "update_next_action", { id: own.id, docIds: [shared] });
    assert.equal(viaMcp.error, true);
    assert.match(viaMcp.text, /can't read docs/);
    assert.deepEqual((await getTask(mark, own.id)).docIds, []);
  });

  it("scopes a doc's task list to the caller's workspace and names daily notes by their day", async () => {
    await assert.rejects(listDocTasks(elsewhere, shared), (error: unknown) => error instanceof CrmError && error.code === "not_found");
    const task = (await createTask(mark, { title: "Daily mention title" })).body.task;
    const daily = await appendToDailyNote(mark, { text: `See @[Daily mention title](task:${task.id})` });
    const entry = (await listTaskDocs(mark, task.id)).find((item) => item.id === daily.page.id);
    assert.match(entry?.title ?? "", /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  });
});
