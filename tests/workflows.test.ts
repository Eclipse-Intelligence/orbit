import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createActivity, listActivities } from "@/lib/crm/activities";
import { summariseCall } from "@/lib/crm/call-insights";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { listTasks } from "@/lib/crm/tasks";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { resetLinearCache } from "@/lib/linear";
import { nextScheduleRun, safeDefinition, type WorkflowDefinition } from "@/lib/workflows/definition";
import { automatedNote, workflowEmailBody } from "@/lib/workflows/engine";
import { runWorkflowTick } from "@/lib/workflows/engine";
import {
  approvalEmail,
  createWorkflow,
  decideApproval,
  getRunSteps,
  listApprovals,
  listNotifications,
  listRuns,
  listWorkflows,
  saveWorkflow,
  setWorkflowStatus,
  setWorkflowTemplate,
  startRun,
} from "@/lib/workflows/store";
import { check, render } from "@/lib/workflows/variables";
import { createUser, resetDatabase } from "./helpers";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500
<v Mark Ridgeon>How is the rollout going?</v>

00:00:03.500 --> 00:00:09.000
<v Jane Doe>Honestly we're frustrated. We need SSO and a CSV export or finance will push back on renewal.</v>
`;

const SUMMARY = {
  summary: "Jane is frustrated with the rollout and needs SSO and CSV export before renewal.",
  keyPoints: ["Rollout is behind", "Renewal at risk"],
  actionItems: [],
  health: "at_risk",
  healthReason: "Finance may push back on renewal",
};

const HAPPY_SUMMARY = { ...SUMMARY, health: "healthy", healthReason: "Jane is pleased with the rollout" };

function fakes(replies: Record<string, unknown>[], summary: Record<string, unknown> = SUMMARY) {
  const ai: { system: string; user: string; model: string }[] = [];
  const linear: { title: string; priority?: number }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.includes("linear")) {
      if (String(body.query).includes("teams(")) {
        return Response.json({
          data: { teams: { nodes: [{ id: "team-1", key: "CNT", name: "Cntent", states: { nodes: [] }, labels: { nodes: [] } }] } },
        });
      }
      const issueInput = body.variables.input as { title: string; priority?: number };
      linear.push({ title: issueInput.title, priority: issueInput.priority });
      const number = 40 + linear.length;
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: `issue-${number}`,
              identifier: `CNT-${number}`,
              title: issueInput.title,
              url: `https://linear.app/cntent/issue/cnt-${number}`,
              priorityLabel: "Medium",
              createdAt: "2026-10-19T09:00:00Z",
              updatedAt: "2026-10-19T09:00:00Z",
              state: { name: "Todo", type: "unstarted" },
              assignee: null,
              project: null,
              labels: { nodes: [] },
            },
          },
        },
      });
    }
    const messages = body.messages as { role: string; content: string }[];
    const system = messages[0].content;
    const user = messages[1].content;
    const reply = system.includes("automated workflow") ? replies[Math.min(ai.length, replies.length - 1)] : summary;
    if (system.includes("automated workflow")) ai.push({ system, user, model: body.model });
    return Response.json({ model: body.model, choices: [{ message: { role: "assistant", content: JSON.stringify(reply) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, ai, linear };
}

const AT_RISK = { health: "at risk", reason: "Finance may push back on renewal", requests: ["Add SSO", "CSV export"] };
const HEALTHY = { health: "Healthy", reason: "All good", requests: [] };

describe("workflow variables", () => {
  it("renders fields, lists and conditions", () => {
    const vars = { company: { name: "Acme" }, steps: { ai_1: { risks: ["A", "B"], health: "At risk", score: 7 } } };
    assert.equal(render("{{company.name}} risks:\n{{steps.ai_1.risks}}", vars), "Acme risks:\n- A\n- B");
    assert.equal(render("{{missing.value}}!", vars), "!");
    assert.equal(check({ left: "{{steps.ai_1.health}}", op: "is", right: "at risk" }, vars), true);
    assert.equal(check({ left: "{{steps.ai_1.risks}}", op: "is_not_empty" }, vars), true);
    assert.equal(check({ left: "{{steps.ai_1.risks}}", op: "contains", right: "b" }, vars), true);
    assert.equal(check({ left: "{{steps.ai_1.score}}", op: "greater_than", right: "5" }, vars), true);
    assert.equal(check({ left: "{{steps.ai_1.nothing}}", op: "is_empty" }, vars), true);
  });

  it("works out the next scheduled run in London time", () => {
    const next = nextScheduleRun({ type: "schedule", frequency: "weekly", weekday: 1, time: "09:00" }, new Date("2026-10-19T10:00:00Z"), "Europe/London");
    assert.equal(next.toISOString(), "2026-10-26T09:00:00.000Z");
    const daily = nextScheduleRun({ type: "schedule", frequency: "daily", time: "07:30" }, new Date("2026-11-02T06:00:00Z"), "Europe/London");
    assert.equal(daily.toISOString(), "2026-11-02T07:30:00.000Z");
  });
});

describe("workflows", () => {
  let owner: UserActor;
  let member: UserActor;
  let companyId: string;
  let contactId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@flows.test", "Mark Ridgeon");
    companyId = (await createCompany(owner, { name: "Acme Flows", domain: "acme-flows.test", ownerId: owner.userId })).body.company.id;
    contactId = (await createContact(owner, { firstName: "Jane", lastName: "Doe", companyId, email: "jane@acme-flows.test", jobTitle: "COO" })).body.contact.id;
    const admin = getAdminPool();
    const sam = (await admin.query<{ id: string }>("select private.create_local_user('sam@flows.test', 'password-123', 'Sam Colleague') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    member = { ...owner, userId: sam, email: "sam@flows.test", fullName: "Sam Colleague", role: "member", scopes: scopesForRole("member") };
  });

  beforeEach(() => {
    process.env.LLM_API_KEY = "test-llm-key";
    process.env.LINEAR_API_KEY = "lin_api_test";
    resetLinearCache();
  });

  after(async () => {
    delete process.env.LINEAR_API_KEY;
    await getPool().end();
  });

  async function call(title: string) {
    return (await createActivity(owner, { type: "call", title, contactId, companyId, occurredAt: new Date().toISOString() })).body.activity.id;
  }

  it("runs the starter templates: follows up when a call leaves a client at risk, and waits for approval before Linear", async () => {
    const risk = await createWorkflow(owner, { template: "at-risk-follow-up" });
    const requests = await createWorkflow(owner, { template: "requests-to-linear" });
    assert.equal(risk.name, "Follow up when a client turns at risk");
    assert.equal(risk.definition.nodes.length, 2);
    await setWorkflowStatus(owner, risk.id, "active");
    await setWorkflowStatus(owner, requests.id, "active");

    const llm = fakes([AT_RISK]);
    await summariseCall(owner, await call("Rollout check-in"), VTT, { source: "manual", fetchImpl: llm.fetchImpl, autoAccept: false });
    const tick = await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000 });
    assert.equal(tick.processed, 2);
    assert.equal(llm.ai.length, 1);
    assert.match(llm.ai[0].user, /Acme Flows/);
    assert.match(llm.ai[0].user, /needs SSO and CSV export/);

    const alerts = await listNotifications(owner);
    assert.ok(alerts.some((item) => item.title === "Acme Flows looks at risk" && item.body === "Finance may push back on renewal"));
    const followUp = (await listTasks(owner, { view: "all", companyId })).data.find((task) => task.title === "Check in with Acme Flows");
    assert.equal(followUp?.description, "Health turned At risk: Finance may push back on renewal");
    const approvals = await listApprovals(owner);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].title, "Create Linear issues for Acme Flows?");
    assert.equal(approvals[0].details, "- Add SSO\n- CSV export");
    assert.equal(llm.linear.length, 0);

    const status = await decideApproval(owner, approvals[0].runId, { approved: true }, { fetchImpl: llm.fetchImpl });
    assert.equal(status, "succeeded");
    assert.deepEqual(
      llm.linear.map((issue) => issue.title),
      ["Add SSO", "CSV export"],
    );
    const { run, steps } = await getRunSteps(owner, approvals[0].runId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.companyName, "Acme Flows");
    assert.deepEqual(
      steps.filter((step) => step.status === "succeeded").map((step) => step.stepId),
      ["ai_1", "if_1", "approval_1", "loop_1", "linear_issue_1", "linear_issue_1"],
    );
    assert.deepEqual(await listApprovals(owner), []);
  });

  it("fills a Linear priority from an earlier step, and leaves it unset when the value isn't a priority", async () => {
    const workflow = await createWorkflow(owner, { name: "Priority from a step" });
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "manual", object: "company" },
      triggerPosition: { x: 0, y: 0 },
      nodes: [
        { id: "linear_issue_1", type: "linear_issue", config: { title: "Issue for {{company.name}}", priority: "{{company.name}}" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ source: "trigger", handle: "out", target: "linear_issue_1" }],
    };
    await saveWorkflow(owner, workflow.id, { definition });
    await setWorkflowStatus(owner, workflow.id, "active");
    const low = (await createCompany(owner, { name: "Low", domain: "low-priority.test" })).body.company.id;
    const other = (await createCompany(owner, { name: "Someone Else", domain: "someone-else.test" })).body.company.id;
    const llm = fakes([]);
    assert.equal((await startRun(owner, workflow.id, { test: false, record: { type: "company", id: low }, fetchImpl: llm.fetchImpl })).status, "succeeded");
    const unset = await startRun(owner, workflow.id, { test: false, record: { type: "company", id: other }, fetchImpl: llm.fetchImpl });
    assert.equal(unset.status, "succeeded");
    assert.deepEqual(llm.linear, [
      { title: "Issue for Low", priority: 4 },
      { title: "Issue for Someone Else", priority: undefined },
    ]);
    const { steps } = await getRunSteps(owner, unset.runId);
    assert.match(JSON.stringify(steps.at(-1)!.output), /isn't urgent, high, medium or low, so the issue has no priority/);
  });

  it("adds a line saying an email was sent automatically when the step asks for it", () => {
    const actor = { workspaceName: "Eclipse", fullName: "Mark Ridgeon", email: "mark@eclipse.test" };
    const vars = { contact: { firstName: "Sam" } };
    assert.equal(workflowEmailBody({ body: "Hi {{contact.firstName}},\n\nLogged.\n\nEclipse Assistant" }, vars, actor), "Hi Sam,\n\nLogged.\n\nEclipse Assistant");
    assert.equal(
      workflowEmailBody({ body: "Hi {{contact.firstName}},\n\nLogged.", automated: true }, vars, actor),
      "Hi Sam,\n\nLogged.\n\nThis reply was written and sent by Eclipse's automated assistant on Mark's behalf. Reply to this email if you'd like to reach Mark directly.",
    );
    assert.match(automatedNote({ workspaceName: "My workspace", fullName: null, email: "sam@x.test" }), /^This reply was written and sent by an automated assistant on sam@x\.test's behalf/);
    assert.equal(workflowEmailBody({ body: "", automated: true }, vars, actor), "");
  });

  it("links an approval back to the email that started it", () => {
    assert.deepEqual(approvalEmail({ vars: { email: { subject: "Fireflies", url: "https://orbit.test/mail?thread=s1%7Cm%3A1" } } }), {
      subject: "Fireflies",
      href: "/mail?thread=s1%7Cm%3A1",
    });
    assert.deepEqual(approvalEmail({ vars: { email: { subject: " ", url: "/mail?thread=x" } } }), { subject: "the email", href: "/mail?thread=x" });
    assert.equal(approvalEmail({ vars: { email: { subject: "x", url: "https://evil.test/phish" } } }), null);
    assert.equal(approvalEmail({ vars: { company: { name: "Acme" } } }), null);
    assert.equal(approvalEmail(null), null);
  });

  it("takes the quiet path for a healthy call, and stops when an approval is rejected", async () => {
    const healthy = fakes([HEALTHY], HAPPY_SUMMARY);
    const before = (await listNotifications(owner)).length;
    await summariseCall(owner, await call("Happy check-in"), VTT, { source: "manual", fetchImpl: healthy.fetchImpl, autoAccept: false });
    await runWorkflowTick({ fetchImpl: healthy.fetchImpl, budgetMs: 30_000 });
    assert.deepEqual(await listApprovals(owner), []);
    assert.equal((await listNotifications(owner)).length, before);
    assert.equal(healthy.linear.length, 0);

    const risky = fakes([AT_RISK]);
    await summariseCall(owner, await call("Tense check-in"), VTT, { source: "manual", fetchImpl: risky.fetchImpl, autoAccept: false });
    await runWorkflowTick({ fetchImpl: risky.fetchImpl, budgetMs: 30_000 });
    const [approval] = await listApprovals(owner);
    assert.equal(await decideApproval(owner, approval.runId, { approved: false, note: "Not yet" }, { fetchImpl: risky.fetchImpl }), "cancelled");
    assert.equal(risky.linear.length, 0);
    await assert.rejects(decideApproval(owner, approval.runId, { approved: true }), /already been dealt with/);
  });

  it("test runs a workflow against a record without changing anything", async () => {
    const workflow = (await listWorkflows(owner)).mine.find((item) => item.name === "Follow up when a client turns at risk")!;
    const before = (await listNotifications(owner)).length;
    const llm = fakes([AT_RISK]);
    const result = await startRun(owner, workflow.id, { test: true, record: { type: "company", id: companyId }, fetchImpl: llm.fetchImpl });
    assert.equal(result.status, "succeeded");
    assert.equal((await listNotifications(owner)).length, before);
    const { steps } = await getRunSteps(owner, result.runId);
    const alert = steps.find((step) => step.stepId === "notify_1");
    assert.deepEqual((alert?.output as { testRun: boolean }).testRun, true);
    assert.match(JSON.stringify(alert?.output), /Acme Flows looks at risk/);
    const runs = await listRuns(owner, workflow.id);
    assert.ok(runs.some((item) => item.test));
  });

  it("reads older step lists as a graph, and refuses broken graphs", async () => {
    const legacy = safeDefinition({
      trigger: { type: "manual", object: "company" },
      steps: [
        { id: "if_1", type: "if", config: {}, then: [{ id: "notify_1", type: "notify", config: {} }], else: [] },
        { id: "add_note_1", type: "add_note", config: {} },
      ],
    });
    assert.ok(legacy);
    assert.deepEqual(
      legacy.edges.map((edge) => `${edge.source}:${edge.handle}>${edge.target}`).sort(),
      ["if_1:false>add_note_1", "if_1:true>notify_1", "notify_1:out>add_note_1", "trigger:out>if_1"],
    );
    assert.ok(legacy.nodes.every((node) => node.position.y > 0));

    const workflow = await createWorkflow(owner, { name: "Broken" });
    const nodes = [
      { id: "notify_1", type: "notify" as const, config: {}, position: { x: 300, y: 0 } },
      { id: "notify_2", type: "notify" as const, config: {}, position: { x: 600, y: 0 } },
    ];
    const base = { version: 2 as const, trigger: { type: "manual" as const, object: "company" as const }, triggerPosition: { x: 0, y: 0 }, nodes };
    await assert.rejects(
      saveWorkflow(owner, workflow.id, {
        definition: { ...base, edges: [{ source: "notify_1", handle: "out", target: "notify_2" }, { source: "notify_2", handle: "out", target: "notify_1" }] },
      }),
      /can't loop back/,
    );
    await assert.rejects(
      saveWorkflow(owner, workflow.id, {
        definition: { ...base, edges: [{ source: "trigger", handle: "out", target: "notify_1" }, { source: "trigger", handle: "out", target: "notify_2" }] },
      }),
      /only connect to one node/,
    );
    await assert.rejects(
      saveWorkflow(owner, workflow.id, { definition: { ...base, edges: [{ source: "notify_1", handle: "true", target: "notify_2" }] } }),
      /output the node doesn't have/,
    );
  });

  it("waits on a delay, keeps workflows personal, and shares them as templates", async () => {
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "manual", object: "company" },
      triggerPosition: { x: 0, y: 0 },
      nodes: [
        { id: "delay_1", type: "delay", config: { amount: 1, unit: "hours" }, position: { x: 300, y: 0 } },
        { id: "add_note_1", type: "add_note", config: { title: "Checked in", body: "Follow-up check for {{company.name}}" }, position: { x: 600, y: 0 } },
      ],
      edges: [
        { source: "trigger", handle: "out", target: "delay_1" },
        { source: "delay_1", handle: "out", target: "add_note_1" },
      ],
    };
    const workflow = await createWorkflow(member, { name: "Hour later note" });
    await saveWorkflow(member, workflow.id, { definition });
    await setWorkflowStatus(member, workflow.id, "active");
    const started = await startRun(member, workflow.id, { test: false, record: { type: "company", id: companyId } });
    assert.equal(started.status, "waiting");
    await runWorkflowTick({ budgetMs: 15_000 });
    assert.equal((await getRunSteps(member, started.runId)).run.status, "waiting");
    await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 minute' where id = $1", [started.runId]);
    await runWorkflowTick({ budgetMs: 15_000 });
    assert.equal((await getRunSteps(member, started.runId)).run.status, "succeeded");
    const notes = await listActivities(owner, { companyId, type: "note" });
    assert.equal(notes.data[0].title, "Checked in");

    await assert.rejects(saveWorkflow(member, (await listWorkflows(owner)).mine[0].id, { name: "Mine now" }), /not found|Only the person/);
    const ownerFlow = (await listWorkflows(owner)).mine.find((item) => item.name === "Follow up when a client turns at risk")!;
    await assert.rejects(getRunSteps(member, (await listRuns(owner, ownerFlow.id))[0].id), /Run not found/);
    assert.deepEqual((await listWorkflows(owner)).templates, []);

    await setWorkflowTemplate(member, workflow.id, true);
    const shared = (await listWorkflows(owner)).templates;
    assert.deepEqual(
      shared.map((item) => [item.name, item.ownerName]),
      [["Hour later note", "Sam Colleague"]],
    );
    const copy = await createWorkflow(owner, { template: workflow.id });
    assert.equal(copy.mine, true);
    assert.equal(copy.status, "draft");
    assert.deepEqual(
      copy.definition.nodes.map((node) => node.id),
      ["delay_1", "add_note_1"],
    );
  });

  it("explains a failed step and tells the owner", async () => {
    const workflow = await createWorkflow(owner, { name: "Email the contact" });
    await saveWorkflow(owner, workflow.id, {
      definition: {
        version: 2,
        trigger: { type: "manual", object: "company" },
        triggerPosition: { x: 0, y: 0 },
        nodes: [{ id: "send_email_1", type: "send_email", config: { subject: "Hi", body: "Hello {{contact.firstName}}" }, position: { x: 300, y: 0 } }],
        edges: [{ source: "trigger", handle: "out", target: "send_email_1" }],
      },
    });
    await setWorkflowStatus(owner, workflow.id, "active");
    const started = await startRun(owner, workflow.id, { test: false, record: { type: "company", id: companyId } });
    assert.equal(started.status, "failed");
    const { run } = await getRunSteps(owner, started.runId);
    assert.match(run.error ?? "", /send_email_1: This run has no contact to work on/);
    assert.ok((await listNotifications(owner)).some((item) => item.title === "Email the contact failed"));
    await assert.rejects(setWorkflowStatus(owner, (await createWorkflow(owner, {})).id, "active"), /Connect the trigger to a node/);
  });
});
