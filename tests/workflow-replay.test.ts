import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, getRunSteps, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

type RunRow = { status: string; state: unknown };

async function runRow(runId: string) {
  return (await getAdminPool().query<RunRow>("select status, state from crm.workflow_runs where id = $1", [runId])).rows[0];
}

async function dieAndReclaim(runId: string, saved: RunRow) {
  await getAdminPool().query(
    `update crm.workflow_runs
     set status = $2, state = $3::jsonb, claimed_at = now() - interval '11 minutes', finished_at = null, error = null, waiting_for = null, resume_at = null
     where id = $1`,
    [runId, saved.status, JSON.stringify(saved.state)],
  );
}

async function resumeDelay(runId: string, fetchImpl: typeof fetch) {
  await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 minute' where id = $1", [runId]);
  await runWorkflowTick({ budgetMs: 15_000, fetchImpl });
}

async function taskCount(title: string) {
  return (await getAdminPool().query<{ n: number }>("select count(*)::int as n from crm.tasks where title = $1", [title])).rows[0].n;
}

function graph(object: "company" | "contact", nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  return {
    version: 2,
    trigger: { type: "manual", object },
    triggerPosition: { x: 0, y: 0 },
    nodes,
    edges: [
      { source: "trigger", handle: "out", target: nodes[0].id },
      ...nodes.slice(1).map((node, index) => ({ source: nodes[index].id, handle: "out", target: node.id })),
    ],
  };
}

const delay = { id: "delay_1", type: "delay", config: { amount: 1, unit: "hours" }, position: { x: 300, y: 0 } } as const;
const ai = {
  id: "ai_1",
  type: "ai",
  config: { prompt: "Anything else for {{company.name}}?", outputs: [{ key: "answer", type: "text", description: "Anything else." }] },
  position: { x: 1200, y: 0 },
} as const;

describe("workflow runs picked up again after the server stopped", () => {
  let owner: UserActor;
  let companyId: string;
  let contactId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@replay.test", "Mark Ridgeon");
    companyId = (await createCompany(owner, { name: "Replay Co", domain: "replay-co.test", ownerId: owner.userId })).body.company.id;
    contactId = (await createContact(owner, { firstName: "Jane", lastName: "Doe", companyId, email: "jane@replay-co.test" })).body.contact.id;
  });

  beforeEach(() => {
    process.env.LLM_API_KEY = "test-llm-key";
  });

  after(async () => {
    delete process.env.LLM_API_KEY;
    await getPool().end();
  });

  async function flow(name: string, definition: WorkflowDefinition) {
    const workflow = await createWorkflow(owner, { name });
    await saveWorkflow(owner, workflow.id, { definition });
    await setWorkflowStatus(owner, workflow.id, "active");
    return workflow.id;
  }

  it("doesn't create the task or note again when a run that stopped after them is picked up", async () => {
    const workflowId = await flow(
      "Task then note",
      graph("company", [
        delay,
        { id: "create_task_1", type: "create_task", config: { title: "Call {{company.name}} back", link: "company" }, position: { x: 600, y: 0 } },
        { id: "add_note_1", type: "add_note", config: { title: "Replay note", body: "Followed up {{company.name}}" }, position: { x: 900, y: 0 } },
        ai,
      ]),
    );
    const started = await startRun(owner, workflowId, { test: false, record: { type: "company", id: companyId } });
    let saved: RunRow | null = null;
    const llm: typeof fetch = async () => {
      saved ??= await runRow(started.runId);
      return Response.json({ model: "test", choices: [{ message: { role: "assistant", content: JSON.stringify({ answer: "No." }) }, finish_reason: "stop" }] });
    };
    await resumeDelay(started.runId, llm);
    assert.equal((await getRunSteps(owner, started.runId)).run.status, "succeeded");
    assert.ok(saved);
    await dieAndReclaim(started.runId, saved);
    await runWorkflowTick({ budgetMs: 15_000, fetchImpl: llm });
    assert.equal((await getRunSteps(owner, started.runId)).run.status, "succeeded");
    assert.equal(await taskCount("Call Replay Co back"), 1);
    const notes = (await listActivities(owner, { companyId, type: "note" })).data.filter((note) => note.title === "Replay note");
    assert.equal(notes.length, 1);
  });

  it("finds the task it already made when a run stopped part way through creating it", async () => {
    const workflowId = await flow(
      "Task only",
      graph("company", [delay, { id: "create_task_1", type: "create_task", config: { title: "Send {{company.name}} the deck", link: "company" }, position: { x: 600, y: 0 } }, ai]),
    );
    const started = await startRun(owner, workflowId, { test: false, record: { type: "company", id: companyId } });
    let saved: RunRow | null = null;
    const llm: typeof fetch = async () => {
      saved ??= await runRow(started.runId);
      return Response.json({ model: "test", choices: [{ message: { role: "assistant", content: JSON.stringify({ answer: "No." }) }, finish_reason: "stop" }] });
    };
    const before = Date.now() - 1_000;
    await resumeDelay(started.runId, llm);
    const midway = saved as unknown as RunRow;
    const state = midway.state as Record<string, unknown>;
    await dieAndReclaim(started.runId, { status: "running", state: { ...state, at: "create_task_1", effect: { key: "create_task_1", at: before } } });
    await runWorkflowTick({ budgetMs: 15_000, fetchImpl: llm });
    assert.equal((await getRunSteps(owner, started.runId)).run.status, "succeeded");
    assert.equal(await taskCount("Send Replay Co the deck"), 1);
  });

  it("never sends an email twice when a run stopped while sending it", async () => {
    await getAdminPool().query(
      `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, access_token, access_token_expires_at, can_send)
       values ($1, $2, 'microsoft', 'mark@replay.test', 'connected', $3, $4, $5, true)`,
      [owner.workspaceId, owner.userId, encryptSecret("replay-refresh"), encryptSecret("replay-access"), new Date(Date.now() + 3_600_000).toISOString()],
    );
    const workflowId = await flow(
      "Email after an hour",
      graph("contact", [delay, { id: "send_email_1", type: "send_email", config: { subject: "Checking in", body: "Hello {{contact.firstName}}", from: "mark@replay.test" }, position: { x: 600, y: 0 } }]),
    );
    const started = await startRun(owner, workflowId, { test: false, record: { type: "contact", id: contactId } });
    const sent: string[] = [];
    let saved: RunRow | null = null;
    const graphFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/sendMail")) {
        saved ??= await runRow(started.runId);
        sent.push(String(input));
      }
      return new Response(null, { status: 202 });
    };
    await resumeDelay(started.runId, graphFetch);
    assert.equal(sent.length, 1);
    assert.ok(saved);
    await dieAndReclaim(started.runId, saved);
    await runWorkflowTick({ budgetMs: 15_000, fetchImpl: graphFetch });
    assert.equal(sent.length, 1);
    const { run } = await getRunSteps(owner, started.runId);
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /didn.t repeat it/);
  });
});
