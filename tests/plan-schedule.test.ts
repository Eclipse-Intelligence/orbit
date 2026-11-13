import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { saveMailbox } from "@/lib/crm/inbox";
import { buildPlan, orderWithAi, scheduleTasks } from "@/lib/crm/plan-schedule";
import { scopesForRole } from "@/lib/crm/scopes";
import { dayStartIso, wallInstant } from "@/lib/crm/task-time";
import { createTask, getTask } from "@/lib/crm/tasks";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { addWorkingDays, dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import { getWorkingHours, saveWorkingHours } from "@/lib/crm/working-hours";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { DEFAULT_WORKING_HOURS } from "@/lib/working-hours";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;


after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

const today = dayKeyAt(new Date());
const workday = (after: number) => addWorkingDays(today, after);
const at = (day: string, hour: number, minute = 0) => new Date(wallInstant(day, hour, minute)).toISOString();
const local = (day: string, hour: number, minute = 0) => `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

async function failure(work: () => Promise<unknown>) {
  try {
    await work();
    return "";
  } catch (error) {
    const known = error as { code?: string; message?: string };
    return `${known.code}: ${known.message}`;
  }
}

async function audits(id: string) {
  return (
    await getAdminPool().query<{ operation: string; source: string | null; workspace_id: string }>(
      "select operation, source, workspace_id from crm.audit_events where entity_id = $1 and event_type = 'task.updated' order by created_at",
      [id],
    )
  ).rows;
}

async function mcpTools(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "plan-check", version: "1.0.0" });
  await client.connect(clientSide);
  return { client, close: async () => (await client.close(), await server.close()) };
}

describe("Plan and schedule", () => {
  let mark: UserActor;
  let personal: UserActor;
  let sam: UserActor;
  let calendarId: string;
  let connectionId: string;

  before(async () => {
    await resetDatabase();
    mark = { ...(await createUser("mark@plan.test", "Mark Ridgeon")), workspaceName: "Eclipse" };
    const created = await createWorkspace(mark, { name: "Mark Ridgeon" });
    personal = { ...mark, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    sam = { ...(await createUser("sam@plan.test", "Sam Okafor")), workspaceName: "Sam's" };
    await saveMailbox(mark, { email: "mark@plan.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const admin = getAdminPool();
    connectionId = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [mark.userId])).rows[0].id;
    calendarId = (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm)
         values ($1, $2, $3, 'cal-plan', 'Calendar', '#4f9be8', true, true, true) returning id`,
        [mark.workspaceId, mark.userId, connectionId],
      )
    ).rows[0].id;
  });

  const meeting = (subject: string, start: string, end: string, showAs = "busy") =>
    getAdminPool().query(
      `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, show_as)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [mark.workspaceId, calendarId, connectionId, mark.userId, `${subject}-${start}`, subject, start, end, showAs],
    );

  it("keeps working hours personal, with RLS forced, and defaults to 09:00 to 17:30 on weekdays", async () => {
    assert.deepEqual(await getWorkingHours(mark), DEFAULT_WORKING_HOURS);
    const fridays = DEFAULT_WORKING_HOURS.map((day, index) => (index === 5 ? { works: true, start: 540, end: 960 } : day));
    assert.deepEqual(await saveWorkingHours(mark, fridays), fridays);
    assert.deepEqual(await getWorkingHours(personal), fridays, "the same in every workspace");
    assert.deepEqual(await getWorkingHours(sam), DEFAULT_WORKING_HOURS);
    assert.deepEqual(await queryAsUser(sam.userId, "select weekday from crm.working_hours where user_id = $1", [mark.userId]), []);
    await assert.rejects(queryAsUser(sam.userId, "insert into crm.working_hours (user_id, weekday, works, starts_minute, ends_minute) values ($1, 1, true, 0, 60)", [mark.userId]));
    assert.match(await failure(() => saveWorkingHours(mark, fridays.map((day) => ({ ...day, end: day.start })))), /^invalid_input/);
    const forced = await getAdminPool().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'crm.working_hours'::regclass",
    );
    assert.deepEqual(forced.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    await saveWorkingHours(mark, DEFAULT_WORKING_HOURS);
  });

  it("builds a proposal from every workspace's tasks around Busy meetings without changing anything", async () => {
    const day = workday(3);
    await meeting("Halden weekly", at(day, 10), at(day, 11));
    await meeting("Lunch", at(day, 12), at(day, 13), "free");
    const here = (await createTask(mark, { title: "Call Jane Cooper", dueDate: day })).body.task;
    const there = (await createTask(personal, { title: "Call the accountant", dueDate: day })).body.task;
    const plan = await buildPlan(mark, { ai: false });
    const placed = new Map(plan.placed.map((entry) => [entry.taskId, entry]));
    assert.equal(placed.get(here.id)?.at, at(day, 11, 5));
    assert.equal(placed.get(there.id)?.at, at(day, 11, 20));
    assert.equal(placed.get(there.id)?.workspaceId, personal.workspaceId);
    assert.equal((await getTask(mark, here.id)).dueHasTime, false, "a proposal writes nothing");
  });

  it("asks the model once to order the tasks, and falls back when it fails", async () => {
    const tasks = [
      { id: "a", workspaceId: "w", title: "Email Raj", dueAt: null, dueHasTime: false, durationMinutes: 15, scheduledBy: null, priority: "normal" as const, completedAt: null, archivedAt: null, ownerId: "me", createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", workspaceId: "w", title: "Draft terms", dueAt: null, dueHasTime: false, durationMinutes: 15, scheduledBy: null, priority: "normal" as const, completedAt: null, archivedAt: null, ownerId: "me", createdAt: "2026-01-01T00:00:00Z" },
    ];
    assert.equal(await orderWithAi(tasks), null, "no key, no call");
    process.env.LLM_API_KEY = "test-key";
    try {
      const calls: string[] = [];
      const fake: typeof fetch = async (_url, init) => {
        calls.push(String(init?.body));
        return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ tasks: [{ id: "b", group: "other", minutes: 45 }, { id: "a", group: "email", minutes: null }] }) }, finish_reason: "stop" }] });
      };
      assert.deepEqual(await orderWithAi(tasks, { fetchImpl: fake }), [
        { id: "b", group: "other", minutes: 45 },
        { id: "a", group: "email", minutes: null },
      ]);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /Draft terms/);
      const broken: typeof fetch = async () => new Response("down", { status: 500 });
      assert.equal(await orderWithAi(tasks, { fetchImpl: broken, deadlineMs: 3_000 }), null);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("applies every block in one go, as placed by Plan, with an audit event each in its own workspace", async () => {
    const day = workday(4);
    const first = (await createTask(mark, { title: "Email Halden", dueDate: day })).body.task;
    const second = (await createTask(personal, { title: "Email the accountant", dueDate: day })).body.task;
    const scheduled = await scheduleTasks(
      mark,
      [
        { taskId: first.id, at: at(day, 13), durationMinutes: 15 },
        { taskId: second.id, at: at(day, 13, 15), durationMinutes: 30 },
      ],
      { mode: "plan", provenance: { operation: "plan_tasks", source: "web" } },
    );
    assert.deepEqual(scheduled.map((item) => [item.task.scheduledBy, item.task.dueHasTime, item.actor.workspaceId]), [
      ["planner", true, mark.workspaceId],
      ["planner", true, personal.workspaceId],
    ]);
    assert.equal(scheduled[1].task.durationMinutes, 30);
    assert.deepEqual((await audits(first.id)).map((row) => [row.operation, row.workspace_id]), [["plan_tasks", mark.workspaceId]]);
    assert.deepEqual((await audits(second.id)).map((row) => [row.operation, row.workspace_id]), [["plan_tasks", personal.workspaceId]]);
  });

  it("applies nothing when any block breaks a rule", async () => {
    const day = workday(5);
    const fine = (await createTask(mark, { title: "Call Emma Lowe", dueDate: day })).body.task;
    const placedByHand = (await createTask(mark, { title: "Call Oliver Grant", dueAt: at(day, 15) })).body.task;
    assert.equal(placedByHand.scheduledBy, "person");
    const outcome = await failure(() =>
      scheduleTasks(
        mark,
        [
          { taskId: fine.id, at: at(day, 10, 30) },
          { taskId: placedByHand.id, at: at(day, 11) },
        ],
        { mode: "plan", provenance: { operation: "plan_tasks", source: "web" } },
      ),
    );
    assert.match(outcome, /You placed “Call Oliver Grant” yourself/);
    const after = await getTask(mark, fine.id);
    assert.equal(after.dueHasTime, false, "the first block was rolled back");
    assert.equal(after.dueAt, dayStartIso(day));
    assert.deepEqual(await audits(fine.id), []);
  });

  it("moves an overdue block the person placed when Move names the new day, from the preview and from an agent", async () => {
    const yesterday = shiftDay(today, -1);
    const day = workday(11);
    const bob = (await createTask(mark, { title: "Call Bob", dueAt: local(yesterday, 10) })).body.task;
    assert.equal(bob.scheduledBy, "person");
    const [moved] = await scheduleTasks(mark, [{ taskId: bob.id, at: at(day, 15), moveDay: day }], { mode: "plan", provenance: { operation: "plan_tasks", source: "web" } });
    assert.equal(moved.task.dueAt, at(day, 15));
    assert.equal(moved.task.scheduledBy, "planner");
    const sue = (await createTask(mark, { title: "Call Sue", dueAt: local(yesterday, 11) })).body.task;
    const agentRun = (blocks: unknown) => scheduleTasks(mark, blocks, { mode: "agent", provenance: { operation: "schedule_tasks" } });
    assert.match(await failure(() => agentRun([{ taskId: sue.id, at: local(day, 15, 30) }])), /You placed “Call Sue” yourself/);
    const [agentMoved] = await agentRun([{ taskId: sue.id, at: `${local(day, 15, 30)}:00`, moveDay: day }]);
    assert.equal(agentMoved.task.dueAt, at(day, 15, 30), "seconds in London time are read as London time");
  });

  it("writes a proposal dragged in the preview as placed by the person, and the rest as placed by Plan", async () => {
    const day = workday(12);
    const dragged = (await createTask(mark, { title: "Email Kim", dueDate: day })).body.task;
    const left = (await createTask(mark, { title: "Email Lou", dueDate: day })).body.task;
    const done = await scheduleTasks(
      mark,
      [
        { taskId: dragged.id, at: at(day, 13), byHand: true },
        { taskId: left.id, at: at(day, 13, 15) },
      ],
      { mode: "plan", provenance: { operation: "plan_tasks", source: "web" } },
    );
    assert.deepEqual(done.map((item) => item.task.scheduledBy), ["person", "planner"]);
    const agentTask = (await createTask(mark, { title: "Email Max", dueDate: day })).body.task;
    const [agentDone] = await scheduleTasks(mark, [{ taskId: agentTask.id, at: local(day, 13, 30), byHand: true }], { mode: "agent", provenance: { operation: "schedule_tasks" } });
    assert.equal(agentDone.task.scheduledBy, "planner", "an agent can't claim a block was placed by hand");
  });

  it("checks an agent's slot against meetings however far ahead it is", async () => {
    const far = addWorkingDays(today, 60);
    await meeting("Quarterly review", at(far, 10), at(far, 12));
    const task = (await createTask(mark, { title: "Write the review", dueDate: far })).body.task;
    assert.match(
      await failure(() => scheduleTasks(mark, [{ taskId: task.id, at: local(far, 11) }], { mode: "agent", provenance: { operation: "schedule_tasks" } })),
      /clashes with Quarterly review/,
    );
  });

  it("fails closed for a task in a workspace the person isn't in", async () => {
    const samTask = (await createTask(sam, { title: "Sam's call", dueDate: workday(2) })).body.task;
    const mine = (await createTask(mark, { title: "Mine", dueDate: workday(2) })).body.task;
    assert.match(
      await failure(() =>
        scheduleTasks(mark, [{ taskId: mine.id, at: at(workday(2), 9) }, { taskId: samTask.id, at: at(workday(2), 10) }], { mode: "plan", provenance: { operation: "plan_tasks" } }),
      ),
      /^not_found/,
    );
    assert.equal((await getTask(mark, mine.id)).dueHasTime, false);
    assert.equal((await getTask(sam, samTask.id)).dueHasTime, false);
  });

  it("holds an agent's schedule to working hours, Busy meetings, the task's day and named moves", async () => {
    const day = workday(6);
    await meeting("Board call", at(day, 14), at(day, 15));
    const dated = (await createTask(mark, { title: "Call Ben Archer", dueDate: day })).body.task;
    const agentRun = (blocks: unknown) => scheduleTasks(mark, blocks, { mode: "agent", provenance: { operation: "schedule_tasks" } });
    assert.match(await failure(() => agentRun([{ taskId: dated.id, at: local(day, 18) }])), /outside your working hours/);
    assert.match(await failure(() => agentRun([{ taskId: dated.id, at: local(day, 14, 30) }])), /clashes with Board call/);
    assert.match(await failure(() => agentRun([{ taskId: dated.id, at: local(workday(7), 10), moveDay: workday(7) }])), /stays on that day/);
    const overdue = (await createTask(mark, { title: "Ring Ashby Freight", dueDate: shiftDay(today, -3) })).body.task;
    assert.match(await failure(() => agentRun([{ taskId: overdue.id, at: local(day, 10) }])), /Name the new day/);
    const done = await agentRun([
      { taskId: dated.id, at: local(day, 10, 30), durationMinutes: 30 },
      { taskId: overdue.id, at: local(day, 11), moveDay: day },
    ]);
    assert.deepEqual(done.map((item) => [item.task.dueAt, item.task.scheduledBy]), [
      [at(day, 10, 30), "planner"],
      [at(day, 11), "planner"],
    ]);
    assert.deepEqual((await audits(overdue.id)).map((row) => row.operation), ["schedule_tasks"]);
  });

  it("gives update_task a schedule list with an approval card naming every block, and checks exactly one of taskId or schedule", async () => {
    const day = workday(8);
    const call = (await createTask(mark, { title: "Call Daniel Shaw", dueDate: day })).body.task;
    const elsewhere = (await createTask(personal, { title: "Email Priya", dueDate: day })).body.task;
    const schedule = [
      { taskId: call.id, at: local(day, 10, 30), durationMinutes: 15 },
      { taskId: elsewhere.id, at: local(day, 13) },
    ];
    const card = describeAction("update_task", { schedule }, await recordNames(mark, [{ schedule }], ["update_task"]));
    assert.equal(card.title, "Put 2 tasks on your calendar");
    assert.match(card.lines[0], /10:30 to 10:45: Call Daniel Shaw$/);
    assert.match(card.lines[1], /13:00: Email Priya$/);
    assert.deepEqual(await runTool(mark, "update_task", {}), { error: "Send either taskId or schedule, not both.", field: "schedule" });
    assert.deepEqual(await runTool(mark, "update_task", { taskId: call.id, schedule }), { error: "Send either taskId or schedule, not both.", field: "schedule" });
    const bad = await runTool(mark, "update_task", { schedule: [{ taskId: call.id, at: local(day, 19) }] });
    assert.match((bad as { error: string }).error, /outside your working hours/);
    const result = (await runTool(mark, "update_task", { schedule })) as { scheduled: { id: string; scheduledBy: string; workspaceId: string }[] };
    assert.deepEqual(result.scheduled.map((task) => [task.id, task.scheduledBy, task.workspaceId]), [
      [call.id, "planner", mark.workspaceId],
      [elsewhere.id, "planner", personal.workspaceId],
    ]);
    const overdue = (await createTask(mark, { title: "Send Tom the order form", dueDate: shiftDay(today, -2) })).body.task;
    const move = [{ taskId: overdue.id, at: local(day, 15), moveDay: day }];
    const moveCard = describeAction("update_task", { schedule: move }, await recordNames(mark, [{ schedule: move }], ["update_task"]));
    assert.match(moveCard.lines[0], /Send Tom the order form \(moves from \w{3} \d+ \w{3}\)$/);
  });

  it("gives plan_tasks and schedule_tasks only to personal tokens, and holds schedule_tasks to Plan's rules", async () => {
    const agent: AgentActor = { type: "agent", agentId: "00000000-0000-4000-8000-000000000003", agentName: "Bot", credentialId: "00000000-0000-4000-8000-000000000004", workspaceId: mark.workspaceId, scopes: ["crm:read", "tasks:write"] };
    const forAgent = await mcpTools(agent);
    const agentNames = (await forAgent.client.listTools()).tools.map((tool) => tool.name);
    await forAgent.close();
    assert.ok(!agentNames.includes("plan_tasks") && !agentNames.includes("schedule_tasks"));
    const forMark = await mcpTools(mark);
    try {
      const names = (await forMark.client.listTools()).tools.map((tool) => tool.name);
      assert.ok(names.includes("plan_tasks") && names.includes("schedule_tasks"));
      const day = workday(9);
      const task = (await createTask(mark, { title: "Email Lucy Hart", dueDate: day })).body.task;
      const read = await forMark.client.callTool({ name: "plan_tasks", arguments: {} });
      const plan = JSON.parse((read.content as { text: string }[])[0].text).plan as { placed: { taskId: string; at: string }[] };
      const proposed = plan.placed.find((entry) => entry.taskId === task.id);
      assert.ok(proposed, "the proposal includes the task");
      assert.equal((await getTask(mark, task.id)).dueHasTime, false);
      const refused = await forMark.client.callTool({ name: "schedule_tasks", arguments: { schedule: [{ taskId: task.id, at: local(workday(10), 13), moveDay: workday(10) }] } });
      assert.equal(refused.isError, true);
      assert.match((refused.content as { text: string }[])[0].text, /stays on that day/);
      const applied = await forMark.client.callTool({ name: "schedule_tasks", arguments: { schedule: [{ taskId: task.id, at: proposed.at }] } });
      assert.equal(applied.isError, undefined);
      const after = await getTask(mark, task.id);
      assert.equal(after.scheduledBy, "planner");
      assert.equal(after.dueAt, proposed.at);
    } finally {
      await forMark.close();
    }
  });
});
