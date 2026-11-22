import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET as restActions } from "@/app/api/v1/actions/route";
import { POST as restComplete } from "@/app/api/v1/tasks/[id]/complete/route";
import { GET as restTask } from "@/app/api/v1/tasks/[id]/route";
import { GET as restTasks } from "@/app/api/v1/tasks/route";
import { offersCloseThose, offersCreateThose } from "@/lib/assistant/brief-dock";
import { getConversation, openBrief } from "@/lib/assistant/chat";
import { taskDetailLines } from "@/lib/assistant/page-context";
import { runTool } from "@/lib/assistant/tools";
import { createPersonalToken } from "@/lib/auth/personal";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { taskDetail } from "@/lib/crm/task-detail";
import { closeTaskFromOffer, withLooksDone } from "@/lib/crm/task-done";
import { activityWhen } from "@/lib/crm/task-done-text";
import { addTaskParticipantsInDb, createTask } from "@/lib/crm/tasks";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { CLOSE_THOSE, suggestsClosing } from "@/lib/learning/brief-format";
import { latestBrief, runUnit } from "@/lib/learning/nightly";
import { dayWindow } from "@/lib/time";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase, useServerlessPool } from "./helpers";

const admin = () => getAdminPool();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

type Looks = { activityId: string; kind: string; when: string; note: string | null } | null;

describe("looks done in the brief, assistant, API and MCP", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let agent: AgentActor;
  let agentToken = "";
  let personalToken = "";
  let janeId = "";
  let tomId = "";
  let companyId = "";
  const ids: Record<string, string> = {};
  const activities: Record<string, string> = {};
  const savedKey = process.env.LLM_API_KEY;

  async function offer(taskId: string, activityId: string, note: string | null = "Covered what it asks.") {
    await admin().query("select private.offer_task_done($1, $2, $3, null, null)", [taskId, activityId, note]);
  }

  async function activity(actor: UserActor, type: "call" | "email" | "meeting", contactId: string, ago: number, title: string) {
    const result = await createActivity(actor, { type, title, body: "We went through it.", occurredAt: hoursAgo(ago), contactId, companyId });
    return result.body.activity.id;
  }

  async function mine(actor: UserActor, title: string, extra: { ownerId?: string | null; contactId?: string } = {}) {
    const id = (await createTask(actor, { title, ownerId: actor.userId, contactId: janeId, ...extra })).body.task.id;
    await admin().query("update crm.tasks set created_at = now() - interval '48 hours' where id = $1", [id]);
    return id;
  }

  async function activityCount() {
    return Number((await admin().query<{ count: string }>("select count(*) from crm.activities where company_id = $1", [companyId])).rows[0].count);
  }

  async function stateOf(taskId: string) {
    return (await admin().query<{ state: string }>("select state from crm.task_done_offers where task_id = $1 order by created_at desc limit 1", [taskId])).rows[0]?.state;
  }

  async function completedAt(taskId: string) {
    return (await admin().query<{ completed_at: Date | null }>("select completed_at from crm.tasks where id = $1", [taskId])).rows[0].completed_at;
  }

  before(async () => {
    process.env.LLM_API_KEY = "llm-test";
    await resetDatabase();
    mark = await createUser("mark@lookdonebrief.test", "Mark Ridgeon");
    const member = async (email: string, name: string) => {
      const person = await createUser(email, name);
      await admin().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, person.userId]);
      return { ...person, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "member" as const, scopes: scopesForRole("member") };
    };
    sam = await member("sam@lookdonebrief.test", "Sam Colleague");
    priya = await member("priya@lookdonebrief.test", "Priya Tagged");
    const created = await createAgent(mark.workspaceId, [...SCOPES], "Workspace agent");
    agent = created.actor;
    agentToken = created.token;
    personalToken = (await createPersonalToken(mark, "Claude")).token;
    companyId = (await createCompany(mark, { name: "Northwind", domain: "northwind-lookdonebrief.test" })).body.company.id;
    janeId = (await createContact(mark, { companyId, firstName: "Jane", lastName: "Doe", email: "jane@northwind-lookdonebrief.test" })).body.contact.id;
    tomId = (await createContact(mark, { companyId, firstName: "Tom", lastName: "Reed", email: "tom@northwind-lookdonebrief.test" })).body.contact.id;

    activities.call = await activity(mark, "call", janeId, 2, "Pricing call");
    activities.email = await activity(mark, "email", tomId, 3, "Proposal");
    activities.meeting = await activity(mark, "meeting", janeId, 4, "Catch up");
    activities.other = await activity(mark, "call", janeId, 5, "Another call");

    ids.call = await mine(mark, "Call Jane about pricing and the pilot");
    ids.email = await mine(mark, "Send Tom the proposal [final]", { contactId: tomId });
    ids.dismissed = await mine(mark, "Dismissed task");
    ids.closed = await mine(mark, "Closed task");
    ids.none = await mine(mark, "No offer yet");
    ids.colleague = (await createTask(mark, { title: "Sam's call with Jane", ownerId: sam.userId, contactId: janeId })).body.task.id;
    ids.tagged = (await createTask(sam, { title: "Sam's task tagging Mark", ownerId: sam.userId, contactId: janeId })).body.task.id;
    await withActor(sam, (db) => addTaskParticipantsInDb(db, sam, ids.tagged, [mark.userId]));
    ids.agent = (await createTask(agent, { title: "Agent's call with Jane", contactId: janeId })).body.task.id;
    ids.due = (await createTask(mark, { title: "Due today thing", ownerId: mark.userId, dueAt: dayWindow().start.toISOString(), dueHasTime: false })).body.task.id;

    await admin().query("update crm.tasks set created_at = now() - interval '48 hours' where id = any($1::uuid[])", [[ids.colleague, ids.tagged, ids.agent, ids.due]]);
    await offer(ids.call, activities.call, "Covered pricing and the pilot.");
    await offer(ids.email, activities.email, "Sent the proposal.");
    await offer(ids.dismissed, activities.other);
    await admin().query("update crm.task_done_offers set state = 'dismissed' where task_id = $1", [ids.dismissed]);
    await offer(ids.closed, activities.other);
    await admin().query("update crm.task_done_offers set state = 'closed' where task_id = $1", [ids.closed]);
    await offer(ids.colleague, activities.meeting);
    await offer(ids.tagged, activities.meeting);
    await offer(ids.agent, activities.meeting, "Agent note.");
  });

  after(async () => {
    if (savedKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = savedKey;
    await getPool().end();
    await getAdminPool().end();
  });

  useServerlessPool();

  describe("the brief", () => {
    const refusing: typeof fetch = async () => {
      throw new Error("The brief sent something to the model.");
    };

    it("lists the person's own open tasks that have an open offer, after Due today, linked, without asking the model", async () => {
      const result = await runUnit(mark, "brief", { deadline: Date.now() + 120_000, fetchImpl: refusing, trigger: "manual" });
      assert.equal(result.brief, true, JSON.stringify(result));
      const body = (await latestBrief(mark))?.body ?? "";
      const sections = body.split("\n\n");
      assert.equal(sections.length, 2, body);
      assert.match(sections[0], /^### Due today\n/);
      assert.equal(
        sections[1],
        [
          "### Looks done",
          `- [Call Jane about pricing and the pilot](/tasks?task=${ids.call}) · Call with Jane Doe, ${activityWhen(hoursAgo(2))}`,
          `- [Send Tom the proposal (final)](/tasks?task=${ids.email}) · you emailed Tom Reed, ${activityWhen(hoursAgo(3))}`,
          `- [Agent's call with Jane](/tasks?task=${ids.agent}) · Meeting with Jane Doe, ${activityWhen(hoursAgo(4))}`,
        ].join("\n"),
      );
      assert.ok(suggestsClosing(body));
    });

    it("shows a colleague only their own, and never a task someone tagged them on", async () => {
      const result = await runUnit(sam, "brief", { deadline: Date.now() + 120_000, fetchImpl: refusing, trigger: "manual" });
      assert.equal(result.brief, true, JSON.stringify(result));
      const body = (await latestBrief(sam))?.body ?? "";
      assert.match(body, new RegExp(`\\[Sam's task tagging Mark\\]\\(/tasks\\?task=${ids.tagged}\\) · Meeting with Jane Doe, `));
      assert.match(body, new RegExp(`\\[Sam's call with Jane\\]\\(/tasks\\?task=${ids.colleague}\\)`));
      assert.doesNotMatch(body, /Call Jane about pricing|Send Tom|Agent's call/);
      const markBody = (await latestBrief(mark))?.body ?? "";
      assert.doesNotMatch(markBody, /Sam's call|Sam's task tagging|Dismissed task|Closed task|No offer yet/);
    });

    it("leaves a task out once its offer is dismissed", async () => {
      await admin().query("update crm.task_done_offers set state = 'dismissed' where task_id = $1", [ids.email]);
      await runUnit(mark, "brief", { deadline: Date.now() + 120_000, fetchImpl: refusing, trigger: "manual", rebuildBrief: true });
      const body = (await latestBrief(mark))?.body ?? "";
      assert.doesNotMatch(body, /Send Tom the proposal/);
      assert.match(body, /Call Jane about pricing/);
      await admin().query("update crm.task_done_offers set state = 'offered' where task_id = $1", [ids.email]);
      await runUnit(mark, "brief", { deadline: Date.now() + 120_000, fetchImpl: refusing, trigger: "manual", rebuildBrief: true });
    });
  });

  describe("Close those", () => {
    it("is suggested only by a Looks done section with a task in it", () => {
      assert.equal(suggestsClosing(`### Looks done\n- [Call Jane](/tasks?task=${ids.call}) · Call with Jane, Mon 23 Nov 10:15`), true);
      assert.equal(suggestsClosing("### Due today\n- [Call Jane](/tasks?task=x)"), false);
      assert.equal(suggestsClosing("### Looks done\n### Opportunities gone quiet\n- [Hooli](/opportunities/x). Suggested task: Check in"), false);
      assert.equal(suggestsClosing("### Looks done\nNothing"), false);
      assert.equal(CLOSE_THOSE, "Close those");
    });

    it("offers the button only while the brief is the only thing in the chat and idle", async () => {
      const brief = (await admin().query<{ id: string }>("select id from crm.daily_briefs where user_id = $1 and workspace_id = $2", [mark.userId, mark.workspaceId])).rows[0];
      const opened = await openBrief(mark, brief.id, { model: "claude-sonnet-5-5", reasoning: "low" });
      assert.equal(opened.messages[0].suggestsClosing, true);
      assert.equal(opened.messages[0].suggestsTasks, undefined);
      const messages = opened.messages;
      assert.equal(offersCloseThose({ messages, busy: false, working: false }), true);
      assert.equal(offersCloseThose({ messages, busy: true, working: false }), false);
      assert.equal(offersCloseThose({ messages, busy: false, working: true }), false);
      assert.equal(offersCloseThose({ messages: [...messages, { role: "user" }], busy: false, working: false }), false);
      assert.equal(offersCloseThose({ messages: [...messages, { role: "user", waiting: true }], busy: false, working: false }), true);
      assert.equal(offersCreateThose({ messages, busy: false, working: false }), false);
      assert.equal(offersCloseThose({ messages: [{ role: "assistant" }], busy: false, working: false }), false);
      assert.equal(offersCloseThose({ messages: [], busy: false, working: false }), false);
      assert.equal(offersCloseThose({ messages: [{ role: "assistant", suggestsClosing: true }, { role: "assistant", suggestsTasks: true }], busy: false, working: false }), true);
      assert.equal(offersCreateThose({ messages: [{ role: "assistant", suggestsClosing: true }, { role: "assistant", suggestsTasks: true }], busy: false, working: false }), true);
    });

    it("shows both buttons when the brief has both kinds of suggestion, and neither on an old brief", async () => {
      const brief = (await admin().query<{ id: string; body: string }>("select id, body from crm.daily_briefs where user_id = $1 and workspace_id = $2", [mark.userId, mark.workspaceId])).rows[0];
      await admin().query("update crm.daily_briefs set body = body || $2, conversation_id = null where id = $1", [brief.id, "\n\n### Opportunities gone quiet\n- [Hooli](/opportunities/x). Suggested task: Check in with Hooli"]);
      const opened = await openBrief(mark, brief.id, { model: "claude-sonnet-5-5", reasoning: "low" });
      assert.equal(opened.messages[0].suggestsClosing, true);
      assert.equal(opened.messages[0].suggestsTasks, true);
      const state = { messages: opened.messages, busy: false, working: false };
      assert.equal(offersCloseThose(state), true);
      assert.equal(offersCreateThose(state), true);
      await admin().query("update crm.daily_briefs set day = day - 1 where id = $1", [brief.id]);
      const later = await getConversation(mark, opened.conversation.id);
      assert.equal(later.messages[0].suggestsClosing, undefined);
      assert.equal(later.messages[0].suggestsTasks, undefined);
      assert.equal(offersCloseThose({ messages: later.messages, busy: false, working: false }), false);
      await admin().query("update crm.daily_briefs set day = day + 1 where id = $1", [brief.id]);
    });
  });

  describe("reads", () => {
    it("gives looksDone in list_tasks, the task detail and the page context, and null with no open offer", async () => {
      const listed = (await runTool(mark, "list_tasks", { mine: true })) as { data: { id: string; looksDone: Looks }[] };
      const byId = new Map(listed.data.map((task) => [task.id, task.looksDone]));
      assert.equal(byId.get(ids.call)?.activityId, activities.call);
      assert.equal(byId.get(ids.call)?.note, "Covered pricing and the pilot.");
      assert.ok(Math.abs(new Date(byId.get(ids.call)?.when ?? 0).getTime() - Date.parse(hoursAgo(2))) < 60_000);
      assert.equal(byId.get(ids.call)?.kind, "call");
      assert.equal(byId.get(ids.email)?.kind, "email");
      assert.equal(byId.get(ids.none), null);
      assert.equal(byId.get(ids.dismissed), null);
      assert.equal(byId.get(ids.closed), null);

      const one = (await runTool(mark, "list_tasks", { taskId: ids.call })) as { looksDone: Looks };
      assert.equal(one.looksDone?.activityId, activities.call);
      const detail = await taskDetail(mark, ids.call);
      assert.equal(detail.looksDone?.note, "Covered pricing and the pilot.");
      const lines = taskDetailLines(detail, "Task they have open").join("\n");
      assert.match(lines, new RegExp(`Looks done: Orbit thinks a call .* \\[activity id ${activities.call}\\], note "Covered pricing and the pilot\\."`));
      assert.match(lines, /propose update_task with completed true and activityId/);
      assert.doesNotMatch(taskDetailLines(await taskDetail(mark, ids.none), "Task they have open").join("\n"), /Looks done/);
    });

    it("gives a teammate who can't see the task nothing", async () => {
      await assert.rejects(taskDetail(sam, ids.call));
      const theirs = (await runTool(sam, "list_tasks", { view: "all" })) as { data: { id: string }[] };
      assert.equal(theirs.data.some((task) => task.id === ids.call), false);
      assert.deepEqual(await withLooksDone(sam, [{ id: ids.call }]), [{ id: ids.call, looksDone: null }]);
      assert.deepEqual(await withLooksDone(priya, [{ id: ids.call }, { id: ids.tagged }]), [
        { id: ids.call, looksDone: null },
        { id: ids.tagged, looksDone: null },
      ]);
      assert.equal((await withLooksDone(mark, [{ id: ids.tagged }]))[0].looksDone?.activityId, activities.meeting);
    });

    it("gives looksDone over the API for the tokens that can see the task", async () => {
      const get = (url: string, handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>, id = "x") =>
        handler(new Request(`http://crm.test/api/v1${url}`, { headers: { authorization: `Bearer ${agentToken}` } }), { params: Promise.resolve({ id }) });
      const single = (await (await get(`/tasks/${ids.agent}`, restTask, ids.agent)).json()) as { task: { looksDone: Looks }; detail: { looksDone: Looks } };
      assert.equal(single.task.looksDone?.activityId, activities.meeting);
      assert.equal(single.task.looksDone?.kind, "meeting");
      assert.equal(single.task.looksDone?.note, "Agent note.");
      assert.equal(single.detail.looksDone?.activityId, activities.meeting);
      const list = (await (await get("/tasks?view=all", restTasks as never)).json()) as { data: { id: string; looksDone: Looks }[] };
      assert.deepEqual(list.data.map((task) => task.id), [ids.agent]);
      assert.equal(list.data[0].looksDone?.activityId, activities.meeting);
      const actions = (await (await get("/actions?view=all", restActions as never)).json()) as { tasks: { id: string; looksDone: Looks }[] };
      assert.equal(actions.tasks[0].looksDone?.kind, "meeting");
    });

    it("gives looksDone over MCP", async () => {
      const due = JSON.parse((await mcp(mark, "get_due_actions", { view: "all" })).text) as { tasks: { id: string; looksDone: Looks }[] };
      assert.equal(due.tasks.find((task) => task.id === ids.call)?.looksDone?.activityId, activities.call);
      assert.equal(due.tasks.find((task) => task.id === ids.none)?.looksDone, null);
      const next = JSON.parse((await mcp(mark, "get_next_action", { id: ids.call })).text) as { looksDone: Looks };
      assert.equal(next.looksDone?.kind, "call");
      const agentNext = JSON.parse((await mcp(agent, "get_next_action", { id: ids.agent })).text) as { looksDone: Looks };
      assert.equal(agentNext.looksDone?.note, "Agent note.");
    });
  });

  async function mcp(actor: UserActor | AgentActor, name: string, args: Record<string, unknown>) {
    const server = createCrmMcpServer(actor, actor.type === "user" ? { personal: { tokenId: crypto.randomUUID(), canSend: false } } : {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "looks-done", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { error: Boolean(result.isError), text: result.content[0]?.text ?? "" };
    } finally {
      await client.close();
      await server.close();
    }
  }

  describe("closing with activityId", () => {
    it("closes through the assistant with no new activity, keeps the note and is idempotent by tool call", async () => {
      const before = await activityCount();
      const args = { taskId: ids.call, completed: true, activityId: activities.call };
      const first = (await runTool(mark, "update_task", args, { callId: "call-close-1" })) as { task?: { completedAt: string | null }; error?: string };
      assert.equal(first.error, undefined);
      assert.ok(first.task?.completedAt);
      assert.equal(await stateOf(ids.call), "closed");
      assert.equal(await activityCount(), before);
      const outcome = (await admin().query<{ activity_id: string; note: string | null }>("select activity_id, note from crm.task_outcomes where task_id = $1", [ids.call])).rows;
      assert.deepEqual(outcome, [{ activity_id: activities.call, note: "Covered pricing and the pilot." }]);
      const again = (await runTool(mark, "update_task", args, { callId: "call-close-1" })) as { task?: { completedAt: string | null }; error?: string };
      assert.equal(again.error, undefined);
      assert.equal(again.task?.completedAt, first.task?.completedAt);
      assert.equal((await admin().query("select 1 from crm.task_outcomes where task_id = $1", [ids.call])).rowCount, 1);
      assert.equal(await activityCount(), before);
    });

    it("refuses anything but taskId, completed true and activityId, and an activity with no open offer", async () => {
      const extra = (await runTool(mark, "update_task", { taskId: ids.email, completed: true, activityId: activities.email, title: "New title" })) as { error?: string };
      assert.match(extra.error ?? "", /send only taskId, completed true and activityId/);
      const open = (await runTool(mark, "update_task", { taskId: ids.email, activityId: activities.email })) as { error?: string };
      assert.match(open.error ?? "", /send only taskId, completed true and activityId/);
      const wrong = (await runTool(mark, "update_task", { taskId: ids.email, completed: true, activityId: activities.call })) as { error?: string };
      assert.ok(wrong.error);
      const dismissed = (await runTool(mark, "update_task", { taskId: ids.dismissed, completed: true, activityId: activities.other })) as { error?: string };
      assert.ok(dismissed.error);
      assert.equal(await completedAt(ids.email), null);
      assert.equal(await completedAt(ids.dismissed), null);
      assert.equal(await stateOf(ids.email), "offered");
    });

    it("refuses a task the person can only read", async () => {
      const result = (await runTool(mark, "update_task", { taskId: ids.tagged, completed: true, activityId: activities.meeting })) as { error?: string };
      assert.ok(result.error);
      assert.equal(await completedAt(ids.tagged), null);
      assert.equal(await stateOf(ids.tagged), "offered");
    });

    it("refuses a workspace agent token everywhere and changes nothing", async () => {
      await assert.rejects(closeTaskFromOffer(agent, ids.agent, { activityId: activities.meeting }), /Only a person/);
      const rest = await restComplete(
        new Request("http://crm.test/api/v1/tasks/x/complete", { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ activityId: activities.meeting }) }),
        { params: Promise.resolve({ id: ids.agent }) },
      );
      assert.equal(rest.status, 403);
      const viaMcp = await mcp(agent, "complete_next_action", { id: ids.agent, activity_id: activities.meeting });
      assert.equal(viaMcp.error, true);
      assert.match(viaMcp.text, /forbidden/);
      assert.equal(await completedAt(ids.agent), null);
      assert.equal(await stateOf(ids.agent), "offered");
    });

    it("closes over REST with a personal token, idempotent by Idempotency-Key", async () => {
      const task = await mine(mark, "Send Tom the pilot terms", { contactId: tomId });
      await offer(task, activities.meeting, "Sent them.");
      const before = await activityCount();
      const call = () =>
        restComplete(
          new Request("http://crm.test/api/v1/tasks/x/complete", {
            method: "POST",
            headers: { authorization: `Bearer ${personalToken}`, "content-type": "application/json", "idempotency-key": "close-rest-1" },
            body: JSON.stringify({ activityId: activities.meeting }),
          }),
          { params: Promise.resolve({ id: task }) },
        );
      const first = await call();
      assert.equal(first.status, 200);
      const body = (await first.json()) as { task: { completedAt: string }; activityId: string };
      assert.ok(body.task.completedAt);
      assert.equal(body.activityId, activities.meeting);
      const second = await call();
      assert.equal(second.status, 200);
      assert.equal(((await second.json()) as { task: { completedAt: string } }).task.completedAt, body.task.completedAt);
      assert.equal(await stateOf(task), "closed");
      assert.equal(await activityCount(), before);
      assert.equal((await admin().query("select 1 from crm.task_outcomes where task_id = $1", [task])).rowCount, 1);
    });

    it("refuses a bad activityId over REST and still completes plainly without one", async () => {
      const bad = await restComplete(
        new Request("http://crm.test/api/v1/tasks/x/complete", { method: "POST", headers: { authorization: `Bearer ${personalToken}`, "content-type": "application/json" }, body: JSON.stringify({ activityId: "nope" }) }),
        { params: Promise.resolve({ id: ids.email }) },
      );
      assert.equal(bad.status, 400);
      const plain = await restComplete(
        new Request("http://crm.test/api/v1/tasks/x/complete", { method: "POST", headers: { authorization: `Bearer ${agentToken}` } }),
        { params: Promise.resolve({ id: ids.agent }) },
      );
      assert.equal(plain.status, 200);
      assert.equal(await stateOf(ids.agent), "offered");
    });

    it("closes over MCP with a personal token, idempotent by idempotency_key", async () => {
      const before = await activityCount();
      const args = { id: ids.email, activity_id: activities.email, idempotency_key: "close-mcp-1" };
      const first = await mcp(mark, "complete_next_action", args);
      assert.equal(first.error, false, first.text);
      const done = JSON.parse(first.text) as { task: { completedAt: string }; activityId: string };
      assert.ok(done.task.completedAt);
      const second = await mcp(mark, "complete_next_action", args);
      assert.equal(second.error, false, second.text);
      assert.equal((JSON.parse(second.text) as { task: { completedAt: string } }).task.completedAt, done.task.completedAt);
      assert.equal(await stateOf(ids.email), "closed");
      assert.equal(await activityCount(), before);
      assert.equal((await admin().query("select 1 from crm.task_outcomes where task_id = $1", [ids.email])).rowCount, 1);
    });

    it("refuses a closed offer replayed under a new key", async () => {
      const result = await mcp(mark, "complete_next_action", { id: ids.email, activity_id: activities.email, idempotency_key: "close-mcp-2" });
      assert.equal(result.error, true);
      assert.match(result.text, /conflict/);
    });
  });
});
