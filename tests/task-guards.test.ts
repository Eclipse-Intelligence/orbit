import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describeAction, recordNames, runTool, taskTimingRefusalFor } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import { upsertContact } from "@/lib/crm/contacts";
import { openDiscussion, postMessage } from "@/lib/crm/chat";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { localInstant } from "@/lib/crm/task-time";
import { detectPadRecords } from "@/lib/crm/task-pad";
import { addTaskParticipantsInDb, archiveTask, completeTask, createTask, getTask, updateTask } from "@/lib/crm/tasks";
import { removeMember } from "@/lib/crm/team";
import { NAMED_PROVENANCE_SOURCES, type Actor, type AgentActor, type UserActor } from "@/lib/crm/types";
import { agentSource, companyMutationSchema, parseInput, SYSTEM_SOURCES } from "@/lib/crm/validation";
import { ASSISTANT_SOURCES } from "@/lib/assistant/source";
import { PROVIDER_IDS } from "@/lib/enrichment/providers";
import { EXTENSION_SOURCE } from "@/lib/extension/protocol";
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
    assert.equal(agentSource("e\u200bmail"), null);
    assert.equal(agentSource("\uff57\uff45\uff42"), null);
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

function enclosingObject(text: string, at: number) {
  let depth = 0;
  let open = -1;
  for (let index = at; index >= 0; index -= 1) {
    const char = text[index];
    if (char === "}") depth += 1;
    else if (char === "{") {
      if (depth === 0) {
        open = index;
        break;
      }
      depth -= 1;
    }
  }
  if (open < 0) return "";
  depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return text.slice(open, index + 1);
  }
  return "";
}

function provenanceSourcesInCode() {
  const used = new Map<string, string>();
  for (const file of ["lib", "app", "server"].flatMap(sourceFiles)) {
    const text = readFileSync(file, "utf8");
    for (const entry of text.matchAll(/\bsource:\s*([^,\n}]+)/g)) {
      if (!/\boperation\b/.test(enclosingObject(text, entry.index ?? 0))) continue;
      for (const literal of entry[1].matchAll(/(===\s*)?"([^"]*)"/g)) if (!literal[1]) used.set(literal[2], file);
    }
  }
  return used;
}

describe("system sources", () => {
  it("lists every source Orbit writes with an operation", () => {
    const used = provenanceSourcesInCode();
    for (const source of ["workflow", "granola", "microsoft", "web", "clickup", "communication", "mcp"]) assert.ok(used.has(source), source);
    const declared = [
      ...ASSISTANT_SOURCES,
      EXTENSION_SOURCE,
      ...NAMED_PROVENANCE_SOURCES,
      ...PROVIDER_IDS,
    ];
    const missing = [...new Set([...used.keys(), ...declared])].filter((source) => !(SYSTEM_SOURCES as readonly string[]).includes(source));
    assert.deepEqual(missing, []);
  });
});

describe("task approval cards", () => {
  it("never says a due day is cleared while giving one, and shows nothing cleared on a new task", () => {
    const update = describeAction("update_task", { taskId: "00000000-0000-4000-8000-000000000001", dueDate: "2027-03-01", dueAt: null });
    assert.ok(update.lines.includes("Due: Mon 1 Mar 2027"), update.lines.join("\n"));
    assert.ok(!update.lines.includes("Due: none"), update.lines.join("\n"));
    const cleared = describeAction("update_task", { taskId: "00000000-0000-4000-8000-000000000001", dueDate: null, dueAt: null, remindMinutes: null });
    assert.deepEqual(cleared.lines.filter((line) => line.endsWith(": none")), ["Due: none", "Reminder: none"]);
    const create = describeAction("create_task", { title: "Call Ann", dueDate: null, remindMinutes: null, description: null });
    assert.ok(!create.lines.some((line) => line.endsWith(": none")), create.lines.join("\n"));
  });

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
  it("sets an explicit midnight time on a date-only task, with a reminder in the same call", async () => {
    const task = (await createTask(eclipse, { title: "Midnight call", dueDate: "2027-03-01" })).body.task;
    const timed = (await updateTask(eclipse, task.id, { dueAt: "2027-03-01T00:00", dueHasTime: true, remindMinutes: 15 })).body.task;
    assert.equal(timed.dueHasTime, true);
    assert.equal(timed.remindMinutes, 15);
    const web = (await createTask(eclipse, { title: "Midnight web", dueDate: "2027-03-01" })).body.task;
    assert.equal((await updateTask(eclipse, web.id, { dueAt: localInstant("2027-03-01T00:00"), dueHasTime: true })).body.task.dueHasTime, true);
    const assisted = (await createTask(eclipse, { title: "Midnight assistant", dueDate: "2027-07-01" })).body.task;
    const out = (await runTool(eclipse, "update_task", { taskId: assisted.id, dueAt: "2027-07-01T00:00", dueHasTime: true })) as { task?: { dueHasTime: boolean } };
    assert.equal(out.task?.dueHasTime, true);
    const viaMcp = (await createTask(eclipse, { title: "Midnight MCP", dueDate: "2027-03-01" })).body.task;
    const moved = await mcp(eclipse, "update_next_action", { id: viaMcp.id, dueAt: "2027-03-01T00:00", dueHasTime: true });
    assert.equal(moved.json?.task?.dueHasTime, true);
  });

  it("refuses a reminder on a date-only task's own day start, before the card and in the API", async () => {
    const task = (await createTask(eclipse, { title: "Echo reminder", dueDate: "2027-07-01" })).body.task;
    const args = { taskId: task.id, dueAt: task.dueAt, remindMinutes: 15 };
    const refusal = await taskTimingRefusalFor(eclipse, "update_task", args);
    assert.deepEqual(refusal, { error: "That's the task's day with no time, so it can't have a reminder. Send dueHasTime true to set midnight.", field: "dueHasTime" });
    const out = (await runTool(eclipse, "update_task", args)) as { error?: string };
    assert.equal(out.error, refusal?.error);
    await assert.rejects(
      updateTask(eclipse, task.id, { dueAt: "2027-07-01T00:00+01:00", remindMinutes: 15 }),
      (error: unknown) => error instanceof CrmError && error.status === 400 && error.message === "This task has no time. Send dueHasTime: true to set one, then a reminder.",
    );
    assert.equal(await taskTimingRefusalFor(eclipse, "update_task", { ...args, dueHasTime: true }), null);
    const timed = (await runTool(eclipse, "update_task", { ...args, dueHasTime: true })) as { task?: { dueHasTime: boolean; remindMinutes: number | null } };
    assert.equal(timed.task?.dueHasTime, true);
    assert.equal(timed.task?.remindMinutes, 15);
  });

  it("keeps a date-only task date only when its own day start comes back in any format", async () => {
    const winter = (await createTask(eclipse, { title: "Echo winter", dueDate: "2027-03-01" })).body.task;
    const summer = (await createTask(eclipse, { title: "Echo summer", dueDate: "2027-07-01" })).body.task;
    assert.equal(summer.dueAt, "2027-06-30T23:00:00.000Z");
    for (const task of [winter, summer]) {
      const out = (await runTool(eclipse, "update_task", { taskId: task.id, dueAt: task.dueAt, title: `${task.title} renamed` })) as { task?: { dueHasTime: boolean; dueDate: string } };
      assert.equal(out.task?.dueHasTime, false, task.title);
      assert.equal(out.task?.dueDate, task.dueDate);
    }
    for (const dueAt of ["2027-07-01T00:00:00+01:00", "2027-06-30T23:00:00Z", "2027-06-30T23:00:00.000000+00:00"]) {
      const moved = await mcp(eclipse, "update_next_action", { id: summer.id, dueAt });
      assert.equal(moved.json?.task?.dueHasTime, false, dueAt);
    }
    const echoed = (await updateTask(eclipse, winter.id, { dueAt: winter.dueAt })).body.task;
    assert.equal(echoed.dueHasTime, false);
    const update = { taskId: summer.id, dueAt: summer.dueAt };
    const card = describeAction("update_task", update, await recordNames(eclipse, [update], ["update_task"]));
    assert.ok(card.lines.includes("Due: Thu 1 Jul 2027"), card.lines.join("\n"));
    const plain = describeAction("update_task", update);
    assert.ok(plain.lines.includes("Due: Thu 1 Jul 2027, 00:00"), plain.lines.join("\n"));
  });
});

describe("removing a member", () => {
  it("records a catch-up audit event and webhook for every record handed to the remover, done tasks included", async () => {
    const leaver = await createUser("sam@guards.test", "Sam Leaver");
    await addMember(eclipse.workspaceId, leaver.userId);
    const sam = inWorkspace(leaver, eclipse.workspaceId, "Eclipse", "member");
    const endpoint = await admin().query<{ id: string }>(
      "insert into crm.webhook_endpoints (workspace_id, url, secret, events) values ($1, 'https://hooks.guards.invalid/orbit', 'secret-value', '{company.updated,task.updated}') returning id",
      [eclipse.workspaceId],
    );
    const company = (await createCompany(sam, { name: "Sam's Accounts Ltd", ownerId: sam.userId })).body.company;
    const contact = (await upsertContact(sam, { firstName: "Lee", lastName: "Handover", email: "lee@handover.test", ownerId: sam.userId })).body.contact;
    const open = (await createTask(sam, { title: "Sam's call", dueAt: "2027-03-01T10:00", remindMinutes: 15 })).body.task;
    const done = (await createTask(sam, { title: "Sam's done call" })).body.task;
    await completeTask(sam, done.id);
    const bulk = await admin().query<{ id: string }>(
      "insert into crm.companies (workspace_id, name, normalized_name, owner_id) select $1, 'Bulk handover ' || n, 'bulk handover ' || n, $2 from generate_series(1, 400) as n returning id",
      [eclipse.workspaceId, sam.userId],
    );
    const workflowCount = async () => (await admin().query<{ total: number }>("select count(*)::int as total from crm.workflow_events where workspace_id = $1", [eclipse.workspaceId])).rows[0].total;
    const workflowsBefore = await workflowCount();
    const started = Date.now();
    await removeMember(eclipse, sam.userId, { operation: "remove_member", source: "web", sourceUrl: "/settings/team" });
    const took = Date.now() - started;
    await admin().query("update crm.webhook_endpoints set archived_at = now(), enabled = false where id = $1", [endpoint.rows[0].id]);
    assert.ok(took < 5000, `took ${took}ms`);

    const updated = (await audits(company.id)).find((row) => row.event_type === "company.updated");
    assert.ok(updated);
    assert.equal(updated.source, "web");
    const stored = await admin().query<{ source_url: string | null }>("select source_url from crm.audit_events where entity_id = $1 and event_type = 'company.updated'", [company.id]);
    assert.equal(stored.rows[0].source_url, "/settings/team");
    assert.deepEqual(updated.changes, { fields: ["ownerId"], before: { ownerId: sam.userId }, after: { ownerId: eclipse.userId } });
    assert.ok((await audits(contact.id)).some((row) => row.event_type === "contact.updated"));
    const taskEvent = (await audits(open.id)).find((row) => row.event_type === "task.updated");
    assert.ok(taskEvent);
    assert.deepEqual(taskEvent.changes.fields, ["ownerId", "dueAt", "dueHasTime", "scheduledBy", "remindMinutes"]);
    assert.deepEqual(taskEvent.changes.after, { ownerId: eclipse.userId, dueAt: "2027-03-01T00:00:00.000Z", dueHasTime: false, scheduledBy: null, remindMinutes: null });
    assert.equal((taskEvent.changes.before as Record<string, unknown>).dueAt, "2027-03-01T10:00:00.000Z");

    const handedDone = await admin().query<{ owner_id: string }>("select owner_id from crm.tasks where id = $1", [done.id]);
    assert.equal(handedDone.rows[0].owner_id, eclipse.userId);
    assert.ok((await audits(done.id)).some((row) => row.event_type === "task.updated"));

    const bulkEvents = await admin().query<{ total: number }>(
      "select count(*)::int as total from crm.audit_events where entity_id = any($1::uuid[]) and event_type = 'company.updated' and operation = 'remove_member'",
      [bulk.rows.map((row) => row.id)],
    );
    assert.equal(bulkEvents.rows[0].total, 400);
    const deliveries = await admin().query<{ total: number }>("select count(*)::int as total from crm.webhook_deliveries where endpoint_id = $1", [endpoint.rows[0].id]);
    assert.equal(deliveries.rows[0].total, 403);
    const payload = await admin().query<{ payload: Record<string, unknown> }>(
      "select d.payload from crm.webhook_deliveries d join crm.audit_events e on e.id = d.event_id where d.endpoint_id = $1 and e.entity_id = $2",
      [endpoint.rows[0].id, company.id],
    );
    assert.equal(payload.rows[0].payload.type, "company.updated");
    assert.deepEqual(payload.rows[0].payload.entity, { type: "company", id: company.id });
    assert.deepEqual(payload.rows[0].payload.data, updated.changes);
    assert.equal(payload.rows[0].payload.sourceUrl, "/settings/team");
    assert.equal(await workflowCount(), workflowsBefore);
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

describe("tagging from a task discussion", () => {
  it("writes the tag's audit event in the task's own workspace, even when posted from another", async () => {
    const helper = await createUser("dana@guards.test", "Dana Helper");
    await addMember(ridgeon.workspaceId, helper.userId);
    const task = (await createTask(ridgeon, { title: "Ridgeon discussion" })).body.task;
    const { conversationId } = await openDiscussion(ridgeon, { kind: "task", id: task.id });
    await postMessage(eclipse, { conversationId, body: `Can you look? @[Dana Helper](member:${helper.userId})` });
    const tagged = (await audits(task.id)).filter((row) => row.event_type === "task.participant_added");
    assert.equal(tagged.length, 1);
    assert.equal(tagged[0].workspace_id, ridgeon.workspaceId);
    assert.equal((await admin().query("select 1 from crm.audit_events where entity_id = $1 and workspace_id = $2", [task.id, eclipse.workspaceId])).rowCount, 0);
  });
});

describe("assistant unassigning", () => {
  it("unassigns a task when the assistant sends ownerId null, and the card says so", async () => {
    const task = (await createTask(eclipse, { title: "Hand back", ownerId: priya.userId })).body.task;
    assert.equal(task.ownerId, priya.userId);
    const card = describeAction("update_task", { taskId: task.id, ownerId: null });
    assert.ok(card.lines.includes("Owner: none"), card.lines.join("\n"));
    const out = (await runTool(eclipse, "update_task", { taskId: task.id, ownerId: null })) as { error?: string; task?: { ownerId: string | null } };
    assert.equal(out.error, undefined);
    assert.equal(out.task?.ownerId, null);
    assert.equal((await getTask(eclipse, task.id)).ownerId, null);
  });
});

describe("unassign card", () => {
  it("tells a member who unassigns a task someone else made that they can't change it after", async () => {
    const task = (await createTask(eclipse, { title: "Priya's to hand back", ownerId: priya.userId })).body.task;
    const args = { taskId: task.id, ownerId: null };
    const card = describeAction("update_task", args, await recordNames(priya, [args], ["update_task"]));
    assert.ok(card.lines.includes("Owner: none"), card.lines.join("\n"));
    assert.ok(card.lines.includes("You'll stay tagged but can't change it."), card.lines.join("\n"));
    const ownerCard = describeAction("update_task", args, await recordNames(eclipse, [args], ["update_task"]));
    assert.ok(!ownerCard.lines.includes("You'll stay tagged but can't change it."), ownerCard.lines.join("\n"));
    await runTool(priya, "update_task", args);
    const after = await getTask(priya, task.id);
    assert.equal(after.ownerId, null);
  });
});

describe("tagging in another workspace", () => {
  it("lets an admin-only token tag where its person is a member", async () => {
    const person = await createUser("adminonly@guards.test", "Admin Only");
    await addMember(ridgeon.workspaceId, person.userId);
    const helper = await createUser("adminhelper@guards.test", "Admin Helper");
    await addMember(ridgeon.workspaceId, helper.userId);
    const task = (await createTask(ridgeon, { title: "Admin only tag", ownerId: person.userId })).body.task;
    const token: UserActor = { ...person, scopes: ["admin"] };
    const fresh = await withActor(token, (db) => addTaskParticipantsInDb(db, token, task.id, [helper.userId]));
    assert.deepEqual(fresh, [helper.userId]);
  });

  it("keeps the caller's own scopes rather than the role's there", async () => {
    const helper = await createUser("scoped@guards.test", "Scoped Helper");
    await addMember(ridgeon.workspaceId, helper.userId);
    const task = (await createTask(ridgeon, { title: "Scoped tag" })).body.task;
    const readOnly: UserActor = { ...eclipse, scopes: ["crm:read"] };
    await assert.rejects(
      withActor(readOnly, (db) => addTaskParticipantsInDb(db, readOnly, task.id, [helper.userId])),
      (error: unknown) => error instanceof CrmError && error.status === 403,
    );
    assert.equal((await admin().query("select 1 from crm.task_participants where task_id = $1", [task.id])).rowCount, 0);
  });
});
