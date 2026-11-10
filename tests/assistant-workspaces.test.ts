import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PROPOSED, type CompanionResult } from "@/companion/src/protocol";
import { applyCompanionResult, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { systemPrompt } from "@/lib/assistant/prompt";
import { ASSISTANT_TOOLS, WORKSPACE_READ_TOOLS, crossWorkspaceRefusal, runTool } from "@/lib/assistant/tools";
import { createBoard } from "@/lib/crm/boards";
import { runCaptureAction } from "@/lib/crm/capture-actions";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { createWorkflow, decideApproval, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { createUser, messageText, resetDatabase } from "./helpers";

type Labelled = { workspace: { id: string; name: string }; note?: string; current?: boolean; error?: string };
type Found = Labelled & { companies?: { id: string; name: string }[]; data?: { id: string; title?: string }[]; company?: { id: string; name: string } };

function gateway(replies: { content?: string; calls?: { id: string; name: string; args: Record<string, unknown> }[] }[]) {
  const requests: { messages: { role: string; content: unknown; tool_call_id?: string }[]; tools: { function: { name: string; parameters: { properties?: Record<string, unknown> } } }[] }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const reply = replies.shift() ?? { content: "Done." };
    return Response.json({
      model: "claude-sonnet-5-5",
      choices: [
        {
          message: {
            role: "assistant",
            content: reply.content ?? "",
            tool_calls: reply.calls?.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function inWorkspace(actor: UserActor, id: string, name: string, role: UserActor["role"] = "owner"): UserActor {
  return { ...actor, workspaceId: id, workspaceName: name, role, scopes: scopesForRole(role) };
}

describe("assistant across workspaces", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;
  let priya: UserActor;
  let acme: string;
  let consulting: string;

  before(async () => {
    await resetDatabase();
    const admin = getAdminPool();
    const mark = await createUser("mark@ws-assistant.test", "Mark Ridgeon");
    await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    eclipse = { ...mark, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
    ridgeon = inWorkspace(eclipse, created.id, "Mark Ridgeon");
    const person = await createUser("priya@ws-assistant.test", "Priya Shah");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [eclipse.workspaceId, person.userId]);
    await admin.query("delete from crm.workspace_members where user_id = $1 and workspace_id <> $2", [person.userId, eclipse.workspaceId]);
    priya = inWorkspace(person, eclipse.workspaceId, "Eclipse", "member");
    acme = (await createCompany(eclipse, { name: "Acme Analytics", domain: "acme-analytics.test" })).body.company.id;
    consulting = (await createCompany(ridgeon, { name: "Acme Consulting", domain: "acme-consulting.test" })).body.company.id;
    await createContact(ridgeon, { firstName: "Rosa", lastName: "Lane", email: "rosa@acme-consulting.test", companyId: consulting });
    await createTask(ridgeon, { title: "Send the Acme Consulting retainer", companyId: consulting });
    await createTask(eclipse, { title: "Book the Acme Analytics demo", companyId: acme });
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("adds the workspace parameter to the main read tools only", () => {
    const withParam = ASSISTANT_TOOLS.filter((tool) => "workspace" in ((tool.parameters.properties ?? {}) as object)).map((tool) => tool.name).sort();
    assert.deepEqual(withParam, [...WORKSPACE_READ_TOOLS].sort());
    for (const name of ["get_overview", "get_pipeline", "get_board", "list_quiet_relationships", "search_records", "get_company"]) assert.ok(withParam.includes(name), name);
    assert.ok(ASSISTANT_TOOLS.every((tool) => !tool.write || !("workspace" in ((tool.parameters.properties ?? {}) as object))));
    assert.ok(ASSISTANT_TOOLS.length <= 126);
  });

  it("reads the current workspace by default, exactly as before", async () => {
    const found = (await runTool(eclipse, "search_records", { query: "Acme" })) as Found;
    assert.equal(found.workspace, undefined);
    assert.deepEqual(found.companies?.map((item) => item.name), ["Acme Analytics"]);
    const same = (await runTool(eclipse, "search_records", { query: "Acme", workspace: "Eclipse" })) as Found;
    assert.equal(same.workspace, undefined);
    assert.deepEqual(same.companies?.map((item) => item.name), ["Acme Analytics"]);
  });

  it("reads one other workspace by name, labelled with it", async () => {
    const found = (await runTool(eclipse, "search_records", { query: "Acme", workspace: "mark ridgeon" })) as Found;
    assert.deepEqual(found.workspace, { id: ridgeon.workspaceId, name: "Mark Ridgeon" });
    assert.deepEqual(found.companies?.map((item) => item.name), ["Acme Consulting"]);
    assert.match(found.note ?? "", /switch to Mark Ridgeon in the sidebar/);
    const partial = (await runTool(eclipse, "list_tasks", { workspace: "Ridgeon" })) as Found;
    assert.equal(partial.workspace.name, "Mark Ridgeon");
    assert.deepEqual(partial.data?.map((item) => item.title), ["Send the Acme Consulting retainer"]);
    const byId = (await runTool(eclipse, "list_contacts", { workspace: ridgeon.workspaceId })) as Found;
    assert.equal(byId.workspace.name, "Mark Ridgeon");
    assert.equal(byId.data?.length, 1);
  });

  it("reads every workspace with all, one labelled result each", async () => {
    const found = (await runTool(eclipse, "list_companies", { workspace: "all" })) as { workspaces: Found[] };
    assert.deepEqual(found.workspaces.map((item) => item.workspace.name), ["Eclipse", "Mark Ridgeon"]);
    assert.equal(found.workspaces[0].current, true);
    assert.deepEqual(found.workspaces[0].data?.map((item) => item.id), [acme]);
    assert.deepEqual(found.workspaces[1].data?.map((item) => item.id), [consulting]);
    assert.match(found.workspaces[1].note ?? "", /Mark Ridgeon/);

    const one = (await runTool(eclipse, "get_company", { companyId: consulting, workspace: "all" })) as { workspaces: Found[] };
    assert.deepEqual(one.workspaces.map((item) => item.workspace.name), ["Mark Ridgeon"]);
    assert.equal(one.workspaces[0].company?.name, "Acme Consulting");

    const missing = (await runTool(eclipse, "get_company", { companyId: "00000000-0000-4000-8000-000000000999", workspace: "all" })) as { error?: string };
    assert.ok(missing.error);
  });

  it("refuses a workspace the person isn't in, by name or id", async () => {
    const byName = (await runTool(priya, "search_records", { query: "Acme", workspace: "Mark Ridgeon" })) as { error?: string };
    assert.match(byName.error ?? "", /not in a workspace called Mark Ridgeon\. Your workspaces are Eclipse\./);
    const byId = (await runTool(priya, "list_companies", { workspace: ridgeon.workspaceId })) as { error?: string };
    assert.match(byId.error ?? "", /not in a workspace/);
    const all = (await runTool(priya, "list_companies", { workspace: "all" })) as Found & { workspaces?: unknown };
    assert.equal(all.workspaces, undefined);
    assert.deepEqual(all.data?.map((item) => item.id), [acme]);
    const direct = (await runTool(priya, "get_company", { companyId: consulting })) as { error?: string };
    assert.ok(direct.error);
  });

  it("refuses changes to another workspace's records and keeps them unchanged", async () => {
    const byId = (await runTool(eclipse, "update_company", { companyId: consulting, name: "Changed" })) as { error?: string };
    assert.match(byId.error ?? "", /That company is in Mark Ridgeon/);
    assert.match(byId.error ?? "", /Switch to Mark Ridgeon in the sidebar/);
    assert.equal((await getCompany(ridgeon, consulting)).name, "Acme Consulting");

    const byArg = (await runTool(eclipse, "create_task", { title: "Call Rosa", workspace: "Mark Ridgeon" })) as { error?: string };
    assert.match(byArg.error ?? "", /Switch to Mark Ridgeon/);
    const everywhere = (await runTool(eclipse, "create_task", { title: "Call Rosa", workspace: "all" })) as { error?: string };
    assert.match(everywhere.error ?? "", /one workspace at a time/);

    assert.equal(await crossWorkspaceRefusal(eclipse, "update_company", { companyId: acme, name: "Acme Analytics Ltd" }), null);
    assert.equal(await crossWorkspaceRefusal(eclipse, "get_company", { companyId: consulting }), null);
    assert.match((await crossWorkspaceRefusal(eclipse, "update_contact", { contactIds: [consulting] })) ?? "", /Mark Ridgeon/);
  });

  it("shows no approval card for a change to another workspace from Orbit Agent", async () => {
    const admin = getAdminPool();
    const conversation = (
      await admin.query<{ id: string }>(
        "insert into crm.assistant_conversations (workspace_id, user_id, title, model, reasoning, web_search) values ($1, $2, 'Across', 'claude/claude-fable-5-1', 'medium', false) returning id",
        [eclipse.workspaceId, eclipse.userId],
      )
    ).rows[0].id;
    const result: CompanionResult = {
      steps: [
        {
          text: "I'll rename both.",
          calls: [
            { id: "call-other", name: "update_company", arguments: JSON.stringify({ companyId: consulting, name: "Changed" }) },
            { id: "call-here", name: "update_company", arguments: JSON.stringify({ companyId: acme, name: "Acme Analytics Ltd" }) },
          ],
        },
      ],
      results: { "call-other": { content: PROPOSED, isError: false }, "call-here": { content: PROPOSED, isError: false } },
      sources: [],
      model: "claude-fable-5-1",
      usage: null,
    };
    await applyCompanionResult(eclipse, conversation, result);
    const rows = (
      await admin.query<{ role: string; content: string; actions: { id: string }[] | null; tool_call_id: string | null }>(
        "select role, content, actions, tool_call_id from crm.assistant_messages where conversation_id = $1 order by seq",
        [conversation],
      )
    ).rows;
    const assistant = rows.find((row) => row.role === "assistant")!;
    assert.deepEqual(assistant.actions?.map((action) => action.id), ["call-here"]);
    assert.match(assistant.content, /That company is in Mark Ridgeon/);
    const refused = rows.find((row) => row.role === "tool" && row.tool_call_id === "call-other");
    assert.match(refused?.content ?? "", /Switch to Mark Ridgeon/);
  });

  it("hands a change to another workspace back to the model instead of a card, and tells it the workspaces", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway([
      { calls: [{ id: "call_cross", name: "update_company", args: { companyId: consulting, name: "Changed" } }] },
      { content: "That company is in Mark Ridgeon. Switch to it in the sidebar and ask again." },
    ]);
    const events: AssistantEvent[] = [];
    try {
      await sendMessage(eclipse, { message: "Rename Acme Consulting", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, (event) => events.push(event), {
        deadline: Date.now() + 120_000,
        fetchImpl: fake.fetchImpl,
      });
    } finally {
      delete process.env.LLM_API_KEY;
    }
    assert.ok(!events.some((event) => event.type === "actions"));
    assert.equal(fake.requests.length, 2);
    const system = messageText(fake.requests[0].messages[0].content);
    assert.match(system, /The user is working in Eclipse\. They are also in Mark Ridgeon\./);
    const searchTool = fake.requests[0].tools.find((tool) => tool.function.name === "search_records");
    assert.ok(searchTool?.function.parameters.properties?.workspace);
    const result = fake.requests[1].messages.find((message) => message.role === "tool" && message.tool_call_id === "call_cross");
    assert.match(messageText(result?.content), /That company is in Mark Ridgeon/);
    assert.equal((await getCompany(ridgeon, consulting)).name, "Acme Consulting");
  });

  it("tells the model which workspaces exist only when there are several", () => {
    const workspaces = [
      { id: eclipse.workspaceId, name: "Eclipse" },
      { id: ridgeon.workspaceId, name: "Mark Ridgeon" },
    ];
    const prompt = systemPrompt(eclipse, { workspaces });
    assert.match(prompt, /# Workspaces\nThe user is working in Eclipse\. They are also in Mark Ridgeon\./);
    assert.match(prompt, /pass workspace to one of get_overview, search_records/);
    assert.match(prompt, /Changes only happen in Eclipse/);
    assert.doesNotMatch(prompt, /[\u2013\u2014]/);
    assert.doesNotMatch(systemPrompt(eclipse, { workspaces: workspaces.slice(0, 1) }), /# Workspaces/);
    assert.doesNotMatch(systemPrompt(priya), /# Workspaces/);
  });

  it("reads the pipeline, boards, quiet relationships and overview of another workspace", async () => {
    const pipeline = (await runTool(eclipse, "get_pipeline", { workspace: "Mark Ridgeon" })) as Found & { stages?: unknown[] };
    assert.equal(pipeline.workspace.name, "Mark Ridgeon");
    assert.ok(Array.isArray(pipeline.stages));
    const quiet = (await runTool(eclipse, "list_quiet_relationships", { workspace: "Mark Ridgeon" })) as Found;
    assert.equal(quiet.workspace.name, "Mark Ridgeon");
    const overview = (await runTool(eclipse, "get_overview", { workspace: "all" })) as { workspaces: Found[] };
    assert.deepEqual(overview.workspaces.map((item) => item.workspace.name), ["Eclipse", "Mark Ridgeon"]);
    const board = await createBoard(ridgeon, { name: "Retainers" });
    const one = (await runTool(eclipse, "get_board", { boardId: board.id, workspace: "all" })) as { workspaces: (Found & { name?: string })[] };
    assert.deepEqual(one.workspaces.map((item) => [item.workspace.name, item.name]), [["Mark Ridgeon", "Retainers"]]);
  });

  it("says which tools can read another workspace when another tool is given one", async () => {
    const refused = (await runTool(eclipse, "list_team_members", { workspace: "Mark Ridgeon" })) as { error?: string; members?: unknown };
    assert.equal(refused.members, undefined);
    assert.match(refused.error ?? "", /Only these tools can read another workspace: .*get_pipeline/);
    const everywhere = (await runTool(eclipse, "list_team_members", { workspace: "all" })) as { error?: string };
    assert.match(everywhere.error ?? "", /Only these tools/);
    const here = (await runTool(eclipse, "list_team_members", { workspace: "Eclipse" })) as { error?: string; members?: unknown };
    assert.equal(here.error, undefined);
    assert.ok(Array.isArray(here.members));
  });

  it("refuses a write to all workspaces from someone in one workspace", async () => {
    const refused = (await runTool(priya, "create_task", { title: "Everywhere", workspace: "all" })) as { error?: string };
    assert.match(refused.error ?? "", /one workspace at a time/);
    assert.match((await crossWorkspaceRefusal(priya, "create_task", { title: "Everywhere", workspace: "all" })) ?? "", /one workspace at a time/);
  });

  it("only answers a workflow approval in the run's own workspace", async () => {
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "manual", object: "company" },
      triggerPosition: { x: 0, y: 0 },
      nodes: [{ id: "approval_1", type: "approval", config: { title: "Send the retainer to {{company.name}}?", details: "" }, position: { x: 0, y: 0 } }],
      edges: [{ source: "trigger", handle: "out", target: "approval_1" }],
    };
    const workflow = await createWorkflow(ridgeon, { name: "Retainer check" });
    await saveWorkflow(ridgeon, workflow.id, { definition });
    await setWorkflowStatus(ridgeon, workflow.id, "active");
    const waiting = async () => {
      const started = await startRun(ridgeon, workflow.id, { test: false, record: { type: "company", id: consulting } });
      assert.equal(started.status, "waiting");
      return started.runId;
    };

    const first = await waiting();
    assert.match((await crossWorkspaceRefusal(eclipse, "decide_workflow_approval", { runId: first, approve: true })) ?? "", /That workflow run is in Mark Ridgeon/);
    const refused = (await runTool(eclipse, "decide_workflow_approval", { runId: first, approve: true })) as { error?: string };
    assert.match(refused.error ?? "", /That workflow run is in Mark Ridgeon.*Switch to Mark Ridgeon in the sidebar/);
    await assert.rejects(decideApproval(eclipse, first, { approved: true }), /This approval is in Mark Ridgeon\. Switch to Mark Ridgeon in the sidebar/);
    const state = await getAdminPool().query<{ status: string; workspace_id: string }>("select status, workspace_id from crm.workflow_runs where id = $1", [first]);
    assert.deepEqual(state.rows[0], { status: "waiting", workspace_id: ridgeon.workspaceId });

    const decided = (await runTool(ridgeon, "decide_workflow_approval", { runId: first, approve: true })) as { status?: string; error?: string };
    assert.equal(decided.error, undefined);
    assert.equal(decided.status, "succeeded");

    const second = await waiting();
    await runCaptureAction(eclipse, { kind: "approve", runId: second });
    const run = await getAdminPool().query<{ status: string }>("select status from crm.workflow_runs where id = $1", [second]);
    assert.equal(run.rows[0].status, "succeeded");
  });
});
