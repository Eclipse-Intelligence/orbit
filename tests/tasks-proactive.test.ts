import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getConversation, openBrief } from "@/lib/assistant/chat";
import { offersCreateThose } from "@/lib/assistant/brief-dock";
import { createCompany } from "@/lib/crm/companies";
import { recordCommunication } from "@/lib/crm/communications";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import { createOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { completeTask, createTask, listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { suggestsTasks } from "@/lib/learning/brief-format";
import { latestBrief, runUnit } from "@/lib/learning/nightly";
import { cleanSubject, followUpTitle, loggedTitle, subjectTitle } from "@/lib/mail/follow-up-title";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, decideApproval, getRunSteps, listApprovals, listRuns, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { dayWindow } from "@/lib/time";
import { createAgent, createUser, resetDatabase } from "./helpers";

const DAY = 86_400_000;

function reply(content: unknown) {
  return Response.json({ model: "test", choices: [{ message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }] });
}

function scripted(answer: (system: string, user: string) => unknown) {
  const seen: { system: string; user: string }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const [system, user] = body.messages.map((message) => message.content);
    seen.push({ system, user });
    return reply(answer(system, user));
  };
  return { fetchImpl, seen };
}

async function backdateOpportunity(id: string, days: number) {
  const client = await getAdminPool().connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update crm.opportunities set created_at = $2 where id = $1", [id, new Date(Date.now() - days * DAY)]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

describe("tasks, proactive", () => {
  let owner: UserActor;
  let sam: UserActor;
  let companyId = "";
  let contactId = "";
  let opportunityId = "";

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@proactive.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const samId = (await admin.query<{ id: string }>("select private.create_local_user('sam@proactive.test', 'password-123', 'Sam Colleague') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, samId]);
    sam = { ...owner, userId: samId, email: "sam@proactive.test", fullName: "Sam Colleague", role: "member", scopes: scopesForRole("member") };
    companyId = (await createCompany(owner, { name: "Hooli", domain: "hooli-proactive.test" })).body.company.id;
    contactId = (await createContact(owner, { companyId, firstName: "Gavin", lastName: "Belson", email: "gavin@hooli-proactive.test" })).body.contact.id;
    const stages = (await listPipeline(owner)).stages;
    opportunityId = (await createOpportunity(owner, { companyId, name: "Hooli renewal", stageId: stages[0].id, primaryContactId: contactId, ownerId: owner.userId })).body.opportunity.id;
    await backdateOpportunity(opportunityId, 12);
    process.env.LLM_API_KEY = "llm-test";
  });

  after(async () => {
    delete process.env.LLM_API_KEY;
    await getPool().end();
    await getAdminPool().end();
  });

  it("lists the person's own overdue and due-today tasks in the brief and suggests a task for each quiet opportunity", async () => {
    const window = dayWindow();
    const admin = getAdminPool();
    const overdue = (await createTask(owner, { title: "Send [the] pricing", ownerId: owner.userId })).body.task;
    await admin.query("update crm.tasks set due_at = $2, due_has_time = false where id = $1", [overdue.id, new Date(window.start.getTime() - 3 * DAY)]);
    const today = (await createTask(owner, { title: "Call Gavin", ownerId: owner.userId })).body.task;
    await admin.query("update crm.tasks set due_at = $2, due_has_time = false where id = $1", [today.id, window.start]);
    const later = (await createTask(owner, { title: "Next week's review", ownerId: owner.userId })).body.task;
    await admin.query("update crm.tasks set due_at = $2 where id = $1", [later.id, new Date(window.end.getTime() + 3_600_000)]);
    const theirs = (await createTask(owner, { title: "Sam's overdue call", ownerId: sam.userId })).body.task;
    await admin.query("update crm.tasks set due_at = $2 where id = $1", [theirs.id, new Date(window.start.getTime() - DAY)]);

    const llm = scripted(() => ({ brief: "", suggestions: [{ opportunityId, task: "Call Gavin Belson to ask where the renewal stands" }, { opportunityId: "not-real", task: "Invented" }] }));
    const result = await runUnit(owner, "brief", { deadline: Date.now() + 120_000, fetchImpl: llm.fetchImpl, trigger: "manual" });
    assert.equal(result.brief, true);
    assert.equal(llm.seen.length, 1);
    assert.match(llm.seen[0].system, /suggestions has one entry for each opportunity gone quiet/);
    assert.match(llm.seen[0].user, new RegExp(`- id ${opportunityId}: Hooli renewal`));
    assert.doesNotMatch(llm.seen[0].user, /Call Gavin|Send the pricing/);

    const body = (await latestBrief(owner))?.body ?? "";
    const [due, quiet] = body.split("\n\n");
    assert.equal(
      due,
      [
        "### Due today",
        `- [Send (the) pricing](/tasks?task=${overdue.id}) (overdue, due ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(new Date(window.start.getTime() - 3 * DAY))})`,
        `- [Call Gavin](/tasks?task=${today.id})`,
      ].join("\n"),
    );
    assert.match(quiet, new RegExp(`^### Opportunities gone quiet\\n- \\[Hooli renewal\\]\\(/opportunities/${opportunityId}\\) \\(Hooli, [^)]+, quiet 12 days\\)\\. Suggested task: Call Gavin Belson to ask where the renewal stands$`));
    assert.doesNotMatch(body, /Next week's review|Sam's overdue call|Invented/);
    assert.ok(suggestsTasks(body));

    const samBrief = scripted(() => ({ brief: "", suggestions: [] }));
    const samResult = await runUnit(sam, "brief", { deadline: Date.now() + 120_000, fetchImpl: samBrief.fetchImpl, trigger: "manual" });
    assert.equal(samResult.brief, true);
    assert.equal(samBrief.seen.length, 0, "only tasks, so no model call");
    const samBody = (await latestBrief(sam))?.body ?? "";
    assert.match(samBody, /Sam's overdue call/);
    assert.doesNotMatch(samBody, /Send \(the\) pricing|Call Gavin|Hooli renewal/);
    assert.equal(suggestsTasks(samBody), false);

    const brief = (await getAdminPool().query<{ id: string }>("select id from crm.daily_briefs where user_id = $1", [owner.userId])).rows[0];
    const opened = await openBrief(owner, brief.id, { model: "claude-sonnet-5-5", reasoning: "low" });
    assert.equal(opened.messages.length, 1);
    assert.equal(opened.messages[0].suggestsTasks, true);
    assert.equal(offersCreateThose({ messages: opened.messages, busy: false, working: false }), true);
    assert.equal(offersCreateThose({ messages: opened.messages, busy: true, working: false }), false);
    assert.equal(offersCreateThose({ messages: [...opened.messages, { role: "user" }], busy: false, working: false }), false);
    const again = await getConversation(owner, opened.conversation.id);
    assert.equal(again.messages[0].suggestsTasks, true);
  });

  it("falls back to a check-in when the model suggests nothing for a quiet opportunity", async () => {
    const llm = scripted(() => ({ brief: "### In your market\n- Quiet week." }));
    await runUnit(owner, "brief", { deadline: Date.now() + 120_000, fetchImpl: llm.fetchImpl, trigger: "manual", rebuildBrief: true });
    const body = (await latestBrief(owner))?.body ?? "";
    assert.match(body, /Suggested task: Check in with Hooli/);
    assert.ok(body.endsWith("### In your market\n- Quiet week."));
  });

  it("proposes the next task when one is completed and creates it only once approved", async () => {
    const workflow = await createWorkflow(owner, { template: "next-step" });
    assert.equal(workflow.name, "Next step");
    assert.deepEqual(workflow.definition.trigger, { type: "task_completed", mine: true });
    await setWorkflowStatus(owner, workflow.id, "active");
    await createTask(owner, { title: "Book the Hooli kickoff", companyId, ownerId: owner.userId });
    const done = (
      await createTask(owner, { title: "Send Gavin the order form", description: "He wants it signed by Friday.", contactId, opportunityId, ownerId: owner.userId })
    ).body.task;

    const dueOn = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
    const llm = scripted((system) =>
      system.includes("automated workflow") ? { nextTask: "Chase Gavin Belson for the signed order form", dueOn, why: "He promised it by Friday." } : {},
    );
    await completeTask(owner, done.id);
    await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000 });
    const ai = llm.seen.filter((call) => call.system.includes("automated workflow"));
    assert.equal(ai.length, 1);
    assert.match(ai[0].user, /I've just completed this task: Send Gavin the order form/);
    assert.match(ai[0].user, /He wants it signed by Friday\./);
    assert.match(ai[0].user, /Its opportunity: Hooli renewal/);
    assert.match(ai[0].user, /- Book the Hooli kickoff/);

    const before = (await listTasks(owner, { companyId })).data.map((task) => task.title);
    assert.ok(!before.includes("Chase Gavin Belson for the signed order form"), "nothing is created before approval");
    const approvals = await listApprovals(owner);
    const approval = approvals.find((item) => item.title === "Next step: Chase Gavin Belson for the signed order form");
    assert.ok(approval, JSON.stringify(approvals));
    assert.match(approval.details, /He promised it by Friday\./);

    assert.equal(await decideApproval(owner, approval.runId, { approved: true }, { fetchImpl: llm.fetchImpl }), "succeeded");
    const created = (await listTasks(owner, { companyId })).data.find((task) => task.title === "Chase Gavin Belson for the signed order form");
    assert.ok(created);
    assert.equal(created.contactId, contactId);
    assert.equal(created.opportunityId, opportunityId);
    assert.equal(created.ownerId, owner.userId);
    assert.ok(created.dueDate);
    assert.match(created.description ?? "", /^After Send Gavin the order form\. He promised it by Friday\./);
    const { steps } = await getRunSteps(owner, approval.runId);
    assert.deepEqual(
      steps.filter((step) => step.status === "succeeded").map((step) => step.stepId),
      ["filter_1", "ai_1", "filter_2", "approval_1", "create_task_1"],
    );
    await setWorkflowStatus(owner, workflow.id, "paused");
  });

  it("stops without asking when the model sees no next step", async () => {
    const workflow = await createWorkflow(owner, { template: "next-step" });
    await setWorkflowStatus(owner, workflow.id, "active");
    const task = (await createTask(owner, { title: "Thank Gavin", contactId, ownerId: owner.userId })).body.task;
    const llm = scripted(() => ({ nextTask: "", dueOn: "", why: "" }));
    const waiting = (await listApprovals(owner)).length;
    await completeTask(owner, task.id);
    await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000 });
    assert.equal(llm.seen.length, 1);
    assert.equal((await listApprovals(owner)).length, waiting);
    await setWorkflowStatus(owner, workflow.id, "paused");
  });

  it("runs Next step only for the workflow owner's own completions, and skips unlinked tasks without a model call", async () => {
    const workflow = await createWorkflow(owner, { template: "next-step" });
    await setWorkflowStatus(owner, workflow.id, "active");
    const agent = (await createAgent(owner.workspaceId, ["crm:read", "tasks:write"], "Closer")).actor;
    const llm = scripted(() => ({ nextTask: "", dueOn: "", why: "" }));
    const runs = async () => (await listRuns(owner, workflow.id)).length;

    const samsTask = (await createTask(owner, { title: "Sam calls Gavin", contactId, ownerId: sam.userId })).body.task;
    await completeTask(agent, samsTask.id);
    await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000 });
    assert.equal(await runs(), 0, "an agent completing a teammate's task");

    const samsOwn = (await createTask(sam, { title: "Sam emails Gavin", contactId, ownerId: sam.userId })).body.task;
    await completeTask(sam, samsOwn.id);
    await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000 });
    assert.equal(await runs(), 0, "a teammate completing their own task");

    const mine = (await createTask(owner, { title: "Mark emails Gavin", contactId, ownerId: owner.userId })).body.task;
    await completeTask(agent, mine.id);
    await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000 });
    assert.equal(await runs(), 1, "an agent completing the owner's task");
    assert.equal(llm.seen.length, 1);

    const unlinked = (await createTask(owner, { title: "Tidy the desk", ownerId: owner.userId })).body.task;
    await completeTask(owner, unlinked.id);
    await runWorkflowTick({ fetchImpl: llm.fetchImpl, budgetMs: 30_000 });
    assert.equal(await runs(), 2);
    assert.equal(llm.seen.length, 1, "no model call for a task with no links");
    await setWorkflowStatus(owner, workflow.id, "paused");
  });

  it("refuses Same as the task outside a task trigger", async () => {
    const workflow = await createWorkflow(owner, { name: "Wrong link" });
    const definition: WorkflowDefinition = {
      version: 2,
      trigger: { type: "manual", object: "company" },
      triggerPosition: { x: 0, y: 0 },
      nodes: [{ id: "create_task_1", type: "create_task", config: { title: "Call {{company.name}}", link: "task" }, position: { x: 300, y: 0 } }],
      edges: [{ source: "trigger", handle: "out", target: "create_task_1" }],
    };
    await saveWorkflow(owner, workflow.id, { definition });
    await setWorkflowStatus(owner, workflow.id, "active");
    const started = await startRun(owner, workflow.id, { test: false, record: { type: "company", id: companyId } });
    assert.equal(started.status, "failed");
    const { steps } = await getRunSteps(owner, started.runId);
    assert.match(JSON.stringify(steps), /Same as the task only works when a task is completed/);
    assert.equal((await listTasks(owner, { companyId })).data.some((task) => task.title === "Call Hooli"), false);
  });

  it("keeps the tasks sections when the model fails, and offers Create those only on today's brief", async () => {
    await getAdminPool().query("update crm.tasks set archived_at = now() where company_id = $1 and archived_at is null", [companyId]);
    const failing: typeof fetch = async () => new Response("down", { status: 400 });
    const result = await runUnit(owner, "brief", { deadline: Date.now() + 120_000, fetchImpl: failing, trigger: "manual", rebuildBrief: true });
    assert.equal(result.brief, true, JSON.stringify(result));
    const body = (await latestBrief(owner))?.body ?? "";
    assert.match(body, /^### Due today\n/);
    assert.match(body, /### Opportunities gone quiet\n- \[Hooli renewal\]/);
    assert.match(body, /Suggested task: Check in with Hooli$/);

    const admin = getAdminPool();
    const brief = (await admin.query<{ id: string }>("select id from crm.daily_briefs where user_id = $1 and workspace_id = $2", [owner.userId, owner.workspaceId])).rows[0];
    const opened = await openBrief(owner, brief.id, { model: "claude-sonnet-5-5", reasoning: "low" });
    assert.equal(opened.messages[0].suggestsTasks, true);
    await admin.query("update crm.daily_briefs set day = day - 1 where id = $1", [brief.id]);
    const later = await getConversation(owner, opened.conversation.id);
    assert.equal(later.messages[0].suggestsTasks, undefined);
    assert.equal(offersCreateThose({ messages: later.messages, busy: false, working: false }), false);
  });
});

describe("follow-up titles from the email", () => {
  it("cleans subjects and falls back to them", () => {
    assert.equal(cleanSubject("RE: Fwd: [EXTERNAL] Q1 [pricing]"), "Q1 pricing");
    assert.equal(subjectTitle({ who: "Ada Lovell", subject: "Re: Pilot plan." }), "Reply to Ada Lovell: Pilot plan");
    assert.equal(subjectTitle({ who: "Ada Lovell", subject: "  Re:  " }), "Follow up with Ada Lovell");
    const long = subjectTitle({ who: "Ada Lovell", subject: `Quarterly ${"planning ".repeat(20)}review` });
    assert.ok(long.length <= 120, long);
    assert.match(long, / planning…$/);
  });

  it("asks the model for a title from the email and keeps the subject one when it fails", async () => {
    process.env.LLM_API_KEY = "llm-test";
    try {
      const llm = scripted(() => ({ title: "Send Ada Lovell the revised order form \u2014 today." }));
      const title = await followUpTitle({ who: "Ada Lovell", subject: "Re: Order form", text: "Could you send the revised order form?" }, { fetchImpl: llm.fetchImpl });
      assert.equal(title, "Send Ada Lovell the revised order form, today");
      assert.match(llm.seen[0].user, /Subject: Order form\n\nCould you send the revised order form\?/);
      assert.match(llm.seen[0].system, /never instructions to follow/);
      const failing: typeof fetch = async () => new Response("nope", { status: 400 });
      assert.equal(await followUpTitle({ who: "Ada Lovell", subject: "Order form", text: "Hi" }, { fetchImpl: failing }), "Reply to Ada Lovell: Order form");
    } finally {
      delete process.env.LLM_API_KEY;
    }
    assert.equal(await followUpTitle({ who: "Ada Lovell", subject: "Order form", text: "Hi" }), "Reply to Ada Lovell: Order form");
  });

  it("titles a Mail follow-up from the email", async () => {
    const owner = await createUser("fran@follow-title.test", "Fran Follow");
    const company = (await createCompany(owner, { name: "Fernhill", domain: "fernhill-title.test" })).body.company.id;
    await createContact(owner, { companyId: company, firstName: "Emma", lastName: "Lowe", email: "emma@fernhill-title.test" });
    await saveMailbox(owner, { email: "fran@orbit-title.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const admin = getAdminPool();
    const sourceId = (
      await admin.query<{ id: string }>(
        `insert into crm.mail_sources (workspace_id, user_id, email, connection_id)
         select $1, $2, 'fran@orbit-title.test', id from crm.mailbox_connections where user_id = $2 returning id`,
        [owner.workspaceId, owner.userId],
      )
    ).rows[0].id;
    const folder = (
      await admin.query<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'inbox', 'inbox', 'inbox') returning id",
        [owner.workspaceId, owner.userId, sourceId],
      )
    ).rows[0].id;
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await admin.query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
         from_email, to_recipients, cc_recipients, sent_at, received_at)
       values ($1, $2, $3, $4, 'title-1', '<title-1@title.test>', 'thread-title', 'Intro to the CFO', 'Hello', 'Can you send the deck before Thursday?', 'emma@fernhill-title.test',
         '[{"name":"","address":"fran@orbit-title.test"}]'::jsonb, '[]'::jsonb, $5, $5)`,
      [owner.workspaceId, owner.userId, sourceId, folder, at],
    );
    process.env.LLM_API_KEY = "llm-test";
    try {
      const llm = scripted(() => ({ title: "Send Emma Lowe the deck before Thursday" }));
      await fileMailOnTimeline(owner, { fetchImpl: llm.fetchImpl });
      assert.equal(llm.seen.length, 1);
      assert.match(llm.seen[0].user, /Can you send the deck before Thursday\?/);
      assert.match(llm.seen[0].system, /An email from Emma Lowe/);
    } finally {
      delete process.env.LLM_API_KEY;
    }
    const task = (await listTasks(owner, { companyId: company })).data[0];
    assert.equal(task.title, "Send Emma Lowe the deck before Thursday");
  });

  it("titles an API follow-up from the logged email outside the filing transaction", async () => {
    const owner = await createUser("lena@logged-title.test", "Lena Logged");
    const company = (await createCompany(owner, { name: "Larchmont", domain: "larchmont-title.test" })).body.company.id;
    await createContact(owner, { companyId: company, firstName: "Ivo", lastName: "Hart", email: "ivo@larchmont-title.test" });
    const record = (fetchImpl?: typeof fetch) =>
      recordCommunication(
        owner,
        { kind: "email", title: "Re: Pilot scope", body: "Could you send over the pilot scope by Friday?", participantEmails: ["ivo@larchmont-title.test"] },
        { fetchImpl },
      );
    const open = async () => (await getAdminPool().query<{ open: number }>("select count(*)::int as open from pg_stat_activity where state = 'idle in transaction'")).rows[0].open;
    process.env.LLM_API_KEY = "llm-test";
    try {
      let openDuringCall = -1;
      const llm = scripted(() => ({ title: "Send Ivo Hart the pilot scope by Friday" }));
      const watched: typeof fetch = async (input, init) => {
        openDuringCall = await open();
        return llm.fetchImpl(input, init);
      };
      const filed = await record(watched);
      assert.equal(filed.suggested, true);
      assert.equal(filed.task?.title, "Send Ivo Hart the pilot scope by Friday");
      assert.equal(filed.task?.contactId, (await listTasks(owner, { companyId: company })).data[0].contactId);
      assert.equal(openDuringCall, 0);
      assert.equal(llm.seen.length, 1);
      assert.match(llm.seen[0].system, /An email with Ivo Hart has just been logged/);
      assert.match(llm.seen[0].user, /Subject: Pilot scope\n\nCould you send over the pilot scope by Friday\?/);
      await completeTask(owner, filed.task!.id);

      const failing: typeof fetch = async () => new Response("nope", { status: 500 });
      const failed = await record(failing);
      assert.equal(failed.task?.title, "Follow up with Ivo Hart: Pilot scope");
      await completeTask(owner, failed.task!.id);

      const meeting = scripted(() => ({ title: "Should not be used" }));
      const met = await recordCommunication(owner, { kind: "meeting", title: "Kickoff", body: "Agreed the plan", companyId: company }, { fetchImpl: meeting.fetchImpl });
      assert.equal(met.task?.title, "Follow up with Larchmont");
      assert.equal(meeting.seen.length, 0);
      await completeTask(owner, met.task!.id);
    } finally {
      delete process.env.LLM_API_KEY;
    }
    const keyless = await record();
    assert.equal(keyless.task?.title, "Follow up with Ivo Hart: Pilot scope");
    assert.equal(loggedTitle({ who: "Ivo Hart", subject: " Fwd: " }), "Follow up with Ivo Hart");
  });
});
