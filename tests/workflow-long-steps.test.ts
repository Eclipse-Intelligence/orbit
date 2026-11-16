import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { LONG_TICK_MS, runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, saveWorkflow, setWorkflowStatus } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

const RESEARCH: WorkflowDefinition = {
  version: 2,
  trigger: { type: "schedule", frequency: "weekly", weekday: 1, time: "07:30" },
  triggerPosition: { x: 0, y: 0 },
  nodes: [
    { id: "find_records_1", type: "find_records", label: "Agency leads", config: { object: "company", tag: "agency", lifecycles: ["lead"], limit: 10 }, position: { x: 0, y: 0 } },
    { id: "loop_1", type: "loop", label: "Each agency", config: { items: "{{steps.find_records_1.records}}", limit: 10 }, position: { x: 0, y: 0 } },
    {
      id: "ai_1",
      type: "ai",
      label: "Research the agency",
      config: { prompt: "Research {{company.name}}.", webSearch: true, outputs: [{ key: "fit", type: "number", description: "Fit." }] },
      position: { x: 0, y: 0 },
    },
    { id: "add_note_1", type: "add_note", label: "Note", config: { title: "Fit {{steps.ai_1.fit}}", body: "Researched." }, position: { x: 0, y: 0 } },
  ],
  edges: [
    { source: "trigger", target: "find_records_1", handle: "out" },
    { source: "find_records_1", target: "loop_1", handle: "out" },
    { source: "loop_1", target: "ai_1", handle: "each" },
    { source: "ai_1", target: "add_note_1", handle: "out" },
  ],
} as unknown as WorkflowDefinition;

function gateway(failFor: string[] = []) {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const user = String(body.messages?.[1]?.content ?? "");
    asked.push(user);
    if (failFor.some((name) => user.includes(`Research ${name}.`))) return Response.json({ error: { message: "upstream timed out" } }, { status: 504 });
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ fit: 80 }) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, asked };
}

async function runOf(workflowId: string) {
  const result = await getAdminPool().query<{ id: string; status: string; error: string | null; needs_time: string | null }>(
    "select id, status, error, state->>'needsTime' as needs_time from crm.workflow_runs where workflow_id = $1 order by created_at desc limit 1",
    [workflowId],
  );
  return result.rows[0];
}

describe("workflow steps that need more time", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@long.test", "Mark Ridgeon");
    for (const name of ["Alpha Agency", "Beta Agency", "Gamma Agency"]) {
      await createCompany(owner, { name, lifecycle: "lead", tags: ["agency"] });
    }
  });

  beforeEach(() => {
    process.env.LLM_API_KEY = "test-llm-key";
  });

  after(async () => {
    await getPool().end();
  });

  async function scheduled() {
    const workflow = await createWorkflow(owner, { name: `Research ${Math.random()}` });
    await saveWorkflow(owner, workflow.id, { definition: RESEARCH });
    await setWorkflowStatus(owner, workflow.id, "active");
    await getAdminPool().query("update crm.workflows set next_run_at = now() - interval '1 minute' where id = $1", [workflow.id]);
    return workflow.id;
  }

  it("leaves a web research step to the long workflow job instead of starting it with too little time", async () => {
    const workflowId = await scheduled();
    const ai = gateway();
    await runWorkflowTick({ fetchImpl: ai.fetchImpl, budgetMs: 30_000 });
    assert.equal(ai.asked.length, 0, "a short slot never starts the research");
    let run = await runOf(workflowId);
    assert.equal(run.status, "queued");
    assert.equal(run.needs_time, "true");

    const started = Date.now();
    await runWorkflowTick({ fetchImpl: ai.fetchImpl, budgetMs: 30_000 });
    assert.equal(ai.asked.length, 0, "short slots skip it rather than claim it again");
    assert.ok(Date.now() - started < 10_000, "a short slot doesn't spin on it");

    await runWorkflowTick({ fetchImpl: ai.fetchImpl, budgetMs: LONG_TICK_MS, long: true });
    run = await runOf(workflowId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.error, null);
    assert.equal(ai.asked.length, 3);
  });

  it("tries a failed research step again after a minute, then skips that agency and carries on", async () => {
    const workflowId = await scheduled();
    const ai = gateway(["Beta Agency"]);
    await runWorkflowTick({ fetchImpl: ai.fetchImpl, budgetMs: LONG_TICK_MS, long: true });
    let run = await runOf(workflowId);
    assert.equal(run.status, "waiting", "the first failure waits to try again");

    await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 second' where id = $1", [run.id]);
    await runWorkflowTick({ fetchImpl: ai.fetchImpl, budgetMs: LONG_TICK_MS, long: true });
    run = await runOf(workflowId);
    assert.equal(run.status, "succeeded");
    assert.match(run.error ?? "", /^Skipped 1: Beta Agency \(/);
    assert.equal(ai.asked.filter((text) => text.includes("Research Beta Agency.")).length, 2, "tried twice, not more");
    assert.equal(ai.asked.filter((text) => text.includes("Research Alpha Agency.") || text.includes("Research Gamma Agency.")).length, 2, "the others are researched");

    const notes = await getAdminPool().query<{ title: string }>(
      "select title from crm.notifications where user_id = $1 and title like '%finished with 1 skipped'",
      [owner.userId],
    );
    assert.equal(notes.rows.length, 1);
  });
});
