import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { dateKey, shiftDateKey } from "@/lib/calendar-view";
import { createContact } from "@/lib/crm/contacts";
import { completeTasksFromBeacon } from "@/lib/crm/task-beacon";
import { readPlanner } from "@/lib/crm/task-blocks";
import { linkTask } from "@/lib/crm/task-links";
import { wallInstant } from "@/lib/crm/task-time";
import { addTaskParticipants, completeTask, createTask, getTask, updateTask } from "@/lib/crm/tasks";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Task, UserActor } from "@/lib/crm/types";
import { actorForTask, createWorkspace, TASK_LOOKUP_FAILED, taskActorOrError } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { groupTaskList, isBlockOverdue, taskBlocks, taskListGroupKind } from "@/lib/task-blocks";
import { createAgent, createUser, resetDatabase } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

const MINUTE = 60_000;

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000001",
    workspaceId: "ws-eclipse",
    title: "Call Jane Cooper",
    description: null,
    dueAt: null,
    dueDate: null,
    dueHasTime: false,
    durationMinutes: 15,
    scheduledBy: null,
    remindMinutes: null,
    completedAt: null,
    priority: "normal",
    ownerId: "mark",
    ownerName: "Mark Ridgeon",
    companyId: null,
    companyName: null,
    companyPhone: null,
    contactId: null,
    contactCompanyId: null,
    contactName: null,
    contactFirstName: null,
    contactLastName: null,
    contactJobTitle: null,
    contactPhone: null,
    contactEmail: null,
    opportunityId: null,
    opportunityName: null,
    createdByUserId: "mark",
    createdByAgentId: null,
    archivedAt: null,
    clickupTaskId: null,
    clickupListId: null,
    clickupUrl: null,
    clickupError: null,
    inOutlook: false,
    mailThreadKey: null,
    mailThread: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("task blocks", () => {
  const now = Date.parse("2026-11-12T11:20:00.000Z");
  const meetings = [
    { subject: "Halden weekly", startsAt: "2026-11-12T14:30:00.000Z", endsAt: "2026-11-12T15:15:00.000Z", isAllDay: false, showAs: "busy" },
    { subject: "Optional lunch", startsAt: "2026-11-12T13:00:00.000Z", endsAt: "2026-11-12T14:00:00.000Z", isAllDay: false, showAs: "free" },
    { subject: "Declined review", startsAt: "2026-11-12T16:00:00.000Z", endsAt: "2026-11-12T17:00:00.000Z", isAllDay: false, showAs: "busy", myResponse: "declined" },
    { subject: "Away", startsAt: "2026-11-12T00:00:00.000Z", endsAt: "2026-11-13T00:00:00.000Z", isAllDay: true, showAs: "oof" },
  ];

  it("shows only open or done-today timed tasks the viewer owns, with overdue and clash flags", () => {
    const tasks = [
      task({ id: "a", title: "Price Q1 for Northwind", dueAt: "2026-11-12T14:30:00.000Z", dueHasTime: true, durationMinutes: 30, companyName: "Northwind" }),
      task({ id: "b", title: "Ring Ashby Freight", dueAt: "2026-11-10T14:00:00.000Z", dueHasTime: true, durationMinutes: 30, contactName: "Chris Doyle" }),
      task({ id: "c", title: "Email Raj", dueAt: "2026-11-12T09:00:00.000Z", dueHasTime: true, completedAt: "2026-11-12T09:10:00.000Z" }),
      task({ id: "d", title: "Done yesterday", dueAt: "2026-11-11T09:00:00.000Z", dueHasTime: true, completedAt: "2026-11-11T09:10:00.000Z" }),
      task({ id: "e", title: "Date only", dueAt: "2026-11-12T00:00:00.000Z" }),
      task({ id: "f", title: "Sam's call", dueAt: "2026-11-12T15:00:00.000Z", dueHasTime: true, ownerId: "sam", createdByUserId: "mark" }),
      task({ id: "g", title: "Unassigned call", dueAt: "2026-11-12T15:00:00.000Z", dueHasTime: true, ownerId: null }),
      task({ id: "h", title: "Archived", dueAt: "2026-11-12T15:00:00.000Z", dueHasTime: true, archivedAt: "2026-11-11T00:00:00.000Z" }),
      task({ id: "i", title: "Over lunch", dueAt: "2026-11-12T13:15:00.000Z", dueHasTime: true }),
      task({ id: "j", title: "Over a declined review", dueAt: "2026-11-12T16:15:00.000Z", dueHasTime: true }),
      task({ id: "k", title: "Running now", dueAt: "2026-11-12T11:15:00.000Z", dueHasTime: true }),
    ];
    const blocks = taskBlocks(tasks, { viewerId: "mark", now, meetings });
    assert.deepEqual(
      blocks.map((block) => block.task.id),
      ["b", "c", "k", "i", "a", "j"],
    );
    const byId = new Map(blocks.map((block) => [block.task.id, block]));
    assert.equal(byId.get("a")?.clash, "Halden weekly");
    assert.equal(byId.get("a")?.endsAt, "2026-11-12T15:00:00.000Z");
    assert.equal(byId.get("a")?.person, "Northwind");
    assert.equal(byId.get("b")?.overdue, true);
    assert.equal(byId.get("b")?.person, "Chris Doyle");
    assert.equal(byId.get("c")?.done, true);
    assert.equal(byId.get("c")?.overdue, false);
    assert.equal(byId.get("i")?.clash, null);
    assert.equal(byId.get("j")?.clash, null);
    assert.equal(byId.get("k")?.overdue, false);
    assert.ok(blocks.every((block) => block.workspaceName === null));
  });

  it("marks a block done straight away from the held Done set and drops its clash", () => {
    const tasks = [task({ id: "a", dueAt: "2026-11-12T14:30:00.000Z", dueHasTime: true })];
    const [block] = taskBlocks(tasks, { viewerId: "mark", now, meetings, done: new Set(["a"]) });
    assert.equal(block.done, true);
    assert.equal(block.clash, null);
  });

  it("names the workspace only for people in more than one", () => {
    const tasks = [
      task({ id: "a", dueAt: "2026-11-12T10:00:00.000Z", dueHasTime: true, workspaceId: "ws-eclipse" }),
      task({ id: "b", dueAt: "2026-11-12T12:00:00.000Z", dueHasTime: true, workspaceId: "ws-mark" }),
    ];
    const one = taskBlocks(tasks.slice(0, 1), { viewerId: "mark", now, workspaces: [{ id: "ws-eclipse", name: "Eclipse" }] });
    assert.equal(one[0].workspaceName, null);
    const two = taskBlocks(tasks, {
      viewerId: "mark",
      now,
      workspaces: [
        { id: "ws-eclipse", name: "Eclipse" },
        { id: "ws-mark", name: "Mark Ridgeon" },
      ],
    });
    assert.deepEqual(
      two.map((block) => block.workspaceName),
      ["Eclipse", "Mark Ridgeon"],
    );
  });

  it("counts a timed task overdue once its block has ended, and a date-only one after its day", () => {
    const timed = task({ dueAt: "2026-11-12T11:00:00.000Z", dueHasTime: true, durationMinutes: 30 });
    assert.equal(isBlockOverdue(timed, Date.parse("2026-11-12T11:29:00.000Z")), false);
    assert.equal(isBlockOverdue(timed, Date.parse("2026-11-12T11:30:00.000Z")), true);
    const dated = task({ dueAt: "2026-11-12T00:00:00.000Z" });
    assert.equal(isBlockOverdue(dated, Date.parse("2026-11-12T23:59:00.000Z")), false);
    assert.equal(isBlockOverdue(dated, Date.parse("2026-11-13T00:00:00.000Z")), true);
  });
});

describe("the Calendar task list", () => {
  it("groups Overdue, Today, This week, Later and No date on London days in summer time", () => {
    const now = Date.parse("2026-07-02T09:00:00.000Z");
    const tasks = [
      task({ id: "none", title: "No date" }),
      task({ id: "later", title: "Monday", dueAt: "2026-07-05T23:00:00.000Z" }),
      task({ id: "sunday", title: "Sunday", dueAt: "2026-07-04T23:00:00.000Z" }),
      task({ id: "friday", title: "Friday", dueAt: "2026-07-02T23:00:00.000Z" }),
      task({ id: "today", title: "Today date only", dueAt: "2026-07-01T23:00:00.000Z" }),
      task({ id: "running", title: "Running", dueAt: "2026-07-02T08:55:00.000Z", dueHasTime: true }),
      task({ id: "ended", title: "Ended", dueAt: "2026-07-02T08:30:00.000Z", dueHasTime: true }),
      task({ id: "yesterday", title: "Yesterday", dueAt: "2026-06-30T23:00:00.000Z" }),
      task({ id: "done", title: "Done", dueAt: "2026-07-01T23:00:00.000Z", completedAt: "2026-07-02T08:00:00.000Z" }),
    ];
    const groups = groupTaskList(tasks, now);
    assert.deepEqual(
      groups.map((group) => [group.label, group.tasks.map((item) => item.id)]),
      [
        ["Overdue", ["yesterday", "ended"]],
        ["Today", ["today", "running"]],
        ["This week", ["friday", "sunday"]],
        ["Later", ["later"]],
        ["No date", ["none"]],
      ],
    );
  });

  it("keeps the week on London days across the October clock change", () => {
    const now = Date.parse("2026-10-24T11:00:00.000Z");
    assert.equal(taskListGroupKind(task({ dueAt: "2026-10-24T23:00:00.000Z" }), now), "week");
    assert.equal(taskListGroupKind(task({ dueAt: "2026-10-26T00:00:00.000Z" }), now), "later");
    assert.equal(taskListGroupKind(task({ dueAt: "2026-10-25T23:30:00.000Z", dueHasTime: true }), now), "week");
    assert.equal(taskListGroupKind(task({ dueAt: "2026-10-26T00:30:00.000Z", dueHasTime: true }), now), "later");
  });
});

describe("tasks on the calendar, from the database", () => {
  let mark: UserActor;
  let personal: UserActor;
  let sam: UserActor;
  const today = dateKey(Date.now());
  const at = (days: number, hour: number, minute = 0) => new Date(wallInstant(shiftDateKey(today, days), hour, minute)).toISOString();

  before(async () => {
    await resetDatabase();
    mark = { ...(await createUser("mark@blocks.test", "Mark Ridgeon")), workspaceName: "Eclipse" };
    await getAdminPool().query("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    const created = await createWorkspace(mark, { name: "Mark Ridgeon" });
    personal = { ...mark, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    const samId = (await getAdminPool().query<{ id: string }>("select private.create_local_user('sam@blocks.test', 'password-123', 'Sam Okafor') as id")).rows[0].id;
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, samId]);
    sam = { ...mark, userId: samId, email: "sam@blocks.test", fullName: "Sam Okafor", role: "member", scopes: scopesForRole("member") };
  });

  it("reads owned timed tasks from every workspace, and leaves out created-only, tagged and admin-visible ones", async () => {
    const make = async (actor: UserActor, title: string, input: Record<string, unknown>) => (await createTask(actor, { title, ...input })).body.task;
    const owned = await make(mark, "Call Jane Cooper", { dueAt: at(1, 10), durationMinutes: 30 });
    const elsewhere = await make(personal, "Email the accountant", { dueAt: at(1, 12) });
    const dated = await make(mark, "Send the deck", { dueDate: shiftDateKey(today, 2) });
    const forSam = await make(mark, "Sam's follow-up", { dueAt: at(1, 11), ownerId: sam.userId });
    const tagged = await make(sam, "Sam tags Mark", { dueAt: at(1, 13) });
    await addTaskParticipants(sam, tagged.id, [mark.userId]);
    const samsOwn = await make(sam, "Sam's own call", { dueAt: at(1, 14) });
    const unassigned = await make(mark, "Unassigned call", { dueAt: at(1, 15), ownerId: null });
    const doneToday = await make(mark, "Done today", { dueAt: at(0, 0, 5) });
    await completeTask(mark, doneToday.id);

    const planner = await readPlanner(mark);
    const ids = new Set(planner.tasks.map((item) => item.id));
    for (const wanted of [owned, elsewhere, dated, unassigned, doneToday]) assert.ok(ids.has(wanted.id), wanted.title);
    for (const unwanted of [forSam, tagged, samsOwn]) assert.ok(!ids.has(unwanted.id), unwanted.title);
    assert.deepEqual(
      planner.workspaces.map((item) => item.name).sort(),
      ["Eclipse", "Mark Ridgeon"],
    );

    const blocks = taskBlocks(planner.tasks, { viewerId: mark.userId, now: Date.now(), workspaces: planner.workspaces });
    const byTitle = new Map(blocks.map((block) => [block.title, block]));
    assert.deepEqual([...byTitle.keys()].sort(), ["Call Jane Cooper", "Done today", "Email the accountant"]);
    assert.equal(byTitle.get("Call Jane Cooper")?.workspaceName, "Eclipse");
    assert.equal(byTitle.get("Email the accountant")?.workspaceName, "Mark Ridgeon");
    assert.equal(byTitle.get("Done today")?.done, true);
    const listed = groupTaskList(planner.tasks, Date.now()).flatMap((group) => group.tasks.map((item) => item.title));
    assert.ok(listed.includes("Unassigned call"));
    assert.ok(listed.includes("Send the deck"));
    assert.ok(!listed.includes("Done today"));

    const team = planner.teams.find((item) => item.id === mark.workspaceId);
    assert.deepEqual(team?.members.map((member) => member.name).sort(), ["Mark Ridgeon", "Sam Okafor"]);
  });

  it("gives someone in one workspace no workspace names", async () => {
    await createTask(sam, { title: "Sam's block", dueAt: at(1, 9) });
    const planner = await readPlanner(sam);
    assert.equal(planner.workspaces.length, 1);
    const blocks = taskBlocks(planner.tasks, { viewerId: sam.userId, now: Date.now(), workspaces: planner.workspaces });
    assert.ok(blocks.length > 0);
    assert.ok(blocks.every((block) => block.workspaceName === null));
  });

  it("acts on a task in the workspace it belongs to", async () => {
    const elsewhere = (await createTask(personal, { title: "Book the dentist", dueAt: at(2, 9) })).body.task;
    const actor = await actorForTask(mark, elsewhere.id);
    assert.equal(actor.workspaceId, personal.workspaceId);
    assert.equal(actor.workspaceName, "Mark Ridgeon");
    assert.equal((await actorForTask(mark, "not-a-task")).workspaceId, mark.workspaceId);
    await completeTask(actor, elsewhere.id);
    assert.ok((await getTask(personal, elsewhere.id)).completedAt);
    const audit = await getAdminPool().query<{ workspace_id: string }>(
      "select workspace_id from crm.audit_events where entity_id = $1 and operation = 'complete_task'",
      [elsewhere.id],
    );
    assert.deepEqual(
      audit.rows.map((row) => row.workspace_id),
      [personal.workspaceId],
    );
  });

  it("returns the viewer's task blocks from list_calendar_events, marked as tasks", async () => {
    const admin = getAdminPool();
    const connection = (
      await admin.query<{ id: string }>(
        `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
         values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id`,
        [mark.workspaceId, mark.userId, mark.email],
      )
    ).rows[0].id;
    const calendarId = (
      await admin.query<{ id: string }>(
        "insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color) values ($1, $2, $3, 'cal', 'Calendar', '#4f9be8') returning id",
        [mark.workspaceId, mark.userId, connection],
      )
    ).rows[0].id;
    await admin.query(
      `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, show_as)
       values ($1, $2, $3, $4, 'evt-1', 'Halden weekly', $5, $6, 'busy')`,
      [mark.workspaceId, calendarId, connection, mark.userId, at(3, 14, 30), at(3, 15, 15)],
    );
    const clash = (await createTask(mark, { title: "Price Q1 for Northwind", dueAt: at(3, 14, 30), durationMinutes: 30 })).body.task;
    const result = (await runTool(mark, "list_calendar_events", { from: shiftDateKey(today, 3), to: shiftDateKey(today, 3) })) as {
      events: { subject: string }[];
      taskBlocks: Record<string, unknown>[];
    };
    assert.deepEqual(
      result.events.map((event) => event.subject),
      ["Halden weekly"],
    );
    assert.deepEqual(result.taskBlocks, [
      {
        kind: "task",
        id: clash.id,
        title: "Price Q1 for Northwind",
        start: at(3, 14, 30),
        end: new Date(Date.parse(at(3, 14, 30)) + 30 * MINUTE).toISOString(),
        durationMinutes: 30,
        overdue: false,
        done: false,
        clashesWith: "Halden weekly",
        workspace: "Eclipse",
      },
    ]);
    const samResult = (await runTool(sam, "list_calendar_events", { from: shiftDateKey(today, 1), to: shiftDateKey(today, 1) })) as { taskBlocks: Record<string, unknown>[] };
    assert.ok(samResult.taskBlocks.length > 0);
    assert.ok(samResult.taskBlocks.every((block) => !("workspace" in block)));
    assert.ok(samResult.taskBlocks.every((block) => block.title !== "Call Jane Cooper"));
  });
});

describe("acting on a task in its own workspace", () => {
  const RANDOM = "11111111-2222-4333-8444-555555555555";
  const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const failure = async (work: () => Promise<unknown>) => {
    try {
      await work();
      return "";
    } catch (error) {
      const known = error as { code?: string; status?: number; message?: string };
      return `${known.code}|${known.status}|${known.message}`;
    }
  };
  const beacon = (ids: string[], origin = "http://localhost") =>
    new Request("http://localhost/api/tasks/complete", { method: "POST", headers: { origin, host: "localhost" }, body: JSON.stringify({ ids }) });
  let markA: UserActor;
  let markB: UserActor;
  let samA: UserActor;
  let eve: UserActor;
  let danaA: UserActor;
  let danaB: UserActor;

  before(async () => {
    const admin = getAdminPool();
    markA = { ...(await createUser("mark@scope.test", "Mark Scope")), workspaceName: "Scope A" };
    await admin.query("update crm.workspaces set name = 'Scope A' where id = $1", [markA.workspaceId]);
    const second = await createWorkspace(markA, { name: "Secret B" });
    markB = { ...markA, workspaceId: second.id, workspaceName: "Secret B" };
    const person = async (email: string, name: string) => (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
    const join = (workspaceId: string, userId: string, role: string) => admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, userId, role]);
    const samId = await person("sam@scope.test", "Sam Scope");
    await join(markA.workspaceId, samId, "member");
    samA = { ...markA, userId: samId, email: "sam@scope.test", fullName: "Sam Scope", role: "member", scopes: scopesForRole("member") };
    eve = await createUser("eve@scope.test", "Eve Outsider");
    const danaId = await person("dana@scope.test", "Dana Scope");
    await join(markA.workspaceId, danaId, "admin");
    await join(markB.workspaceId, danaId, "member");
    danaA = { ...markA, userId: danaId, email: "dana@scope.test", fullName: "Dana Scope", role: "admin", scopes: scopesForRole("admin") };
    danaB = { ...danaA, workspaceId: markB.workspaceId, workspaceName: "Secret B", role: "member", scopes: scopesForRole("member") };
  });

  it("never moves someone outside the workspace into it, and fails like an unknown task", async () => {
    const hidden = (await createTask(markB, { title: "B private", dueAt: soon(30) })).body.task;
    const resolved = await actorForTask(eve, hidden.id);
    assert.equal(resolved, eve);
    const seen = await failure(() => completeTask(resolved, hidden.id));
    assert.match(seen, /^not_found\|404/);
    assert.equal(seen, await failure(async () => completeTask(await actorForTask(eve, RANDOM), RANDOM)));
    const forged = { ...eve, workspaceId: markB.workspaceId, role: "owner" as const, scopes: scopesForRole("owner") };
    assert.match(await failure(() => completeTask(forged, hidden.id)), /^not_found\|404/);
    assert.deepEqual((await completeTasksFromBeacon(beacon([hidden.id, RANDOM]), eve)).completed, []);
    assert.equal((await getTask(markB, hidden.id)).completedAt, null);
  });

  it("leaves a member on their own actor for a task they can't see", async () => {
    const marks = (await createTask(markA, { title: "Mark only", dueAt: soon(30) })).body.task;
    const resolved = await actorForTask(samA, marks.id);
    assert.equal(resolved, samA);
    assert.match(await failure(() => completeTask(resolved, marks.id)), /^not_found\|404/);
    assert.match(await failure(() => updateTask(resolved, marks.id, { title: "x" })), /^not_found\|404/);
    assert.equal((await getTask(markA, marks.id)).completedAt, null);
  });

  it("takes the role from the task's workspace, so an admin elsewhere who is tagged here can't change it", async () => {
    const tagged = (await createTask(markB, { title: "Mark tags Dana", dueAt: soon(31) })).body.task;
    await addTaskParticipants(markB, tagged.id, [danaA.userId]);
    const resolved = await actorForTask(danaA, tagged.id);
    assert.equal(resolved.workspaceId, markB.workspaceId);
    assert.equal(resolved.role, "member");
    assert.match(await failure(() => updateTask(resolved, tagged.id, { title: "renamed" })), /^forbidden\|403/);
    assert.match(await failure(() => completeTask(resolved, tagged.id)), /^forbidden\|403/);
    assert.match(await failure(() => updateTask(danaA, tagged.id, { title: "renamed as an admin of A" })), /^forbidden\|403/);
    const task = await getTask(markB, tagged.id);
    assert.equal(task.title, "Mark tags Dana");
    assert.equal(task.completedAt, null);
  });

  it("refuses people and records from the workspace the viewer came from", async () => {
    const own = (await createTask(danaB, { title: "Dana's own in B", dueAt: soon(40) })).body.task;
    const resolved = await actorForTask(danaA, own.id);
    assert.equal(resolved.workspaceId, markB.workspaceId);
    const contact = (await createContact(markA, { firstName: "Ann", lastName: "Scope", email: "ann@scope.test" })).body.contact;
    assert.match(await failure(() => updateTask(resolved, own.id, { ownerId: samA.userId })), /^invalid_input\|400/);
    assert.match(await failure(() => linkTask(resolved, own.id, { contactId: contact.id }, { operation: "link_task", source: "web" })), /^not_found\|404/);
    const task = await getTask(danaB, own.id);
    assert.equal(task.ownerId, danaA.userId);
    assert.equal(task.contactId, null);
  });

  it("keeps an agent token to its own workspace", async () => {
    const target = (await createTask(markB, { title: "Agent target", dueAt: soon(60) })).body.task;
    const { actor } = await createAgent(markA.workspaceId, ["crm:read", "tasks:write"]);
    assert.match(await failure(() => getTask(actor, target.id)), /^not_found\|404/);
    assert.match(await failure(() => completeTask(actor, target.id)), /^not_found\|404/);
    assert.equal((await getTask(markB, target.id)).completedAt, null);
  });

  it("completes from the beacon in the task's workspace and audits it there once", async () => {
    const target = (await createTask(markB, { title: "Beacon in B", dueAt: soon(50) })).body.task;
    const result = await completeTasksFromBeacon(beacon([target.id]), markA);
    assert.deepEqual(result.completed, [target.id]);
    assert.equal(result.actors.get(target.id)?.workspaceId, markB.workspaceId);
    const audits = await getAdminPool().query<{ workspace_id: string }>("select workspace_id from crm.audit_events where entity_id = $1 and operation = 'complete_task'", [target.id]);
    assert.deepEqual(
      audits.rows.map((row) => row.workspace_id),
      [markB.workspaceId],
    );
    assert.equal((await completeTasksFromBeacon(beacon([target.id], "http://evil.test"), markA)).status, 403);
    assert.equal((await completeTasksFromBeacon(beacon([target.id]), null)).status, 401);
  });

  it("refuses when the lookup itself fails instead of acting in the current workspace", async () => {
    const target = (await createTask(markB, { title: "Lookup fails", dueAt: soon(70) })).body.task;
    const broken = { ...markA, userId: "not-a-user-id" };
    await assert.rejects(() => actorForTask(broken, target.id));
    assert.deepEqual(await taskActorOrError(broken, target.id), { error: TASK_LOOKUP_FAILED });
    assert.equal(TASK_LOOKUP_FAILED, "Couldn't find that task. Try again.");
    assert.deepEqual((await completeTasksFromBeacon(beacon([target.id]), broken)).completed, []);
    assert.equal((await getTask(markB, target.id)).completedAt, null);
  });

  it("shows an admin only their own blocks, and someone in one workspace no other names", async () => {
    await createTask(samA, { title: "Sam timed", dueAt: soon(26) });
    await createTask(danaA, { title: "Dana timed in A", dueAt: soon(27) });
    const planner = await readPlanner(danaA);
    const blocks = taskBlocks(planner.tasks, { viewerId: danaA.userId, now: Date.now(), workspaces: planner.workspaces });
    assert.ok(blocks.length > 0);
    assert.ok(blocks.every((block) => block.task.ownerId === danaA.userId));
    const single = JSON.stringify(await readPlanner(samA));
    assert.ok(!single.includes("Secret B") && !single.includes(markB.workspaceId));
    const tool = JSON.stringify(await runTool(samA, "list_calendar_events", {}));
    assert.ok(!tool.includes("Secret B") && !tool.includes(markB.workspaceId) && !tool.includes('"workspace"'));
    assert.equal((await readPlanner(eve)).tasks.length, 0);
  });
});
