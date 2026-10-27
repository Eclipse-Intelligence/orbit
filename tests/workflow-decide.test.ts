import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import type { WorkflowDefinition, WorkflowNode } from "@/lib/workflows/definition";
import { createWorkflow, getRunSteps, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
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

  it("fails clearly without a key, when Parallel fails, and when a question is incomplete", async () => {
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
    const failed = await startRun(owner, id, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: broken.fetchImpl });
    assert.equal(failed.status, "failed");
    assert.equal((await getRunSteps(owner, failed.runId)).run.error, "decide_1: Parallel returned 500.");

    const short = await workflowWith(
      graph([node("decide_1", "decide", { questions: [{ key: "funding", type: "choice", question: "How is it funded?", options: ["Bootstrapped"] }] })], [{ source: "trigger", handle: "out", target: "decide_1" }]),
    );
    const none = parallel(() => ({}));
    const invalid = await startRun(owner, short, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: none.fetchImpl });
    assert.equal(invalid.status, "failed");
    assert.equal(none.sent.length, 0);
    assert.equal((await getRunSteps(owner, invalid.runId)).run.error, "decide_1: funding: give 2 to 50 options.");
  });
});
