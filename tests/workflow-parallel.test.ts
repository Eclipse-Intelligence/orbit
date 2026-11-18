import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { definitionFromInput, FIND_LIMIT_PARALLEL, feedsParallelLoop, type WorkflowDefinition } from "@/lib/workflows/definition";
import { childVars, CRON_RUNS_AT_ONCE, executeRun, MAX_STEPS_PER_RUN, runWorkflowTick, TOO_MANY_STEPS } from "@/lib/workflows/engine";
import { removeMember } from "@/lib/crm/team";
import { createContact } from "@/lib/crm/contacts";
import { ServiceBusy, takeService } from "@/lib/workflows/limits";
import { runProgress } from "@/lib/workflows/progress";
import { readFindConfig } from "@/lib/workflows/records";
import { cancelRun, createWorkflow, getRunSteps, listRuns, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { MAX_WORKERS, releaseWorkerLease, startWorkers, takeWorkerLease, workersWanted } from "@/lib/workflows/workers";
import { createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

type Node = WorkflowDefinition["nodes"][number];

function node(id: string, type: Node["type"], config: Record<string, unknown>, label?: string): Node {
  return { id, type, config, position: { x: 0, y: 0 }, ...(label ? { label } : {}) };
}

function graph(nodes: Node[], edges: [string, string, string][]): WorkflowDefinition {
  return {
    version: 2,
    trigger: { type: "manual", object: "company" },
    triggerPosition: { x: 0, y: 0 },
    nodes,
    edges: edges.map(([source, handle, target]) => ({ source, handle, target })),
  };
}

function research(tag: string, extra: { atOnce?: number; body?: Node[]; bodyEdges?: [string, string, string][]; findLimit?: number } = {}) {
  return graph(
    [
      node("find_records_1", "find_records", { object: "company", tag, limit: extra.findLimit ?? 100 }),
      node("loop_1", "loop", { items: "{{steps.find_records_1.records}}", parallel: true, atOnce: extra.atOnce ?? 50 }, "Each agency"),
      node("ai_1", "ai", { prompt: "Research {{company.name}}.", outputs: [{ key: "fit", type: "number" }] }, "Research"),
      node("add_note_1", "add_note", { title: "Fit {{steps.ai_1.fit}}", body: "Researched {{company.name}}." }),
      node("add_note_2", "add_note", { title: "Batch done", body: "{{steps.loop_1.succeeded}} done, {{steps.loop_1.skipped}} skipped, {{steps.loop_1.failed}} failed" }),
      ...(extra.body ?? []),
    ],
    [
      ["trigger", "out", "find_records_1"],
      ["find_records_1", "out", "loop_1"],
      ["loop_1", "each", "ai_1"],
      ["ai_1", "out", "add_note_1"],
      ["loop_1", "done", "add_note_2"],
      ...(extra.bodyEdges ?? []),
    ],
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gateway(options: { delayMs?: number; reply?: (user: string) => Response | null; onCall?: (user: string) => Promise<void> } = {}) {
  const asked: string[] = [];
  let live = 0;
  let peak = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const user = String(body.messages?.[1]?.content ?? "");
    asked.push(user);
    live += 1;
    peak = Math.max(peak, live);
    try {
      await options.onCall?.(user);
      await wait(options.delayMs ?? 0);
      const replied = options.reply?.(user);
      if (replied) return replied;
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ fit: 80 }) }, finish_reason: "stop" }] });
    } finally {
      live -= 1;
    }
  };
  return {
    fetchImpl,
    asked,
    get peak() {
      return peak;
    },
  };
}

async function children(parentId: string) {
  return (
    await getAdminPool().query<{ id: string; status: string; skip_reason: string | null; error: string | null; item_index: number; test: boolean }>(
      "select id, status, skip_reason, error, item_index, test from crm.workflow_runs where parent_run_id = $1 order by item_index",
      [parentId],
    )
  ).rows;
}

async function runRow(id: string) {
  return (
    await getAdminPool().query<{ status: string; error: string | null; waiting_for: string | null; state: Record<string, unknown> }>(
      "select status, error, waiting_for, state from crm.workflow_runs where id = $1",
      [id],
    )
  ).rows[0];
}

async function notesTitled(owner: UserActor, title: string) {
  return (
    await getAdminPool().query<{ body: string; company_id: string | null }>(
      "select body, company_id from crm.activities where workspace_id = $1 and type = 'note' and title = $2",
      [owner.workspaceId, title],
    )
  ).rows;
}

async function drain(fetchImpl: typeof fetch, rounds = 6) {
  for (let round = 0; round < rounds; round += 1) {
    const tick = await runWorkflowTick({ fetchImpl, budgetMs: 40_000, limit: CRON_RUNS_AT_ONCE });
    if (tick.processed === 0) return;
  }
}

describe("parallel workflows", () => {
  let owner: UserActor;
  let colleague: UserActor;
  let home: string;
  const errors: string[] = [];
  const originalError = console.error;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@parallel.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const colleagueId = (
      await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", ["ana@parallel.test", "Ana Admin"])
    ).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [owner.workspaceId, colleagueId]);
    colleague = { ...owner, userId: colleagueId, email: "ana@parallel.test", fullName: "Ana Admin", role: "admin", scopes: scopesForRole("admin") };
    home = (await createCompany(owner, { name: "Eclipse Home" })).body.company.id;
    for (let index = 1; index <= 25; index += 1) await createCompany(owner, { name: `Agency ${String(index).padStart(2, "0")}`, tags: ["batch"] });
    for (let index = 1; index <= 4; index += 1) await createCompany(owner, { name: `Small ${index}`, tags: ["small"] });
  });

  beforeEach(() => {
    process.env.LLM_API_KEY = "test-llm-key";
    errors.length = 0;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    };
  });

  afterEach(() => {
    console.error = originalError;
  });

  after(async () => {
    delete process.env.LLM_API_KEY;
  });

  useServerlessPool();

  async function workflow(definition: WorkflowDefinition) {
    const created = await createWorkflow(owner, { name: `Parallel ${Math.random()}` });
    await saveWorkflow(owner, created.id, { definition });
    await setWorkflowStatus(owner, created.id, "active");
    return created.id;
  }

  async function start(definition: WorkflowDefinition, fetchImpl: typeof fetch) {
    const id = await workflow(definition);
    const started = await startRun(owner, id, { test: false, record: { type: "company", id: home }, fetchImpl });
    return { workflowId: id, runId: started.runId, status: started.status };
  }

  it("runs 25 items at the same time on two connections without any call failing while it waits", async () => {
    const ai = gateway({ delayMs: 250 });
    const { workflowId, runId, status } = await start(research("batch"), ai.fetchImpl);
    assert.equal(status, "waiting");
    const parent = await runRow(runId);
    assert.equal(parent.waiting_for, "children");
    assert.equal((await children(runId)).length, 25);

    await drain(ai.fetchImpl);

    const done = await children(runId);
    assert.deepEqual([...new Set(done.map((child) => child.status))], ["succeeded"]);
    assert.ok(ai.peak >= 20, `items overlapped (peak ${ai.peak})`);
    assert.equal(ai.asked.length, 25, "each item is researched once");
    assert.deepEqual(errors.filter((line) => /timeout|connect/i.test(line)), [], "no call waited too long for a connection");
    assert.equal((await runRow(runId)).status, "succeeded");

    const summary = await notesTitled(owner, "Batch done");
    assert.equal(summary.length, 1, "the parent carries on from Done exactly once");
    assert.equal(summary[0].body, "25 done, 0 skipped, 0 failed");
    assert.equal((await notesTitled(owner, "Fit 80")).length, 25);

    const runs = await listRuns(owner, workflowId);
    assert.equal(runs.length, 1, "items aren't listed as runs of their own");
    assert.deepEqual(runs[0].children, { total: 25, succeeded: 25, skipped: 0, failed: 0 });
    const steps = await getRunSteps(owner, runId);
    assert.equal(steps.steps.filter((step) => step.stepId === "loop_1" && step.status === "succeeded").length, 1);
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("never creates an item twice when a parent is reclaimed part way through starting them", async () => {
    const ai = gateway();
    const { runId } = await start(research("small"), ai.fetchImpl);
    assert.equal((await children(runId)).length, 4);
    const state = (await runRow(runId)).state as { waitingChildren: Record<string, unknown> };
    await getAdminPool().query(
      "update crm.workflow_runs set status = 'running', waiting_for = null, claimed_at = now() - interval '11 minutes', state = $2::jsonb where id = $1",
      [runId, JSON.stringify({ ...state, waitingChildren: { ...state.waitingChildren, created: false } })],
    );
    await getAdminPool().query("delete from crm.workflow_runs where parent_run_id = $1 and item_index = 3", [runId]);

    await executeRun(runId, owner.userId, owner.workspaceId, { deadline: Date.now() + 30_000, fetchImpl: ai.fetchImpl });
    const again = await children(runId);
    assert.deepEqual(again.map((child) => child.item_index), [0, 1, 2, 3], "the missing item is added and the others aren't repeated");
    assert.equal((await runRow(runId)).waiting_for, "children");

    await drain(ai.fetchImpl);
    assert.equal(ai.asked.length, 4);
    assert.equal((await runRow(runId)).status, "succeeded");
    assert.equal((await notesTitled(owner, "Batch done"))[0].body, "4 done, 0 skipped, 0 failed");
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("queues the parent exactly once when the last items finish together", async () => {
    const ai = gateway({ delayMs: 100 });
    const { runId } = await start(research("small"), ai.fetchImpl);
    const ids = (await children(runId)).map((child) => child.id);
    await getAdminPool().query("update crm.workflow_runs set status = 'running', claimed_at = now() where id = any($1::uuid[])", [ids]);
    const outcomes = await Promise.all(ids.map((id) => executeRun(id, owner.userId, owner.workspaceId, { deadline: Date.now() + 30_000, fetchImpl: ai.fetchImpl })));
    assert.deepEqual(outcomes, ["succeeded", "succeeded", "succeeded", "succeeded"]);
    const parent = await runRow(runId);
    assert.equal(parent.status, "queued");
    const counts = (
      await getAdminPool().query<{ succeeded: number; total: number }>("select children_succeeded as succeeded, children_total as total from crm.workflow_runs where id = $1", [runId])
    ).rows[0];
    assert.deepEqual(counts, { succeeded: 4, total: 4 });
    await drain(ai.fetchImpl);
    assert.equal((await runRow(runId)).status, "succeeded");
    assert.equal((await notesTitled(owner, "Batch done")).length, 1);
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("skips an item whose research still fails after its retry, with the reason, and carries on", async () => {
    const ai = gateway({ reply: (user) => (user.includes("Research Small 2.") ? Response.json({ error: { message: "down" } }, { status: 503 }) : null) });
    const { runId, workflowId } = await start(research("small"), ai.fetchImpl);
    await drain(ai.fetchImpl);
    await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 second' where parent_run_id = $1 and status = 'waiting'", [runId]);
    await drain(ai.fetchImpl);
    const items = await children(runId);
    const skipped = items.filter((child) => child.skip_reason);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].status, "succeeded");
    assert.match(skipped[0].skip_reason ?? "", /^Research: /);
    const parent = await runRow(runId);
    assert.equal(parent.status, "succeeded");
    assert.match(parent.error ?? "", /^Skipped 1: Small 2 \(Research: /);
    assert.equal((await notesTitled(owner, "Batch done"))[0].body, "3 done, 1 skipped, 0 failed");
    const output = (parent.state.vars as { steps: Record<string, { skipReasons: string[] }> }).steps.loop_1;
    assert.match(output.skipReasons[0], /^Small 2: Research: /);
    const shown = await getRunSteps(owner, runId);
    assert.equal(shown.run.items.length, 1);
    assert.equal(shown.run.items[0].name, "Small 2");
    const [summary] = await listRuns(owner, workflowId);
    assert.equal(runProgress(summary.children!, true), "4 done, 1 skipped");
    const bell = await getAdminPool().query<{ title: string }>("select title from crm.notifications where user_id = $1 and title like '%finished with 1 skipped'", [owner.userId]);
    assert.equal(bell.rows.length, 1, "one notification summarises the run");
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("waits and tries again when the AI says it's busy, instead of failing the item", async () => {
    let busy = true;
    const ai = gateway({ reply: () => (busy ? Response.json({ error: { message: "slow down" } }, { status: 429 }) : null) });
    const { runId } = await start(research("small"), ai.fetchImpl);
    await drain(ai.fetchImpl);
    const waiting = await children(runId);
    assert.deepEqual([...new Set(waiting.map((child) => child.status))], ["waiting"]);
    busy = false;
    await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 second' where parent_run_id = $1", [runId]);
    await drain(ai.fetchImpl);
    assert.deepEqual([...new Set((await children(runId)).map((child) => child.status))], ["succeeded"]);
    assert.equal((await runRow(runId)).status, "succeeded");
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("cancels a run with its items: a step already talking to the AI finishes and nothing after it starts", async () => {
    let parentId = "";
    let cancelled = false;
    const ai = gateway({
      onCall: async () => {
        if (cancelled) return;
        cancelled = true;
        await cancelRun(owner, parentId);
      },
    });
    const { runId } = await start(research("small", { atOnce: 1 }), ai.fetchImpl);
    parentId = runId;
    await drain(ai.fetchImpl);
    assert.equal(ai.asked.length, 1, "only the item already running reached the AI");
    assert.equal((await runRow(runId)).status, "cancelled");
    assert.deepEqual([...new Set((await children(runId)).map((child) => child.status))], ["cancelled"]);
    assert.equal((await notesTitled(owner, "Fit 80")).length, 0, "the step after the AI never started");
    assert.equal((await notesTitled(owner, "Batch done")).length, 0);
    await assert.rejects(cancelRun(owner, runId), /already finished/);
  });

  it("lets nobody else see or cancel a run or its items", async () => {
    const ai = gateway();
    const { runId, workflowId } = await start(research("small"), ai.fetchImpl);
    const [child] = await children(runId);
    await assert.rejects(cancelRun(colleague, runId), (error: unknown) => error instanceof CrmError && error.status === 404);
    await assert.rejects(getRunSteps(colleague, runId), (error: unknown) => error instanceof CrmError && error.status === 404);
    await assert.rejects(getRunSteps(colleague, child.id), (error: unknown) => error instanceof CrmError && error.status === 404);
    assert.deepEqual(await listRuns(colleague, workflowId), []);
    const seen = await queryAsUser<{ id: string }>(colleague.userId, "select id from crm.workflow_runs where parent_run_id = $1", [runId]);
    assert.equal(seen.length, 0);
    const changed = await queryAsUser<{ id: string }>(colleague.userId, "update crm.workflow_runs set status = 'cancelled' where id = $1 returning id", [runId]);
    assert.equal(changed.length, 0);
    assert.equal((await runRow(runId)).status, "waiting");
    await assert.rejects(cancelRun(owner, child.id), /Stop the whole run instead/);
    await cancelRun(owner, runId);
    assert.deepEqual([...new Set((await children(runId)).map((item) => item.status))], ["cancelled"]);
  });

  it("runs the first three items of a test run straight away and describes the rest", async () => {
    const ai = gateway();
    const id = await workflow(research("batch"));
    const started = await startRun(owner, id, { test: true, record: { type: "company", id: home }, fetchImpl: ai.fetchImpl });
    assert.equal(started.status, "succeeded");
    const items = await children(started.runId);
    assert.equal(items.length, 3);
    assert.ok(items.every((item) => item.test && item.status === "succeeded"));
    assert.equal(ai.asked.length, 3);
    assert.equal((await notesTitled(owner, "Fit 80")).length, 0, "test runs describe actions instead of doing them");
    const loop = (await getRunSteps(owner, started.runId)).steps.filter((step) => step.stepId === "loop_1");
    assert.equal((loop[0].output as { count: number }).count, 25);
    assert.equal((loop.at(-1)?.output as { succeeded: number }).succeeded, 3);
  });

  it("re-queues a run that reaches the step limit instead of finishing it, and fails it past 5,000 steps", async () => {
    const list = Array.from({ length: 100 }, (_, index) => `item ${index}`);
    const ai = gateway({ reply: () => Response.json({ choices: [{ message: { content: JSON.stringify({ items: list }) }, finish_reason: "stop" }] }) });
    const definition = graph(
      [
        node("ai_1", "ai", { prompt: "List things.", outputs: [{ key: "items", type: "list" }] }),
        node("loop_1", "loop", { items: "{{steps.ai_1.items}}", limit: 100 }),
        node("if_1", "if", { conditions: [{ left: "{{loop.item}}", op: "is_not_empty" }] }),
        node("filter_1", "filter", { conditions: [{ left: "{{loop.item}}", op: "is_not_empty" }] }),
        node("add_note_1", "add_note", { title: "Counted", body: "{{steps.loop_1.count}}" }),
      ],
      [
        ["trigger", "out", "ai_1"],
        ["ai_1", "out", "loop_1"],
        ["loop_1", "each", "if_1"],
        ["if_1", "true", "filter_1"],
        ["loop_1", "done", "add_note_1"],
      ],
    );
    const first = await start(definition, ai.fetchImpl);
    assert.equal(first.status, "paused");
    const paused = await runRow(first.runId);
    assert.equal(paused.status, "queued");
    assert.equal(paused.state.stepCount, MAX_STEPS_PER_RUN);
    await drain(ai.fetchImpl);
    assert.equal((await runRow(first.runId)).status, "succeeded");
    assert.equal((await notesTitled(owner, "Counted")).length, 1);

    const second = await start(definition, ai.fetchImpl);
    const state = (await runRow(second.runId)).state;
    await getAdminPool().query("update crm.workflow_runs set state = $2::jsonb where id = $1", [second.runId, JSON.stringify({ ...state, stepCount: 4_999 })]);
    await drain(ai.fetchImpl);
    const failed = await runRow(second.runId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, TOO_MANY_STEPS);
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("keeps to At most even when two ticks claim at the same time", async () => {
    const ai = gateway({ delayMs: 150 });
    const { runId } = await start(research("small", { atOnce: 2 }), ai.fetchImpl);
    for (let round = 0; round < 4; round += 1) {
      await Promise.all([
        runWorkflowTick({ fetchImpl: ai.fetchImpl, budgetMs: 30_000, limit: CRON_RUNS_AT_ONCE }),
        runWorkflowTick({ fetchImpl: ai.fetchImpl, budgetMs: 30_000, limit: CRON_RUNS_AT_ONCE }),
      ]);
    }
    assert.equal((await runRow(runId)).status, "succeeded");
    assert.ok(ai.peak <= 2, `never more than two at once (peak ${ai.peak})`);
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("counts a reclaimed item once, and an item that ends stopped as failed", async () => {
    const ai = gateway();
    const { runId } = await start(research("small"), ai.fetchImpl);
    const [first, second] = await children(runId);
    await getAdminPool().query("update crm.workflow_runs set status = 'running', claimed_at = now() - interval '11 minutes' where id = $1", [first.id]);
    await getAdminPool().query("update crm.workflow_runs set state = state - 'at' where id = $1", [second.id]);
    await drain(ai.fetchImpl);
    const counts = (
      await getAdminPool().query<{ succeeded: number; skipped: number; failed: number }>(
        "select children_succeeded as succeeded, children_skipped as skipped, children_failed as failed from crm.workflow_runs where id = $1",
        [runId],
      )
    ).rows[0];
    assert.deepEqual(counts, { succeeded: 3, skipped: 0, failed: 1 });
    assert.equal((await runRow(runId)).status, "succeeded");
    assert.equal((await notesTitled(owner, "Batch done"))[0].body, "3 done, 0 skipped, 1 failed");
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("starts no items once a run is stopped while it is still adding them", async () => {
    const ai = gateway();
    const { runId } = await start(research("small"), ai.fetchImpl);
    const state = (await runRow(runId)).state as { waitingChildren: Record<string, unknown> };
    await getAdminPool().query("delete from crm.workflow_runs where parent_run_id = $1", [runId]);
    await getAdminPool().query(
      "update crm.workflow_runs set status = 'running', waiting_for = null, claimed_at = now(), state = $2::jsonb where id = $1",
      [runId, JSON.stringify({ ...state, waitingChildren: { ...state.waitingChildren, created: false } })],
    );
    const holder = await getAdminPool().connect();
    try {
      await holder.query("begin");
      await holder.query("select id from crm.workflow_runs where id = $1 for update", [runId]);
      const running = executeRun(runId, owner.userId, owner.workspaceId, { deadline: Date.now() + 30_000, fetchImpl: ai.fetchImpl });
      await wait(300);
      await holder.query("update crm.workflow_runs set status = 'cancelled', finished_at = now() where id = $1", [runId]);
      await holder.query("commit");
      assert.equal(await running, "cancelled");
    } finally {
      holder.release();
    }
    assert.equal((await children(runId)).length, 0);

    const other = await start(research("small"), ai.fetchImpl);
    await getAdminPool().query("update crm.workflow_runs set status = 'cancelled' where id = $1", [other.runId]);
    await drain(ai.fetchImpl);
    assert.equal(ai.asked.length, 0, "items under a stopped run are never claimed");
  });

  it("never deadlocks when a run is stopped while its items finish", async () => {
    const ai = gateway({ delayMs: 40 });
    const { runId } = await start(research("batch"), ai.fetchImpl);
    await Promise.all([drain(ai.fetchImpl), wait(60).then(() => cancelRun(owner, runId))]);
    assert.deepEqual(errors.filter((line) => /deadlock/i.test(line)), []);
    assert.equal((await runRow(runId)).status, "cancelled");
    const left = (await children(runId)).filter((child) => ["queued", "running", "waiting"].includes(child.status));
    assert.deepEqual(left, []);
    await getAdminPool().query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("stops a member's runs and their items when they leave the workspace", async () => {
    const admin = getAdminPool();
    const leaverId = (
      await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", ["lee@parallel.test", "Lee Leaver"])
    ).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, leaverId]);
    const leaver: UserActor = { ...owner, userId: leaverId, email: "lee@parallel.test", fullName: "Lee Leaver", role: "member", scopes: scopesForRole("member") };
    const ai = gateway();
    const created = await createWorkflow(leaver, { name: "Leaver run" });
    await saveWorkflow(leaver, created.id, { definition: research("small") });
    await setWorkflowStatus(leaver, created.id, "active");
    const started = await startRun(leaver, created.id, { test: false, record: { type: "company", id: home }, fetchImpl: ai.fetchImpl });
    assert.equal(started.status, "waiting");
    await removeMember(owner, leaverId);
    assert.equal((await runRow(started.runId)).status, "cancelled");
    assert.deepEqual([...new Set((await children(started.runId)).map((child) => child.status))], ["cancelled"]);
  });

  it("never deadlocks when a member is removed while one of their items finishes", async () => {
    const admin = getAdminPool();
    const leaverId = (
      await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", ["ray@parallel.test", "Ray Racer"])
    ).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, leaverId]);
    const leaver: UserActor = { ...owner, userId: leaverId, email: "ray@parallel.test", fullName: "Ray Racer", role: "member", scopes: scopesForRole("member") };
    let removal: Promise<void> | null = null;
    const ai = gateway({
      delayMs: 30,
      onCall: async () => {
        removal ??= wait(25).then(() => removeMember(owner, leaverId));
      },
    });
    const created = await createWorkflow(leaver, { name: "Racing leaver" });
    await saveWorkflow(leaver, created.id, { definition: research("batch") });
    await setWorkflowStatus(leaver, created.id, "active");
    const started = await startRun(leaver, created.id, { test: false, record: { type: "company", id: home }, fetchImpl: ai.fetchImpl });
    await drain(ai.fetchImpl);
    await removal;
    assert.deepEqual(errors.filter((line) => /deadlock/i.test(line)), []);
    assert.equal((await runRow(started.runId)).status, "cancelled");
    assert.deepEqual((await children(started.runId)).filter((child) => ["queued", "running", "waiting"].includes(child.status)), []);
    await admin.query("delete from crm.activities where workspace_id = $1 and type = 'note'", [owner.workspaceId]);
  });

  it("reads a LinkedIn profile once even when the AI makes the step wait", async () => {
    process.env.MINDCASE_API_KEY = "test-mindcase-key";
    const contact = (await createContact(owner, { firstName: "Priya", lastName: "Shah", linkedinUrl: "https://www.linkedin.com/in/priya-shah" })).body.contact.id;
    let lookups = 0;
    let busy = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes("mindcase")) {
        lookups += 1;
        return Response.json({ status: "completed", data: [{ fullName: "Priya Shah", headline: "Founder" }] });
      }
      if (busy) return Response.json({ error: { message: "slow down" } }, { status: 429 });
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ role: "Founder" }) }, finish_reason: "stop" }] });
    };
    const definition: WorkflowDefinition = {
      ...graph([node("ai_1", "ai", { prompt: "What does {{contact.name}} do?", linkedin: true, outputs: [{ key: "role", type: "text" }] })], [["trigger", "out", "ai_1"]]),
      trigger: { type: "manual", object: "contact" },
    };
    const id = await workflow(definition);
    const started = await startRun(owner, id, { test: false, record: { type: "contact", id: contact }, fetchImpl });
    assert.equal(started.status, "waiting");
    busy = false;
    await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 second' where id = $1", [started.runId]);
    await drain(fetchImpl);
    assert.equal((await runRow(started.runId)).status, "succeeded");
    assert.equal(lookups, 1);
    delete process.env.MINDCASE_API_KEY;
  });

  it("fails a step that has waited six hours for a busy service, however many times it waited", async () => {
    const ai = gateway({ reply: () => Response.json({ error: { message: "slow down" } }, { status: 429 }) });
    const id = await workflow(graph([node("ai_1", "ai", { prompt: "Hello.", outputs: [{ key: "text", type: "text" }] })], [["trigger", "out", "ai_1"]]));
    const started = await startRun(owner, id, { test: false, record: { type: "company", id: home }, fetchImpl: ai.fetchImpl });
    assert.equal(started.status, "waiting");
    const state = (await runRow(started.runId)).state;
    await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 second', state = $2::jsonb where id = $1", [
      started.runId,
      JSON.stringify({ ...state, busy: { step: "ai_1", count: 2, since: Date.now() - 6 * 60 * 60_000 - 1_000 } }),
    ]);
    await drain(ai.fetchImpl);
    const failed = await runRow(started.runId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "ai_1: This step waited too long for a busy service. Try again.");
  });

  it("keeps a step waiting for a busy service within six hours, however many times it waited", async () => {
    const ai = gateway({ reply: () => Response.json({ error: { message: "slow down" } }, { status: 429 }) });
    const id = await workflow(graph([node("ai_1", "ai", { prompt: "Hello.", outputs: [{ key: "text", type: "text" }] })], [["trigger", "out", "ai_1"]]));
    const started = await startRun(owner, id, { test: false, record: { type: "company", id: home }, fetchImpl: ai.fetchImpl });
    const state = (await runRow(started.runId)).state;
    await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 second', state = $2::jsonb where id = $1", [
      started.runId,
      JSON.stringify({ ...state, busy: { step: "ai_1", count: 500, since: Date.now() - 60 * 60_000 } }),
    ]);
    await drain(ai.fetchImpl);
    const waiting = await runRow(started.runId);
    assert.equal(waiting.status, "waiting", "an item in a loop of 500 waits its turn instead of failing");
    assert.equal((waiting.state as { busy?: { count: number } }).busy?.count, 501);
  });
});

describe("parallel loop rules", () => {
  it("refuses Approval and a second parallel loop inside a parallel loop, but allows a one-at-a-time inner loop", () => {
    const approval = definitionFromInput(
      graph(
        [node("loop_1", "loop", { items: "{{trigger.type}}", parallel: true }, "Each agency"), node("approval_1", "approval", { title: "Check" })],
        [
          ["trigger", "out", "loop_1"],
          ["loop_1", "each", "approval_1"],
        ],
      ),
    );
    assert.match("error" in approval ? approval.error : "", /^Each agency: items that run at the same time can't wait for approval/);
    const nested = definitionFromInput(
      graph(
        [node("loop_1", "loop", { items: "{{trigger.type}}", parallel: true }), node("loop_2", "loop", { items: "{{loop.item}}", parallel: true }, "Each person")],
        [
          ["trigger", "out", "loop_1"],
          ["loop_1", "each", "loop_2"],
        ],
      ),
    );
    assert.match("error" in nested ? nested.error : "", /^Each person: only the outer For each item can run items at the same time/);
    const inner = definitionFromInput(
      graph(
        [node("loop_1", "loop", { items: "{{trigger.type}}", parallel: true }), node("loop_2", "loop", { items: "{{loop.item}}" }), node("approval_1", "approval", { title: "After" })],
        [
          ["trigger", "out", "loop_1"],
          ["loop_1", "each", "loop_2"],
          ["loop_1", "done", "approval_1"],
        ],
      ),
    );
    assert.ok("definition" in inner);
  });

  it("lets Find records take up to 1,000 only when it feeds a parallel loop", () => {
    const parallel = research("batch");
    assert.equal(feedsParallelLoop(parallel, "find_records_1"), true);
    assert.equal(readFindConfig({ limit: 5000 }, "owner", { feedsParallel: true }).limit, FIND_LIMIT_PARALLEL);
    assert.equal(readFindConfig({ limit: 5000 }, "owner").limit, 100);
    const serial = { ...parallel, nodes: parallel.nodes.map((item) => (item.id === "loop_1" ? { ...item, config: { ...item.config, parallel: false } } : item)) };
    assert.equal(feedsParallelLoop(serial, "find_records_1"), false);
  });

  it("leaves the list being gone through out of each item's variables", () => {
    const vars = { steps: { find_records_1: { count: 2, records: [{ id: "a" }, { id: "b" }] } }, today: "Mon" };
    assert.deepEqual(childVars(vars, "{{steps.find_records_1.records}}"), { steps: { find_records_1: { count: 2, records: null } }, today: "Mon" });
    assert.equal(vars.steps.find_records_1.records.length, 2);
    assert.equal(childVars(vars, "{{loop.item}}"), vars);
  });

  it("describes progress as the runs page shows it", () => {
    assert.equal(runProgress({ total: 200, succeeded: 138, skipped: 4, failed: 1 }, false), "143 of 200 done, 4 skipped, 1 failed");
    assert.equal(runProgress({ total: 200, succeeded: 191, skipped: 9, failed: 0 }, true), "200 done, 9 skipped");
  });
});

describe("shared limits and workers", () => {
  const saved = { ...process.env };

  before(async () => {
    await resetDatabase();
  });

  beforeEach(() => {
    delete process.env.SITE_URL;
    delete process.env.CRON_SECRET;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  useServerlessPool();

  it("makes a step wait when a service has had its calls for the minute, or has too many running", async () => {
    process.env.WORKFLOW_LIMIT_HUNTER_PER_MINUTE = "1000";
    process.env.WORKFLOW_LIMIT_HUNTER_PER_HOUR = "2";
    process.env.WORKFLOW_LIMIT_HUNTER_AT_ONCE = "1";
    const first = await takeService("hunter", { scope: "limit-test" });
    await assert.rejects(takeService("hunter", { scope: "limit-test" }), (error: unknown) => error instanceof ServiceBusy && error.until.getTime() > Date.now());
    await first.release();
    await (await takeService("hunter", { scope: "limit-test" })).release();
    const third = takeService("hunter", { scope: "limit-test" });
    await assert.rejects(third, (error: unknown) => error instanceof ServiceBusy && error.until.getTime() >= Math.ceil(Date.now() / 3_600_000) * 3_600_000);
  });

  it("counts only runs a worker could claim as waiting work", async () => {
    const owner = await createUser("backlog@parallel.test", "Bea Backlog");
    const created = await createWorkflow(owner, { name: "Backlog" });
    const admin = getAdminPool();
    const parent = (
      await admin.query<{ id: string }>(
        `insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, definition, status, waiting_for, children_total, children_at_once)
         values ($1, $2, $3, '{}'::jsonb, 'waiting', 'children', 7, 2) returning id`,
        [owner.workspaceId, created.id, owner.userId],
      )
    ).rows[0].id;
    for (let index = 0; index < 7; index += 1) {
      await admin.query(
        `insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, definition, parent_run_id, loop_step_id, item_index, status, claimed_at)
         values ($1, $2, $3, '{}'::jsonb, $4, 'loop_1', $5, $6, now())`,
        [owner.workspaceId, created.id, owner.userId, parent, index, index < 2 ? "running" : "queued"],
      );
    }
    const backlog = async () => (await admin.query<{ count: number }>("select private.workflow_backlog(true) as count")).rows[0].count;
    assert.equal(await backlog(), 0, "a parent at its limit has no room");
    await admin.query("insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, definition) values ($1, $2, $3, '{}'::jsonb)", [
      owner.workspaceId,
      created.id,
      owner.userId,
    ]);
    assert.equal(await backlog(), 1);
    await admin.query("delete from crm.workspace_members where user_id = $1", [owner.userId]);
    assert.equal(await backlog(), 0, "runs of someone who left aren't waiting work");
    await admin.query("delete from crm.workflow_runs where workflow_id = $1", [created.id]);
  });

  it("keeps at most ten workers and starts only as many as the queue needs", async () => {
    const leases: string[] = [];
    for (let index = 0; index < MAX_WORKERS; index += 1) {
      const lease = await takeWorkerLease();
      assert.ok(lease);
      leases.push(lease);
    }
    assert.equal(await takeWorkerLease(), null);
    await releaseWorkerLease(leases.pop()!);
    assert.ok(await takeWorkerLease());
    assert.equal(workersWanted(260, 0), 10);
    assert.equal(workersWanted(30, 1), 1);
    assert.equal(workersWanted(0, 0), 0);
    for (const lease of leases) await releaseWorkerLease(lease);
    await getAdminPool().query("delete from crm.workflow_workers");

    const owner = await createUser("workers@parallel.test", "Wes Worker");
    const company = (await createCompany(owner, { name: "Queue Co" })).body.company.id;
    const created = await createWorkflow(owner, { name: "Queue" });
    for (let index = 0; index < 30; index += 1) {
      await getAdminPool().query(
        "insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, definition, event) values ($1, $2, $3, '{}'::jsonb, $4::jsonb)",
        [owner.workspaceId, created.id, owner.userId, JSON.stringify({ type: "manual", entityType: "company", entityId: company })],
      );
    }
    process.env.SITE_URL = "https://orbit.example";
    process.env.CRON_SECRET = "cron-secret-value";
    const calls: { url: string; auth: string | null }[] = [];
    const started = await startWorkers({
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
        return new Response(null, { status: 202 });
      },
    });
    assert.equal(started, 2);
    assert.deepEqual(calls[0], { url: "https://orbit.example/api/workflows/worker", auth: "Bearer cron-secret-value" });
  });
});
