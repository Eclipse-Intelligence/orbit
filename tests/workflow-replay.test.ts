import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createTask, getTask } from "@/lib/crm/tasks";
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

  async function stoppedAt(workflowId: string, stepId: string, fetchImpl?: typeof fetch) {
    const started = await startRun(owner, workflowId, { test: false, record: { type: "company", id: companyId } });
    let saved: RunRow | null = null;
    const llm: typeof fetch = async (input, init) => {
      if (String(input).includes("clickup") && fetchImpl) return fetchImpl(input, init);
      saved ??= await runRow(started.runId);
      return Response.json({ model: "test", choices: [{ message: { role: "assistant", content: JSON.stringify({ answer: "No." }) }, finish_reason: "stop" }] });
    };
    const before = Date.now() - 1_000;
    await resumeDelay(started.runId, llm);
    const midway = saved as unknown as RunRow;
    const state = midway.state as Record<string, unknown>;
    const replay = () => dieAndReclaim(started.runId, { status: "running", state: { ...state, at: stepId, effect: { key: stepId, at: before, logged: true } } });
    return { runId: started.runId, llm, replay };
  }

  async function succeededLogs(runId: string, stepId: string) {
    return (await getAdminPool().query<{ n: number }>("select count(*)::int as n from crm.workflow_run_steps where run_id = $1 and step_id = $2 and status = 'succeeded'", [runId, stepId])).rows[0].n;
  }

  const taskStep = (title: string, extra: Record<string, unknown> = {}) =>
    ({ id: "create_task_1", type: "create_task", config: { title, link: "company", ...extra }, position: { x: 600, y: 0 } }) as const;

  it("finds the task it already made when a run stopped part way through creating it, and logs the step once", async () => {
    const workflowId = await flow("Task only", graph("company", [delay, taskStep("Send {{company.name}} the deck"), ai]));
    const { runId, llm, replay } = await stoppedAt(workflowId, "create_task_1");
    await replay();
    await runWorkflowTick({ budgetMs: 15_000, fetchImpl: llm });
    assert.equal((await getRunSteps(owner, runId)).run.status, "succeeded");
    assert.equal(await taskCount("Send Replay Co the deck"), 1);
    assert.equal(await succeededLogs(runId, "create_task_1"), 1);
    const audit = await getAdminPool().query<{ source_url: string; workflow_step: string }>(
      "select e.source_url, e.changes->>'workflowStep' as workflow_step from crm.audit_events e join crm.tasks t on t.id = e.entity_id where e.event_type = 'task.created' and t.title = 'Send Replay Co the deck'",
    );
    assert.deepEqual({ ...audit.rows[0] }, { source_url: `/workflows/${workflowId}`, workflow_step: `${runId}:create_task_1` });
  });

  it("never takes another task with the same title for its own", async () => {
    const workflowId = await flow("Same title", graph("company", [delay, taskStep("Send the pricing"), ai]));
    const { runId, llm, replay } = await stoppedAt(workflowId, "create_task_1");
    await getAdminPool().query("delete from crm.tasks where title = 'Send the pricing'");
    const otherCompany = (await createCompany(owner, { name: "Other Co", domain: "other-co-replay.test" })).body.company.id;
    const unrelated = (await createTask(owner, { title: "Send the pricing", companyId: otherCompany })).body.task;
    await replay();
    await runWorkflowTick({ budgetMs: 15_000, fetchImpl: llm });
    assert.equal(await taskCount("Send the pricing"), 2);
    const step = (await getRunSteps(owner, runId)).steps.filter((item) => item.stepId === "create_task_1").at(-1)!;
    const made = (step.output as { id: string }).id;
    assert.notEqual(made, unrelated.id);
    assert.equal((await getTask(owner, made)).companyId, companyId);
  });

  it("sends the task it already made to ClickUp when the run stopped before the list was set", async () => {
    process.env.CLICKUP_API_TOKEN = "pk_replay";
    await getAdminPool().query(
      `insert into crm.integration_state (workspace_id, source, user_id, team_id, external_user_id, default_list_id, watched_list_ids, list_choices)
       values ($1, 'clickup', $2, '900', '101', '700', '{}', '[{"id":"700","name":"Replay list"}]'::jsonb)`,
      [owner.workspaceId, owner.userId],
    );
    const created: string[] = [];
    const clickup: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/field")) return Response.json({ fields: [] });
      if (path.endsWith("/list/700/task") && init?.method === "POST") {
        const id = `cu-replay-${created.length + 1}`;
        created.push(id);
        return Response.json({ id, name: JSON.parse(String(init.body)).name, status: null, date_updated: String(Date.now()), due_date: null, url: `https://app.clickup.com/t/${id}`, list: { id: "700" } });
      }
      return Response.json({ err: "Unexpected" }, { status: 500 });
    };
    try {
      const workflowId = await flow("Task to ClickUp", graph("company", [delay, taskStep("Book the {{company.name}} review", { clickup: true }), ai]));
      const { llm, replay } = await stoppedAt(workflowId, "create_task_1", clickup);
      assert.equal(created.length, 1);
      await getAdminPool().query("update crm.tasks set clickup_list_id = null, clickup_task_id = null, clickup_sync = '{}'::jsonb where title = 'Book the Replay Co review'");
      created.length = 0;
      await replay();
      await runWorkflowTick({ budgetMs: 15_000, fetchImpl: llm });
      assert.equal(await taskCount("Book the Replay Co review"), 1);
      assert.equal(created.length, 1);
      const row = await getAdminPool().query<{ clickup_list_id: string; clickup_task_id: string }>("select clickup_list_id, clickup_task_id from crm.tasks where title = 'Book the Replay Co review'");
      assert.deepEqual({ ...row.rows[0] }, { clickup_list_id: "700", clickup_task_id: created[0] });
    } finally {
      delete process.env.CLICKUP_API_TOKEN;
      await getAdminPool().query("delete from crm.integration_state where workspace_id = $1 and source = 'clickup'", [owner.workspaceId]);
    }
  });

  it("never sends a notification twice", async () => {
    const workflowId = await flow(
      "Notify me",
      graph("company", [delay, { id: "notify_1", type: "notify", config: { to: "owner", title: "Replay ping" }, position: { x: 600, y: 0 } }, ai]),
    );
    const { runId, llm, replay } = await stoppedAt(workflowId, "notify_1");
    await replay();
    await runWorkflowTick({ budgetMs: 15_000, fetchImpl: llm });
    const pings = await getAdminPool().query<{ n: number }>("select count(*)::int as n from crm.notifications where title = 'Replay ping'");
    assert.equal(pings.rows[0].n, 1);
    assert.equal(await succeededLogs(runId, "notify_1"), 1);
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
