import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { WorkflowDefinition, WorkflowNode } from "@/lib/workflows/definition";
import { executeRun, runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, getRunSteps, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { check, variableOptions } from "@/lib/workflows/variables";
import { createUser, resetDatabase } from "./helpers";

type Sent = { url: string; key: string | null; body: { state: Record<string, unknown>; questions: Record<string, Record<string, unknown>> } };

function parallel(reply: (body: Sent["body"]) => Record<string, unknown> | Response) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key"), body });
    const answer = reply(body);
    return answer instanceof Response ? answer : Response.json(answer);
  };
  return { fetchImpl, sent };
}

function graph(nodes: WorkflowNode[], edges: WorkflowDefinition["edges"]): WorkflowDefinition {
  return { version: 2, trigger: { type: "manual", object: "contact" }, triggerPosition: { x: 0, y: 0 }, nodes, edges };
}

function node(id: string, type: WorkflowNode["type"], config: Record<string, unknown>): WorkflowNode {
  return { id, type, config, position: { x: 0, y: 0 } };
}

const QUESTIONS = [
  { key: "hiring", type: "yes_no", question: "Is the company hiring engineers?" },
  { key: "funding", type: "choice", question: "How is the company funded?", options: ["Bootstrapped", " Venture backed ", "", "Public"] },
  { key: "momentum", type: "score", question: "How busy has the company been lately?", options: ["Quiet", "Some news", "Lots of news"] },
  { key: "refused", type: "yes_no", question: "Is the company about to be sold?" },
  { key: "unsure", type: "choice", question: "Where is the head office?", options: ["London", "Manchester"] },
];

describe("workflow web checks", () => {
  let owner: UserActor;
  let andrewId: string;
  let savedKey: string | undefined;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@decide.test", "Mark Ridgeon");
    const pulseId = (await createCompany(owner, { name: "Pulse", domain: "pulse.test", website: "https://pulse.test", lifecycle: "customer" })).body.company.id;
    andrewId = (await createContact(owner, { firstName: "Andrew", lastName: "Sanaghan", email: "andrew@pulse.test", jobTitle: "MD", companyId: pulseId })).body.contact.id;
    await createActivity(owner, { type: "note", title: "Private", body: "Secret pricing talk", contactId: andrewId, companyId: pulseId });
    savedKey = process.env.PARALLEL_API_KEY;
  });

  beforeEach(() => {
    process.env.PARALLEL_API_KEY = "test-parallel-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.PARALLEL_API_KEY;
    else process.env.PARALLEL_API_KEY = savedKey;
  });

  after(async () => {
    await getPool().end();
  });

  async function workflowWith(definition: WorkflowDefinition, active = true) {
    const workflow = await createWorkflow(owner, { name: "Web check" });
    await saveWorkflow(owner, workflow.id, { definition });
    if (active) await setWorkflowStatus(owner, workflow.id, "active");
    return workflow.id;
  }

  it("sends only public company details and maps every answer type", async () => {
    const id = await workflowWith(graph([node("decide_1", "decide", { about: "{{contact.name}}, {{contact.jobTitle}}", questions: QUESTIONS })], [{ source: "trigger", handle: "out", target: "decide_1" }]));
    const api = parallel(() => ({
      decision_id: "dec_1",
      answers: {
        hiring: { type: "noul", noul: 0.734 },
        funding: { type: "choice", choice: "o1", probabilities: { o0: 0.1, o1: 0.81, o2: 0.04, unknown: 0.05 } },
        momentum: { type: "score", score: 1.66, probabilities: { "0": 0.1, "1": 0.14, "2": 0.76 } },
        refused: { type: "refusal" },
        unsure: { type: "choice", choice: "unknown", probabilities: { o0: 0.2, o1: 0.1, unknown: 0.7 } },
      },
      citations: [
        ...Array.from({ length: 12 }, (_, index) => ({ url: `https://news.test/${index}`, title: null, excerpts: [] })),
        { url: "https://news.test/0", title: "Repeat", excerpts: [] },
      ],
    }));
    const result = await startRun(owner, id, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: api.fetchImpl });
    assert.equal(result.status, "succeeded");
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0].url, "https://api.parallel.ai/v1/decisions");
    assert.equal(api.sent[0].key, "test-parallel-key");

    const { state, questions } = api.sent[0].body;
    assert.deepEqual(Object.keys(state).sort(), ["about", "company", "domain", "today", "website"]);
    assert.equal(state.company, "Pulse");
    assert.equal(state.domain, "pulse.test");
    assert.equal(state.website, "https://pulse.test/");
    assert.match(String(state.today), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(state.about, "Andrew Sanaghan, MD");
    const raw = JSON.stringify(api.sent[0].body);
    assert.doesNotMatch(raw, /andrew@pulse\.test/);
    assert.doesNotMatch(raw, /Secret pricing/);

    assert.deepEqual(questions.hiring, { type: "noul", instructions: "Is the company hiring engineers?" });
    assert.deepEqual(questions.funding, {
      type: "choice",
      instructions: "How is the company funded?",
      criteria: { o0: "Bootstrapped", o1: "Venture backed", o2: "Public", unknown: "The evidence doesn't settle it." },
    });
    assert.deepEqual(questions.momentum, { type: "score", instructions: "How busy has the company been lately?", criteria: ["Quiet", "Some news", "Lots of news"] });

    const output = (await getRunSteps(owner, result.runId)).steps.find((step) => step.stepId === "decide_1")?.output as Record<string, unknown>;
    assert.equal(output.hiring, 73);
    assert.equal(output.funding, "Venture backed");
    assert.equal(output.fundingConfidence, 81);
    assert.equal(output.momentum, 1.7);
    assert.equal(output.refused, null);
    assert.equal(output.unsure, "");
    assert.equal(output.unsureConfidence, 70);
    assert.deepEqual(output.sources, Array.from({ length: 10 }, (_, index) => `https://news.test/${index}`));
  });

  it("leaves about out when it renders empty", async () => {
    const id = await workflowWith(graph([node("decide_1", "decide", { about: "  ", questions: [QUESTIONS[0]] })], [{ source: "trigger", handle: "out", target: "decide_1" }]));
    const api = parallel(() => ({ answers: { hiring: { type: "noul", noul: 0.5 } }, citations: [] }));
    const result = await startRun(owner, id, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: api.fetchImpl });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(Object.keys(api.sent[0].body.state).sort(), ["company", "domain", "today", "website"]);
  });

  it("runs in test runs and branches on the percentage with If", async () => {
    const id = await workflowWith(
      graph(
        [
          node("decide_1", "decide", { about: "", questions: [QUESTIONS[0]] }),
          node("if_1", "if", { match: "all", conditions: [{ left: "{{steps.decide_1.hiring}}", op: "greater_than", right: "60" }] }),
          node("notify_1", "notify", { to: "owner", title: "Hiring" }),
          node("notify_2", "notify", { to: "owner", title: "Not hiring" }),
        ],
        [
          { source: "trigger", handle: "out", target: "decide_1" },
          { source: "decide_1", handle: "out", target: "if_1" },
          { source: "if_1", handle: "true", target: "notify_1" },
          { source: "if_1", handle: "false", target: "notify_2" },
        ],
      ),
      false,
    );
    for (const [likelihood, expected] of [
      [0.82, "notify_1"],
      [0.31, "notify_2"],
    ] as const) {
      const api = parallel(() => ({ answers: { hiring: { type: "noul", noul: likelihood } }, citations: [] }));
      const result = await startRun(owner, id, { test: true, record: { type: "contact", id: andrewId }, fetchImpl: api.fetchImpl });
      assert.equal(result.status, "succeeded");
      assert.equal(api.sent.length, 1);
      const steps = (await getRunSteps(owner, result.runId)).steps.map((step) => step.stepId);
      assert.deepEqual(steps, ["decide_1", "if_1", expected]);
    }
  });

  it("fails clearly without a key and when a test run's check fails", async () => {
    const id = await workflowWith(graph([node("decide_1", "decide", { questions: [QUESTIONS[0]] })], [{ source: "trigger", handle: "out", target: "decide_1" }]));
    delete process.env.PARALLEL_API_KEY;
    const unused = parallel(() => ({}));
    const missing = await startRun(owner, id, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: unused.fetchImpl });
    assert.equal(missing.status, "failed");
    assert.equal(unused.sent.length, 0);
    const missingRun = await getRunSteps(owner, missing.runId);
    assert.equal(missingRun.run.error, "decide_1: Add PARALLEL_API_KEY in Vercel to run web checks.");
    assert.equal(missingRun.steps[0].error, "Add PARALLEL_API_KEY in Vercel to run web checks.");

    process.env.PARALLEL_API_KEY = "test-parallel-key";
    const broken = parallel(() => new Response("down", { status: 500 }));
    const failed = await startRun(owner, id, { test: true, record: { type: "contact", id: andrewId }, fetchImpl: broken.fetchImpl });
    assert.equal(failed.status, "failed");
    assert.equal((await getRunSteps(owner, failed.runId)).run.error, "decide_1: Parallel returned 500.");
  });

  it("rejects a bad key, a taken key or a wrong option count when the workflow is saved", async () => {
    const workflow = await createWorkflow(owner, { name: "Bad check" });
    const save = (questions: unknown[]) =>
      saveWorkflow(owner, workflow.id, { definition: graph([node("decide_1", "decide", { questions })], [{ source: "trigger", handle: "out", target: "decide_1" }]) });
    await assert.rejects(save([{ key: "funding", type: "choice", question: "How is it funded?", options: ["Bootstrapped", " "] }]), {
      message: "decide_1: funding: give 2 to 50 options.",
    });
    await assert.rejects(save([{ key: "momentum", type: "score", question: "How busy?", options: Array.from({ length: 11 }, (_, index) => `Level ${index}`) }]), {
      message: "decide_1: momentum: give 2 to 10 levels.",
    });
    await assert.rejects(save([{ key: "Hiring", type: "yes_no", question: "Hiring?" }]), {
      message: "decide_1: Hiring: start the key with a lowercase letter and use only letters, numbers and underscores.",
    });
    await assert.rejects(save([{ key: "sources", type: "yes_no", question: "Any?" }]), { message: "decide_1: sources: use a different key, this one is already taken." });
    await assert.rejects(
      save([
        { key: "funding", type: "choice", question: "How is it funded?", options: ["Bootstrapped", "Venture backed"] },
        { key: "fundingConfidence", type: "yes_no", question: "Sure?" },
      ]),
      { message: "decide_1: fundingConfidence: use a different key, this one is already taken." },
    );
    await save([QUESTIONS[0]]);
  });

  it("never sends email, call, note or contact details, even when a question or About asks for them", async () => {
    const definition = graph(
      [
        node("decide_1", "decide", {
          about: "{{email.text}} | {{call.transcript}} | {{call.summary}} | {{activity.body}} | {{contact.email}} | {{contact.phone}} | {{contact.jobTitle}}",
          questions: [{ key: "hiring", type: "yes_no", question: "Is {{company.name}} hiring? {{email.text}} {{call.transcript}} {{steps.ai_1.text}} {{loop.index}}" }],
        }),
      ],
      [{ source: "trigger", handle: "out", target: "decide_1" }],
    );
    const id = await workflowWith(definition);
    const vars = {
      trigger: { type: "manual", at: "2026-10-27T09:00:00.000Z" },
      today: "Tue 27 Oct 2026",
      owner: { id: owner.userId, name: "Mark Ridgeon", email: "mark@decide.test" },
      company: { id: "c1", name: "Pulse", domain: "pulse.test", website: "https://pulse.test/", healthReason: "Secret health reason" },
      contact: { id: "p1", name: "Andrew Sanaghan", email: "andrew@pulse.test", phone: "+44 7700 900123", jobTitle: "MD" },
      email: { text: "Secret email body", subject: "Secret subject" },
      call: { transcript: "Secret transcript", summary: "Secret call summary" },
      activity: { body: "Secret pricing talk" },
      loop: { item: "Pulse", index: 2, total: 3 },
      steps: { ai_1: { text: "Earlier answer" } },
    };
    const inserted = await getAdminPool().query<{ id: string }>(
      `insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, status, definition, state, claimed_at, started_at)
       values ($1, $2, $3, 'running', $4::jsonb, $5::jsonb, now(), now()) returning id`,
      [owner.workspaceId, id, owner.userId, JSON.stringify(definition), JSON.stringify({ started: true, at: "decide_1", vars, frames: [] })],
    );
    const api = parallel(() => ({ answers: { hiring: { type: "noul", noul: 0.5 } }, citations: [] }));
    const status = await executeRun(inserted.rows[0].id, owner.userId, owner.workspaceId, { deadline: Date.now() + 50_000, fetchImpl: api.fetchImpl });
    assert.equal(status, "succeeded");
    assert.equal(api.sent.length, 1);
    const raw = JSON.stringify(api.sent[0].body);
    for (const secret of [/Secret/, /andrew@pulse\.test/, /7700/]) assert.doesNotMatch(raw, secret);
    assert.equal(api.sent[0].body.state.about, "|  |  |  |  |  | MD");
    assert.equal(api.sent[0].body.questions.hiring.instructions, "Is Pulse hiring?   Earlier answer 2");
    const logged = JSON.stringify((await getRunSteps(owner, inserted.rows[0].id)).steps[0].input);
    assert.doesNotMatch(logged, /Secret/);
  });

  it("offers only public fields and earlier answers in a web check's picker", () => {
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "call_summary_ready" },
      triggerPosition: { x: 0, y: 0 },
      nodes: [
        node("ai_1", "ai", { prompt: "Read it", outputs: [{ key: "need", type: "text" }] }),
        node("decide_1", "decide", { questions: [QUESTIONS[0]] }),
        node("notify_1", "notify", { title: "Done" }),
      ],
      edges: [
        { source: "trigger", handle: "out", target: "ai_1" },
        { source: "ai_1", handle: "out", target: "decide_1" },
        { source: "decide_1", handle: "out", target: "notify_1" },
      ],
    };
    const paths = variableOptions(definition, "decide_1").map((option) => option.path);
    for (const path of ["company.name", "company.domain", "company.website", "company.industry", "company.lifecycle", "contact.name", "contact.jobTitle", "contact.linkedinUrl", "today", "trigger.at", "steps.ai_1.need"]) {
      assert.ok(paths.includes(path), path);
    }
    for (const path of ["call.transcript", "call.summary", "activity.body", "contact.email", "company.healthReason", "owner.name", "company.id"]) assert.ok(!paths.includes(path), path);
    const later = variableOptions(definition, "notify_1").map((option) => option.path);
    assert.ok(later.includes("call.transcript") && later.includes("contact.email"));
  });

  it("never counts a missing answer as 0 in more than or less than", () => {
    const vars = { steps: { decide_1: { refused: null, empty: "", zero: 0, score: 1.5 } } };
    for (const left of ["{{steps.decide_1.refused}}", "{{steps.decide_1.empty}}", "{{steps.decide_1.missing}}"]) {
      assert.equal(check({ left, op: "less_than", right: "60" }, vars), false);
      assert.equal(check({ left, op: "greater_than", right: "-1" }, vars), false);
    }
    assert.equal(check({ left: "{{steps.decide_1.zero}}", op: "less_than", right: "60" }, vars), true);
    assert.equal(check({ left: "{{steps.decide_1.score}}", op: "greater_than", right: "1" }, vars), true);
  });

  it("stops a question that is too long once its options and formatting are counted", async () => {
    const options = Array.from({ length: 50 }, (_, index) => `Option ${String(index).padStart(2, "0")}`);
    const id = await workflowWith(
      graph([node("decide_1", "decide", { questions: [{ key: "segment", type: "choice", question: "x".repeat(4000), options }] })], [{ source: "trigger", handle: "out", target: "decide_1" }]),
    );
    const api = parallel(() => ({}));
    const result = await startRun(owner, id, { test: true, record: { type: "contact", id: andrewId }, fetchImpl: api.fetchImpl });
    assert.equal(result.status, "failed");
    assert.equal(api.sent.length, 0);
    assert.equal((await getRunSteps(owner, result.runId)).run.error, "decide_1: segment: too long for a web check. Shorten the question or its options.");

    const about = await workflowWith(graph([node("decide_1", "decide", { about: "y".repeat(4001), questions: [QUESTIONS[0]] })], [{ source: "trigger", handle: "out", target: "decide_1" }]));
    const long = await startRun(owner, about, { test: true, record: { type: "contact", id: andrewId }, fetchImpl: api.fetchImpl });
    assert.equal((await getRunSteps(owner, long.runId)).run.error, "decide_1: About is too long for a web check. Shorten it.");
    assert.equal(api.sent.length, 0);
  });

  it("tries a busy check once more a minute later, then fails", async () => {
    const id = await workflowWith(graph([node("decide_1", "decide", { questions: [QUESTIONS[0]] })], [{ source: "trigger", handle: "out", target: "decide_1" }]));
    const due = (runId: string) => getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 second' where id = $1", [runId]);

    const busy = parallel(() => new Response("slow down", { status: 429 }));
    const first = await startRun(owner, id, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: busy.fetchImpl });
    assert.equal(first.status, "waiting");
    const waiting = await getRunSteps(owner, first.runId);
    assert.equal(waiting.run.waitingFor, "delay");
    assert.equal(waiting.steps[0].status, "waiting");
    assert.equal((waiting.steps[0].output as { retrying: string }).retrying, "Parallel is rate limiting. Try again shortly.");
    const resumeAt = (await getAdminPool().query<{ resume_at: Date }>("select resume_at from crm.workflow_runs where id = $1", [first.runId])).rows[0].resume_at;
    assert.ok(resumeAt.getTime() > Date.now() + 50_000);

    await due(first.runId);
    const healthy = parallel(() => ({ answers: { hiring: { type: "noul", noul: 0.9 } }, citations: [] }));
    await runWorkflowTick({ fetchImpl: healthy.fetchImpl, budgetMs: 30_000 });
    const recovered = await getRunSteps(owner, first.runId);
    assert.equal(recovered.run.status, "succeeded");
    assert.equal((recovered.steps.at(-1)?.output as { hiring: number }).hiring, 90);

    const down = parallel(() => new Response("down", { status: 503 }));
    const second = await startRun(owner, id, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: down.fetchImpl });
    assert.equal(second.status, "waiting");
    await due(second.runId);
    await runWorkflowTick({ fetchImpl: down.fetchImpl, budgetMs: 30_000 });
    const gaveUp = await getRunSteps(owner, second.runId);
    assert.equal(gaveUp.run.status, "failed");
    assert.equal(gaveUp.run.error, "decide_1: Parallel returned 503.");
  });
});
