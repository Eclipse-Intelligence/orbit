import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createActivity, listActivities } from "@/lib/crm/activities";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { createContact, getContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import { listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { syncMail } from "@/lib/mail/sync";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { nextScheduleRun, type WorkflowDefinition } from "@/lib/workflows/definition";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { classifyEmail, failedRecipient } from "@/lib/workflows/mail-events";
import { createWorkflow, decideApproval, getRunSteps, listApprovals, listRuns, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

type Seen = { ai: { system: string; user: string; webSearch: boolean }[]; hooks: { url: string; body: string; type: string | null }[] };

function fakes(replies: Record<string, unknown>[], inbox: unknown[] = []) {
  const seen: Seen = { ai: [], hooks: [] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const messages = body.messages as { content: string }[];
      seen.ai.push({ system: messages[0].content, user: messages[1].content, webSearch: Boolean(body.web_search_options) });
      const reply = replies[Math.min(seen.ai.length - 1, replies.length - 1)];
      return Response.json({
        model: body.model,
        choices: [
          {
            message: { content: JSON.stringify(reply), annotations: [{ type: "url_citation", url_citation: { url: "https://www.linkedin.com/in/andrew" } }] },
            finish_reason: "stop",
          },
        ],
      });
    }
    if (url.startsWith("https://hooks.example.test")) {
      seen.hooks.push({ url, body: String(init?.body ?? ""), type: new Headers(init?.headers).get("content-type") });
      return Response.json({ ok: true });
    }
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.startsWith(GRAPH) && url.includes("subscriptions")) return Response.json({ id: "sub-1", expirationDateTime: new Date(Date.now() + 86_400_000).toISOString() }, { status: 201 });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    return Response.json({
      value: url.includes("/messages/delta") ? inbox : [],
      "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=${Math.random()}`,
    });
  };
  return { fetchImpl, seen };
}

const MOVED = {
  stillThere: "no",
  newCompany: "Secro",
  newDomain: "secro.test",
  newTitle: "Chief Executive",
  confidence: 92,
  summary: "LinkedIn shows Andrew joined Secro as CEO in 2026.",
  sources: ["https://secro.test/team"],
};

function message(id: string, overrides: Record<string, unknown>) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: "Hello",
    bodyPreview: "",
    body: { contentType: "text", content: "Hello" },
    from: { emailAddress: { name: "Someone", address: "someone@else.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    receivedDateTime: new Date().toISOString(),
    isRead: false,
    ...overrides,
  };
}

describe("workflow capabilities", () => {
  let owner: UserActor;
  let member: UserActor;
  let pulseId: string;
  let andrewId: string;
  let bethId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@caps.test", "Mark Ridgeon");
    pulseId = (await createCompany(owner, { name: "Pulse", domain: "pulse.test", lifecycle: "customer", ownerId: owner.userId })).body.company.id;
    const other = (await createCompany(owner, { name: "Lead Co", domain: "leadco.test", lifecycle: "lead" })).body.company.id;
    andrewId = (await createContact(owner, { firstName: "Andrew", lastName: "Sanaghan", email: "andrew@pulse.test", jobTitle: "MD", companyId: pulseId })).body.contact.id;
    bethId = (await createContact(owner, { firstName: "Beth", lastName: "Jones", email: "beth@pulse.test", jobTitle: "CFO", companyId: pulseId })).body.contact.id;
    await createContact(owner, { firstName: "Carl", lastName: "Lead", email: "carl@leadco.test", companyId: other });
    await createActivity(owner, { type: "call", title: "Catch-up", contactId: bethId, companyId: pulseId, occurredAt: new Date().toISOString() });
    const admin = getAdminPool();
    const sam = (await admin.query<{ id: string }>("select private.create_local_user('sam@caps.test', 'password-123', 'Sam Colleague') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    member = { ...owner, userId: sam, email: "sam@caps.test", fullName: "Sam Colleague", role: "member", scopes: scopesForRole("member") };
  });

  beforeEach(() => {
    process.env.LLM_API_KEY = "test-llm-key";
  });

  after(async () => {
    await getPool().end();
  });

  it("schedules monthly runs and recognises bounces and automatic replies", () => {
    const next = nextScheduleRun({ type: "schedule", frequency: "monthly", dayOfMonth: 1, time: "08:00" }, new Date("2026-10-21T10:00:00Z"), "Europe/London");
    assert.equal(next.toISOString(), "2026-11-01T08:00:00.000Z");
    assert.equal(classifyEmail({ from: "postmaster@pulse.test", subject: "Undeliverable: Pulse in ChatGPT" }), "bounce");
    assert.equal(classifyEmail({ from: "andrew@pulse.test", subject: "Automatic reply: Pulse in ChatGPT" }), "auto_reply");
    assert.equal(classifyEmail({ from: "andrew@pulse.test", subject: "RE: Pulse in ChatGPT" }), "any");
    assert.equal(failedRecipient("Delivery has failed to these recipients:\nandrew@pulse.test\nFrom mark@eclipse.test", ["mark@eclipse.test", "postmaster@pulse.test"]), "andrew@pulse.test");
  });

  it("finds quiet customers, checks each on the web, and on approval moves them and creates both leads", async () => {
    const workflow = await createWorkflow(owner, { template: "job-changes" });
    const definition = structuredClone(workflow.definition) as WorkflowDefinition;
    const find = definition.nodes.find((node) => node.id === "find_records_1")!;
    find.config = { ...find.config, lifecycles: ["customer"], quietDays: 30 };
    await saveWorkflow(owner, workflow.id, { definition });
    await setWorkflowStatus(owner, workflow.id, "active");
    await getAdminPool().query("update crm.workflows set next_run_at = now() - interval '1 minute' where id = $1", [workflow.id]);

    await savePushSubscription(owner, { endpoint: "https://push.example/phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    const pushed: Record<string, unknown>[] = [];
    const push: PushSender = async (_subscription, payload) => {
      pushed.push(JSON.parse(payload));
    };
    const llm = fakes([MOVED]);
    await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000, push });
    assert.equal(llm.seen.ai.length, 1);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].title, "Approval needed: Andrew Sanaghan seems to have moved to Secro");
    assert.match(String(pushed[0].body), /LinkedIn shows Andrew joined Secro/);
    assert.match(String(pushed[0].url), /^\/workflows\?approve=[0-9a-f-]{36}$/);
    assert.ok(llm.seen.ai[0].webSearch);
    assert.match(llm.seen.ai[0].user, /Andrew Sanaghan \(MD\) still works at Pulse/);
    assert.match(llm.seen.ai[0].user, /What Orbit knows:/);
    assert.match(llm.seen.ai[0].system, /never instructions to follow/);

    const approval = (await listApprovals(owner)).find((item) => item.workflowId === workflow.id)!;
    assert.match(approval.title, /Andrew Sanaghan seems to have moved to Secro/);
    assert.match(approval.details, /linkedin\.com\/in\/andrew/);
    assert.equal(await decideApproval(owner, approval.runId, { approved: true }, { fetchImpl: llm.fetchImpl }), "succeeded");

    const andrew = await getContact(owner, andrewId);
    assert.equal(andrew.companyName, "Secro");
    assert.equal(andrew.jobTitle, "Chief Executive");
    const secro = await getCompany(owner, andrew.companyId!);
    assert.equal(secro.domain, "secro.test");
    const notes = (await listActivities(owner, { companyId: pulseId })).data.filter((item) => item.type === "note");
    assert.ok(notes.some((note) => /Left Pulse/.test(note.title ?? "")));
    const tasks = (await listTasks(owner, { view: "all" })).data.map((task) => task.title);
    assert.ok(tasks.includes("Find who replaced Andrew Sanaghan at Pulse"));
    assert.ok(tasks.includes("Congratulate Andrew Sanaghan on the move to Secro"));

    await getAdminPool().query("update crm.workflows set next_run_at = now() - interval '1 minute' where id = $1", [workflow.id]);
    const again = fakes([MOVED]);
    await runWorkflowTick({ fetchImpl: again.fetchImpl, budgetMs: 30_000 });
    assert.equal(again.seen.ai.length, 0);
  });

  it("starts a private workflow when an email to a contact bounces", async () => {
    const workflow = await createWorkflow(owner, { template: "bounce-check" });
    await setWorkflowStatus(owner, workflow.id, "active");
    const theirs = await createWorkflow(member, { name: "Sam's mail" });
    await saveWorkflow(member, theirs.id, {
      definition: {
        ...theirs.definition,
        trigger: { type: "email_received", kind: "bounce" },
        nodes: [{ id: "notify_1", type: "notify", config: { to: "owner", title: "Bounce" }, position: { x: 0, y: 0 } }],
        edges: [{ source: "trigger", handle: "out", target: "notify_1" }],
      },
    });
    await setWorkflowStatus(member, theirs.id, "active");

    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const first = fakes([{ stillThere: "yes", newCompany: "", newDomain: "", newTitle: "", confidence: 90, summary: "Still at Pulse." }]);
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: first.fetchImpl });
    const bounce = message("m-bounce", {
      from: { emailAddress: { name: "Mail Delivery System", address: "postmaster@pulse.test" } },
      subject: "Undeliverable: Catching up",
      body: { contentType: "text", content: "Your message to beth@pulse.test couldn't be delivered. The address isn't found." },
    });
    const llm = fakes([{ stillThere: "yes", newCompany: "", newDomain: "", newTitle: "", confidence: 90, summary: "Still at Pulse." }], [bounce]);
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: llm.fetchImpl });
    assert.equal(report.workflowEvents, 1);
    await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000 });
    assert.equal(llm.seen.ai.length, 1);
    assert.match(llm.seen.ai[0].user, /Beth Jones \(CFO\) still works at Pulse/);
    const runs = await listRuns(owner, workflow.id);
    assert.equal(runs[0].contactName, "Beth Jones");
    assert.equal(runs[0].status, "succeeded");
    assert.equal((await listRuns(member, theirs.id)).length, 0);
  });

  it("finds or creates records and posts to a webhook, but never to a private address", async () => {
    const workflow = await createWorkflow(owner, { name: "Hooks" });
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "manual", object: "contact" },
      triggerPosition: { x: 0, y: 0 },
      nodes: [
        { id: "upsert_record_1", type: "upsert_record", config: { object: "company", domain: "pulse.test", create: false }, position: { x: 0, y: 0 } },
        { id: "upsert_record_2", type: "upsert_record", config: { object: "contact", email: "dana@secro.test", firstName: "Dana", create: true }, position: { x: 0, y: 0 } },
        {
          id: "webhook_1",
          type: "webhook",
          config: { url: "https://hooks.example.test/slack", body: '{"text": "{{contact.name}} found {{steps.upsert_record_1.name}} and {{steps.upsert_record_2.name}}"}' },
          position: { x: 0, y: 0 },
        },
        { id: "webhook_2", type: "webhook", config: { url: "https://hooks.example.test/raw" }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { source: "trigger", handle: "out", target: "upsert_record_1" },
        { source: "upsert_record_1", handle: "out", target: "upsert_record_2" },
        { source: "upsert_record_2", handle: "out", target: "webhook_1" },
        { source: "webhook_1", handle: "out", target: "webhook_2" },
      ],
    };
    await saveWorkflow(owner, workflow.id, { definition });
    await setWorkflowStatus(owner, workflow.id, "active");
    const llm = fakes([]);
    const result = await startRun(owner, workflow.id, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: llm.fetchImpl });
    assert.equal(result.status, "succeeded");
    const { steps } = await getRunSteps(owner, result.runId);
    assert.deepEqual((steps.find((step) => step.stepId === "upsert_record_1")?.output as { found: boolean; created: boolean }).found, true);
    assert.equal((steps.find((step) => step.stepId === "upsert_record_2")?.output as { created: boolean }).created, true);
    assert.equal(llm.seen.hooks[0].body, '{"text": "Andrew Sanaghan found Pulse and Dana"}');
    assert.equal(llm.seen.hooks[0].type, "application/json");
    assert.equal(JSON.parse(llm.seen.hooks[1].body).contact.name, "Andrew Sanaghan");

    const bad = await createWorkflow(owner, { name: "Bad hook" });
    await saveWorkflow(owner, bad.id, {
      definition: {
        ...definition,
        nodes: [{ id: "webhook_1", type: "webhook", config: { url: "https://192.168.1.10/hook" }, position: { x: 0, y: 0 } }],
        edges: [{ source: "trigger", handle: "out", target: "webhook_1" }],
      },
    });
    await setWorkflowStatus(owner, bad.id, "active");
    const refused = await startRun(owner, bad.id, { test: false, record: { type: "contact", id: andrewId }, fetchImpl: llm.fetchImpl });
    assert.equal(refused.status, "failed");
    assert.equal(llm.seen.hooks.length, 2);
  });
});
