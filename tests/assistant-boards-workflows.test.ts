import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { listBoards } from "@/lib/crm/boards";
import { createCompany } from "@/lib/crm/companies";
import { createOpportunity, listOpportunities, listPipeline } from "@/lib/crm/opportunities";
import type { UserActor } from "@/lib/crm/types";
import { scopesForRole } from "@/lib/crm/scopes";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { getWorkflow } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

type Stage = { id: string; name: string; probability?: number; isWon?: boolean; isLost?: boolean };
type Board = { id: string; name: string; addOnWon: boolean; stages: Stage[] };
type WorkflowResult = {
  workflow: { id: string; name: string; status: string; shared: boolean; trigger: { type: string }; nodes: { id: string; type: string }[]; edges: unknown[] };
};

describe("assistant board and workflow tools", () => {
  let owner: UserActor;
  let colleague: UserActor;
  let acme: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("assistant-boards@orbit.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const sam = (await admin.query<{ id: string }>("select private.create_local_user('sam@assistant.test', 'password-123', 'Sam Taylor') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    colleague = { ...owner, userId: sam, email: "sam@assistant.test", fullName: "Sam Taylor", role: "member", scopes: scopesForRole("member") };
    acme = (await createCompany(owner, { name: "Acme Tools", domain: "acme-tools.test" })).body.company.id;
  });

  after(async () => {
    await getPool().end();
  });

  it("creates, renames and restructures a board and moves its cards", async () => {
    const created = (await runTool(owner, "create_board", { name: "Onboarding", stages: ["Kickoff", "New stage", "Established"], addOnWon: true })) as {
      board: Board;
    };
    assert.equal(created.board.name, "Onboarding");
    assert.equal(created.board.addOnWon, true);
    assert.deepEqual(
      created.board.stages.map((stage) => stage.name),
      ["Kickoff", "New stage", "Established"],
    );
    const boardId = created.board.id;
    const [kickoff, unnamed, established] = created.board.stages;

    const renamed = (await runTool(owner, "update_board", { boardId, name: "Client onboarding", addOnWon: false })) as { board: Board };
    assert.equal(renamed.board.name, "Client onboarding");
    assert.equal(renamed.board.addOnWon, false);

    const args = {
      boardId,
      stages: [
        { id: kickoff.id, name: "Kickoff" },
        { name: "Month 1: First content" },
        { id: unnamed.id, name: "Month 2: Adoption" },
        { id: established.id, name: "Established" },
        { name: "Churned" },
      ],
    };
    const names = await recordNames(owner, [args]);
    assert.deepEqual(describeAction("set_board_stages", args, names), {
      title: "Change stages: Client onboarding",
      lines: ["1. Kickoff", "2. Month 1: First content (new)", "3. Month 2: Adoption (was New stage)", "4. Established", "5. Churned (new)"],
    });
    const saved = (await runTool(owner, "set_board_stages", args)) as { stages: Stage[] };
    assert.deepEqual(
      saved.stages.map((stage) => stage.name),
      ["Kickoff", "Month 1: First content", "Month 2: Adoption", "Established", "Churned"],
    );
    assert.equal(saved.stages[2].id, unnamed.id);

    const card = (await createOpportunity(owner, { companyId: acme, pipelineId: boardId })).body.opportunity;
    assert.equal(describeAction("move_card", { cardId: card.id }, await recordNames(owner, [{ cardId: card.id }])).title, `Move card: ${card.name}`);
    const moved = (await runTool(owner, "move_card", { cardId: card.id, stageId: established.id })) as { card: { stageId: string } };
    assert.equal(moved.card.stageId, established.id);
    const blocked = (await runTool(owner, "set_board_stages", { boardId, stages: [{ id: kickoff.id, name: "Kickoff" }] })) as { error: string };
    assert.match(blocked.error, /Move cards off a stage/);

    await runTool(owner, "remove_from_board", { cardId: card.id });
    assert.equal((await listOpportunities(owner, { pipelineId: boardId })).data.length, 0);

    await runTool(owner, "delete_board", { boardId });
    assert.deepEqual(await listBoards(owner), []);
  });

  it("renames Opportunities stages and keeps their probabilities", async () => {
    const before = await listPipeline(owner);
    const working = before.stages.find((stage) => stage.name === "Working")!;
    const stages = before.stages.map((stage) => ({
      id: stage.id,
      name: stage.id === working.id ? "Qualified" : stage.name,
      isWon: stage.isWon,
      isLost: stage.isLost,
    }));
    const saved = (await runTool(owner, "set_board_stages", { stages })) as { stages: Stage[] };
    assert.deepEqual(
      saved.stages.map((stage) => stage.name),
      ["New", "Qualified", "Proposal", "Won", "Lost"],
    );
    const after = await listPipeline(owner);
    assert.deepEqual(
      after.stages.map((stage) => stage.probability),
      before.stages.map((stage) => stage.probability),
    );
    assert.equal(describeAction("set_board_stages", { stages }).title, "Change Opportunities stages");
  });

  it("builds, edits, tests, shares and deletes a workflow", async () => {
    const listed = (await runTool(owner, "list_workflows", {})) as { starterTemplates: { key: string }[] };
    assert.deepEqual(
      listed.starterTemplates.map((item) => item.key),
      ["at-risk-follow-up", "requests-to-linear", "job-changes", "bounce-check"],
    );

    const fromTemplate = (await runTool(owner, "create_workflow", { template: "requests-to-linear", name: "Health check" })) as WorkflowResult;
    assert.equal(fromTemplate.workflow.name, "Health check");
    assert.equal(fromTemplate.workflow.trigger.type, "call_summary_ready");
    assert.deepEqual(
      fromTemplate.workflow.nodes.map((node) => node.type),
      ["ai", "if", "approval", "loop", "linear_issue"],
    );

    const definition = {
      trigger: { type: "manual", object: "company" },
      steps: [
        { id: "filter_1", type: "filter", config: { match: "all", conditions: [{ left: "{{company.name}}", op: "is_not_empty" }] } },
        {
          id: "if_1",
          type: "if",
          label: "Acme?",
          config: { match: "all", conditions: [{ left: "{{company.name}}", op: "contains", right: "Acme" }] },
          then: [{ id: "notify_1", type: "notify", config: { to: "owner", title: "{{company.name}} checked" } }],
          else: [{ id: "add_note_1", type: "add_note", config: { body: "Not Acme" } }],
        },
      ],
    };
    const createArgs = { name: "Check a company", definition };
    assert.deepEqual(describeAction("create_workflow", createArgs), {
      title: "Create workflow: Check a company",
      lines: ["Steps: filter, Acme?"],
    });
    const built = (await runTool(owner, "create_workflow", createArgs)) as WorkflowResult;
    const workflowId = built.workflow.id;
    assert.equal(built.workflow.status, "draft");
    assert.deepEqual(built.workflow.edges, [
      { source: "trigger", handle: "out", target: "filter_1" },
      { source: "filter_1", handle: "out", target: "if_1" },
      { source: "if_1", handle: "true", target: "notify_1" },
      { source: "if_1", handle: "false", target: "add_note_1" },
    ]);

    const broken = (await runTool(owner, "update_workflow", { workflowId, definition: { trigger: { type: "manual", object: "company" }, steps: [{ id: "x", type: "nope", config: {} }] } })) as {
      error: string;
    };
    assert.ok(broken.error);

    const tested = (await runTool(owner, "test_workflow", { workflowId, recordType: "company", recordId: acme })) as {
      status: string;
      steps: { stepId: string; status: string }[];
    };
    assert.equal(tested.status, "succeeded");
    assert.deepEqual(
      tested.steps.map((step) => step.stepId),
      ["filter_1", "if_1", "notify_1"],
    );

    const refused = (await runTool(owner, "run_workflow", { workflowId, recordType: "company", recordId: acme })) as { error: string };
    assert.match(refused.error, /Turn the workflow on first/);
    const on = (await runTool(owner, "set_workflow_status", { workflowId, on: true })) as WorkflowResult;
    assert.equal(on.workflow.status, "active");
    const ran = (await runTool(owner, "run_workflow", { workflowId, recordType: "company", recordId: acme })) as { status: string };
    assert.equal(ran.status, "succeeded");

    const read = (await runTool(owner, "get_workflow", { workflowId })) as { runs: { test: boolean }[] };
    assert.equal(read.runs.length, 2);

    const renamed = (await runTool(owner, "update_workflow", { workflowId, name: "Company check" })) as WorkflowResult;
    assert.equal(renamed.workflow.name, "Company check");
    assert.equal(renamed.workflow.nodes.length, 4);

    const shared = (await runTool(owner, "share_workflow", { workflowId, shared: true })) as WorkflowResult;
    assert.equal(shared.workflow.shared, true);
    const forColleague = (await runTool(colleague, "list_workflows", {})) as { sharedTemplates: { id: string; sharedBy: string }[] };
    assert.equal(forColleague.sharedTemplates[0].id, workflowId);
    const denied = (await runTool(colleague, "update_workflow", { workflowId, name: "Mine now" })) as { error: string };
    assert.match(denied.error, /Only the person who built this workflow/);
    const copy = (await runTool(colleague, "create_workflow", { template: workflowId })) as WorkflowResult;
    assert.equal(copy.workflow.name, "Company check");

    assert.equal(describeAction("delete_workflow", { workflowId }, await recordNames(owner, [{ workflowId }])).title, "Delete workflow: Company check");
    await runTool(owner, "delete_workflow", { workflowId });
    await assert.rejects(getWorkflow(owner, workflowId), /not found/i);
  });

  it("answers workflow approvals", async () => {
    const built = (await runTool(owner, "create_workflow", {
      name: "Approve first",
      definition: {
        trigger: { type: "manual", object: "company" },
        steps: [
          { id: "approval_1", type: "approval", config: { title: "Add a note to {{company.name}}?" } },
          { id: "add_note_1", type: "add_note", config: { body: "Approved" } },
        ],
      },
    })) as WorkflowResult;
    await runTool(owner, "set_workflow_status", { workflowId: built.workflow.id, on: true });
    const ran = (await runTool(owner, "run_workflow", { workflowId: built.workflow.id, recordType: "company", recordId: acme })) as { runId: string; status: string };
    assert.equal(ran.status, "waiting");
    const waiting = (await runTool(owner, "list_workflow_approvals", {})) as { approvals: { runId: string; title: string }[] };
    assert.equal(waiting.approvals[0].title, "Add a note to Acme Tools?");
    const decided = (await runTool(owner, "decide_workflow_approval", { runId: ran.runId, approve: true })) as { status: string };
    assert.equal(decided.status, "succeeded");
    const run = (await runTool(owner, "get_workflow_run", { runId: ran.runId })) as { run: { status: string } };
    assert.equal(run.run.status, "succeeded");
  });
});
