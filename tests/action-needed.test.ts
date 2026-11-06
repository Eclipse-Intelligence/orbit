import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listWaitingOnOthers, pastOneWorkingDay, snoozeTask, taskSnoozeChoices, waitingFor, waitingIn } from "@/lib/crm/action-needed";
import { captureStatus, captureStatuses, listToFile, markCaptureSeen } from "@/lib/crm/capture";
import { readCaptureAction, runCaptureAction } from "@/lib/crm/capture-actions";
import { captureSummary, dueLabel } from "@/lib/crm/capture-format";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask, getTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace, workspaceActors } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { dismissReply, replyArrival, waitingMail, workingDaysCutoff, workingDaysSince } from "@/lib/mail/waiting";
import { startOfDay } from "@/lib/time";
import { listNotifications } from "@/lib/workflows/store";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

type Box = { sourceId: string; inbox: string; sent: string; archive: string; snoozed: string; trash: string };

const DAY_MS = 86_400_000;
let counter = 0;

async function teammate(owner: UserActor, email: string, name: string, role: "member" | "admin" = "member"): Promise<UserActor> {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [owner.workspaceId, id, role]);
  return { ...owner, userId: id, email, fullName: name, role, scopes: scopesForRole(role) };
}

async function mailbox(actor: UserActor): Promise<Box> {
  const admin = getAdminPool();
  const connection = await admin.query<{ id: string }>(
    `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
     values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id`,
    [actor.workspaceId, actor.userId, actor.email],
  );
  const sourceId = (
    await admin.query<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id", [
      actor.workspaceId,
      actor.userId,
      connection.rows[0].id,
      actor.email,
    ])
  ).rows[0].id;
  const folder = async (role: string) =>
    (
      await admin.query<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $4, $5) returning id",
        [actor.workspaceId, actor.userId, sourceId, `${role}-${sourceId}`, role],
      )
    ).rows[0].id;
  return {
    sourceId,
    inbox: await folder("inbox"),
    sent: await folder("sent"),
    archive: await folder("archive"),
    snoozed: await folder("snoozed"),
    trash: await folder("trash"),
  };
}

type MessageInput = {
  thread?: string;
  from: string;
  name?: string;
  to: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  at: string;
  folder?: keyof Omit<Box, "sourceId">;
  focused?: boolean | null;
};

async function message(actor: UserActor, box: Box, values: MessageInput) {
  counter += 1;
  const id = `msg-${counter}`;
  const thread = values.thread ?? id;
  const result = await getAdminPool().query<{ id: string }>(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
       from_email, from_name, to_recipients, cc_recipients, sent_at, received_at, focused)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $14, $15) returning id`,
    [
      actor.workspaceId,
      actor.userId,
      box.sourceId,
      box[values.folder ?? "inbox"],
      id,
      `<${id}@mail.test>`,
      thread,
      values.subject ?? `Subject ${counter}`,
      values.body ?? "Could you take a look and let me know?",
      values.from,
      values.name ?? null,
      JSON.stringify(values.to.map((address) => ({ name: "", address }))),
      JSON.stringify((values.cc ?? []).map((address) => ({ name: "", address }))),
      values.at,
      values.focused === undefined ? null : values.focused,
    ],
  );
  return { id: result.rows[0].id, key: `${box.sourceId}|${thread}` };
}

async function nudge(actor: UserActor, box: Box, messageId: string, thread: string, state = "ready") {
  await getAdminPool().query(
    `insert into crm.mail_prepared (workspace_id, user_id, source_id, thread_key, message_id, kind, state, body)
     values ($1, $2, $3, $4, $5, 'nudge', $6, 'Hi, just bringing this back up.')`,
    [actor.workspaceId, actor.userId, box.sourceId, thread, messageId, state],
  );
}

async function backdate(table: "workflow_runs", id: string, at: Date) {
  const client = await getAdminPool().connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(`update crm.${table} set updated_at = $2 where id = $1`, [id, at]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

async function waitingRun(actor: UserActor, title: string, at = new Date()) {
  const admin = getAdminPool();
  const definition = {
    version: 2,
    trigger: { type: "manual", object: "contact" },
    triggerPosition: { x: 0, y: 0 },
    nodes: [{ id: "approval_1", type: "approval", config: { title, details: "" }, position: { x: 0, y: 0 } }],
    edges: [{ source: "trigger", handle: "out", target: "approval_1" }],
  };
  const workflow = (
    await admin.query<{ id: string }>(
      "insert into crm.workflows (workspace_id, owner_id, name, status, definition) values ($1, $2, $3, 'active', $4::jsonb) returning id",
      [actor.workspaceId, actor.userId, `${title} flow`, JSON.stringify(definition)],
    )
  ).rows[0].id;
  const state = {
    started: true,
    frames: [],
    at: "approval_1",
    waitingStep: "approval_1",
    approval: { stepId: "approval_1", title, details: "Please check" },
    vars: { steps: {} },
  };
  const run = (
    await admin.query<{ id: string }>(
      `insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, status, waiting_for, definition, state)
       values ($1, $2, $3, 'waiting', 'approval', $4::jsonb, $5::jsonb) returning id`,
      [actor.workspaceId, workflow, actor.userId, JSON.stringify(definition), JSON.stringify(state)],
    )
  ).rows[0].id;
  await backdate("workflow_runs", run, at);
  return run;
}

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("working days for Capture", () => {
  it("counts London working days across weekends and bank holidays", () => {
    const afterHoliday = new Date("2026-05-26T09:00:00Z");
    assert.equal(
      workingDaysCutoff(afterHoliday, 2).toISOString(),
      "2026-05-21T23:00:00.000Z",
      "Monday 25 May is a bank holiday, so two working days back is Friday",
    );
    assert.equal(workingDaysSince("2026-05-21T10:00:00Z", afterHoliday), 2);
    assert.equal(workingDaysSince("2026-05-22T10:00:00Z", afterHoliday), 1);
    assert.equal(replyArrival("2026-05-21T10:00:00Z"), "2026-05-25T23:00:00.000Z");

    const monday = new Date("2026-11-09T10:00:00Z");
    assert.equal(workingDaysCutoff(monday, 2).toISOString(), "2026-11-06T00:00:00.000Z", "the weekend doesn't count");
    assert.equal(workingDaysSince("2026-11-05T16:00:00Z", monday), 2);
    assert.equal(workingDaysSince("2026-11-06T09:00:00Z", monday), 1);
  });

  it("waits more than one working day before showing a colleague's approval", () => {
    assert.equal(pastOneWorkingDay("2026-11-06T15:00:00Z", new Date("2026-11-09T14:00:00Z")), false);
    assert.equal(pastOneWorkingDay("2026-11-06T15:00:00Z", new Date("2026-11-09T16:00:00Z")), true);
    assert.equal(pastOneWorkingDay("2026-11-07T10:00:00Z", new Date("2026-11-09T23:00:00Z")), false, "a Saturday request starts counting on Monday");
    assert.equal(pastOneWorkingDay("2026-11-07T10:00:00Z", new Date("2026-11-10T01:00:00Z")), true);
  });

  it("snoozes a task to working days and keeps its time of day", () => {
    const friday = taskSnoozeChoices("2026-11-06T14:00:00Z", new Date("2026-11-06T10:00:00Z"));
    assert.deepEqual(
      friday.map((choice) => [choice.id, choice.label, choice.at]),
      [
        ["later", "Later today", "2026-11-06T13:00:00.000Z"],
        ["tomorrow", "Next working day", "2026-11-09T14:00:00.000Z"],
      ],
    );
    const thursday = taskSnoozeChoices("2026-05-21T08:00:00Z", new Date("2026-05-21T20:30:00Z"));
    assert.deepEqual(
      thursday.map((choice) => [choice.id, choice.label, choice.at]),
      [
        ["tomorrow", "Tomorrow", "2026-05-22T08:00:00.000Z"],
        ["next-week", "Next week", "2026-05-26T08:00:00.000Z"],
      ],
      "next week skips the bank holiday Monday",
    );
    assert.equal(taskSnoozeChoices(null, new Date("2026-11-04T10:00:00Z"))[1].at, "2026-11-05T09:00:00.000Z", "no time of day means 09:00");
  });

  it("labels due dates and sums sections for the bell", () => {
    const now = new Date("2026-11-06T12:00:00Z").getTime();
    assert.equal(dueLabel("2026-11-04T09:00:00Z", now), "2 days overdue");
    assert.equal(dueLabel("2026-11-05T09:00:00Z", now), "Yesterday");
    assert.equal(dueLabel("2026-11-06T14:00:00Z", now), "Today 14:00");
    assert.equal(dueLabel("2026-11-06T00:00:00Z", now), "Today");
    assert.equal(captureSummary({ approvals: 3, followUps: 1, replies: 0, tasks: 4, toFile: 5 }), "3 approvals, 1 follow-up, 4 tasks, 5 to file");
  });
});

describe("Replies waiting on you", () => {
  const now = new Date("2026-05-26T09:00:00Z");
  let mark: UserActor;
  let james: UserActor;
  let box: Box;

  before(async () => {
    mark = await createUser("mark@eclipse-replies.test", "Mark Ridgeon");
    james = await teammate(mark, "james@eclipse-replies.test", "James Carter");
    box = await mailbox(mark);
    const kestrel = (await createCompany(mark, { name: "Kestrel Logistics", domain: "kestrel.test" })).body.company.id;
    await createContact(mark, { firstName: "Daniel", lastName: "Hughes", email: "daniel@kestrel.test", companyId: kestrel });
  });

  async function keys() {
    return (await waitingMail(mark, [mark], now)).replies.map((reply) => reply.key);
  }

  it("lists threads whose latest email is from a person, to you, two working days old", async () => {
    const waiting = await message(mark, box, {
      from: "daniel@kestrel.test",
      name: "Daniel Hughes",
      to: [mark.email],
      subject: "Contract redlines",
      at: "2026-05-21T10:00:00Z",
    });
    const recent = await message(mark, box, { from: "sarah@fernhill.test", to: [mark.email], at: "2026-05-22T09:00:00Z" });
    const copied = await message(mark, box, { from: "lena@agency.test", to: ["team@agency.test"], cc: [mark.email], at: "2026-05-20T09:00:00Z" });
    const robot = await message(mark, box, { from: "noreply@vendor.test", to: [mark.email], at: "2026-05-20T09:00:00Z" });
    const letter = await message(mark, box, {
      from: "editor@weekly.test",
      to: [mark.email],
      body: "This week in logistics. Unsubscribe here.",
      at: "2026-05-20T09:00:00Z",
    });
    const other = await message(mark, box, { from: "pitch@growth.test", to: [mark.email], focused: false, at: "2026-05-20T09:00:00Z" });
    const old = await message(mark, box, { from: "old@friend.test", to: [mark.email], at: "2026-04-01T09:00:00Z" });

    const replies = (await waitingMail(mark, [mark], now)).replies;
    assert.deepEqual(
      replies.map((reply) => reply.key),
      [waiting.key],
    );
    const [reply] = replies;
    assert.equal(reply.subject, "Contract redlines");
    assert.equal(reply.company, "Kestrel Logistics");
    assert.equal(reply.waitingDays, 2);
    assert.equal(reply.workspaceId, mark.workspaceId);
    for (const skipped of [recent, copied, robot, letter, other, old]) assert.ok(!replies.some((item) => item.key === skipped.key));
  });

  it("drops a thread once you reply, archive, snooze or say no reply is needed", async () => {
    const replied = await message(mark, box, { thread: "replied", from: "anna@client.test", to: [mark.email], at: "2026-05-19T09:00:00Z" });
    await message(mark, box, { thread: "replied", from: mark.email, to: ["anna@client.test"], folder: "sent", at: "2026-05-19T12:00:00Z" });
    const archived = await message(mark, box, { from: "ben@client.test", to: [mark.email], folder: "archive", at: "2026-05-19T09:00:00Z" });
    const snoozed = await message(mark, box, { from: "cara@client.test", to: [mark.email], folder: "snoozed", at: "2026-05-19T09:00:00Z" });
    const dismissed = await message(mark, box, { thread: "dismissed", from: "dev@client.test", to: [mark.email], at: "2026-05-18T09:00:00Z" });
    const twice = await message(mark, box, { thread: "twice", from: "eve@client.test", to: [mark.email], at: "2026-05-18T09:00:00Z" });
    await message(mark, box, { thread: "twice", from: "eve@client.test", to: [mark.email], at: "2026-05-19T09:00:00Z" });

    let listed = await keys();
    assert.ok(listed.includes(dismissed.key));
    assert.equal(listed.filter((key) => key === twice.key).length, 1, "one row per conversation");
    for (const gone of [replied, archived, snoozed]) assert.ok(!listed.includes(gone.key));

    await dismissReply(mark, dismissed.key, "2026-05-18T09:00:00Z");
    listed = await keys();
    assert.ok(!listed.includes(dismissed.key));

    await message(mark, box, { thread: "dismissed", from: "dev@client.test", to: [mark.email], at: "2026-05-20T09:00:00Z" });
    assert.ok((await keys()).includes(dismissed.key), "a newer email from them brings it back");
  });

  it("is private to the person whose mail it is", async () => {
    assert.deepEqual((await waitingMail(james, [james], now)).replies, []);
    const dismissals = await queryAsUser<{ id: string }>(james.userId, "select id from crm.capture_dismissals");
    assert.equal(dismissals.length, 0);
    const own = await queryAsUser<{ id: string }>(mark.userId, "select id from crm.capture_dismissals");
    assert.equal(own.length, 1);
    await assert.rejects(dismissReply(james, `${box.sourceId}|dismissed`, "2026-05-20T09:00:00Z"), /Conversation not found/);
  });
});

describe("Follow-ups across workspaces", () => {
  let eclipse: UserActor;
  let personal: UserActor;
  let box: Box;

  before(async () => {
    eclipse = await createUser("mark@eclipse-follow.test", "Mark Ridgeon");
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon", brandStart: "blank" });
    personal = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    box = await mailbox(eclipse);
    await createContact(personal, { firstName: "Grace", lastName: "Lin", email: "grace@halden.test" });
  });

  it("shows a ready follow-up in the workspace the conversation is filed in, else the home workspace", async () => {
    const sent = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    const filed = await message(eclipse, box, {
      thread: "halden",
      from: eclipse.email,
      to: ["grace@halden.test"],
      subject: "Security pack",
      folder: "sent",
      at: sent(5),
    });
    await nudge(eclipse, box, filed.id, "halden");
    const unknown = await message(eclipse, box, {
      thread: "pricing",
      from: eclipse.email,
      to: ["tom@becker.test"],
      subject: "Pilot pricing",
      folder: "sent",
      at: sent(6),
    });
    await nudge(eclipse, box, unknown.id, "pricing");
    const answered = await message(eclipse, box, { thread: "answered", from: eclipse.email, to: ["amelia@ross.test"], folder: "sent", at: sent(6) });
    await nudge(eclipse, box, answered.id, "answered");
    await message(eclipse, box, { thread: "answered", from: "amelia@ross.test", to: [eclipse.email], at: sent(1) });
    const dropped = await message(eclipse, box, { thread: "dropped", from: eclipse.email, to: ["zed@ross.test"], folder: "sent", at: sent(6) });
    await nudge(eclipse, box, dropped.id, "dropped", "dismissed");

    const actors = await workspaceActors(eclipse);
    const waiting = await waitingFor(eclipse, actors);
    assert.deepEqual(waiting.nudges.map((item) => [item.subject, item.workspaceId === personal.workspaceId ? "Mark Ridgeon" : "Eclipse"]).sort(), [
      ["Pilot pricing", "Eclipse"],
      ["Security pack", "Mark Ridgeon"],
    ]);
    assert.equal(waitingIn(waiting, personal.workspaceId).nudges.length, 1);
    assert.equal(waitingIn(waiting, eclipse.workspaceId).nudges[0].to[0].address, "tom@becker.test");

    const statuses = await captureStatuses(eclipse);
    assert.equal(statuses.get(eclipse.workspaceId)?.sections.followUps, 1);
    assert.equal(statuses.get(personal.workspaceId)?.sections.followUps, 1);

    await runCaptureAction(eclipse, { kind: "nudge-dismiss", id: waitingIn(waiting, eclipse.workspaceId).nudges[0].id });
    assert.equal((await waitingFor(eclipse, actors)).nudges.length, 1);
  });
});

describe("Tasks, approvals and To file", () => {
  let mark: UserActor;
  let james: UserActor;

  before(async () => {
    mark = await createUser("mark@eclipse-tasks.test", "Mark Ridgeon");
    james = await teammate(mark, "james@eclipse-tasks.test", "James Carter");
  });

  it("lists your overdue tasks, then today's, and never a colleague's", async () => {
    const today = startOfDay(new Date());
    const due = (offset: number) => new Date(today.getTime() + offset).toISOString();
    const make = async (actor: UserActor, title: string, dueAt: string, ownerId: string | null = actor.userId) =>
      (await createTask(actor, { title, dueAt, ownerId })).body.task.id;
    const later = await make(mark, "Review Q4 pipeline", due(60_000));
    const overdue = await make(mark, "Send revised SOW", due(-2 * DAY_MS));
    await make(mark, "Next week thing", due(3 * DAY_MS));
    await make(mark, "Nobody's job", due(-DAY_MS), null);
    await make(james, "James's task", due(-DAY_MS));

    const tasks = (await waitingFor(mark, [mark])).tasks;
    assert.deepEqual(
      tasks.map((task) => [task.title, task.overdue]),
      [
        ["Send revised SOW", true],
        ["Review Q4 pipeline", false],
      ],
    );
    assert.deepEqual(
      (await waitingFor(james, [james])).tasks.map((task) => task.title),
      ["James's task"],
    );

    const choice = tasks[0].snooze.find((item) => item.id === "tomorrow")!;
    await runCaptureAction(mark, { kind: "task-snooze", id: overdue, until: choice.at });
    assert.equal((await getTask(mark, overdue)).dueAt, choice.at);
    await assert.rejects(snoozeTask(mark, later, new Date(Date.now() - 60_000).toISOString()), /at least a minute from now/);
    await runCaptureAction(mark, { kind: "task-done", id: later });
    assert.ok((await getTask(mark, later)).completedAt);
    assert.deepEqual((await waitingFor(mark, [mark])).tasks, []);
  });

  it("shows approvals waiting on you, and admins see a colleague's that has waited over a working day", async () => {
    const mine = await waitingRun(mark, "Send intro email to Priya Shah");
    const stale = await waitingRun(james, "Send renewal reminder to Brightline", new Date(Date.now() - 10 * DAY_MS));
    await waitingRun(james, "Fresh request");

    assert.deepEqual(
      (await waitingFor(mark, [mark])).approvals.map((item) => item.id),
      [mine],
    );
    assert.deepEqual((await waitingFor(james, [james])).approvals.map((item) => item.title).sort(), ["Fresh request", "Send renewal reminder to Brightline"]);
    const others = await listWaitingOnOthers(mark);
    assert.deepEqual(
      others.map((item) => [item.id, item.ownerName]),
      [[stale, "James Carter"]],
    );
    assert.ok(others[0].waitingDays >= 2);
    assert.deepEqual(await listWaitingOnOthers(james), [], "members don't see colleagues' approvals");

    await assert.rejects(runCaptureAction(mark, { kind: "approve", runId: stale }), /already been dealt with/, "nobody decides on someone else's behalf");
    await runCaptureAction(mark, { kind: "reject", runId: mine, note: "Not yet" });
    const run = await getAdminPool().query<{ status: string; state: { decisions?: Record<string, { approved: boolean; note: string | null }> } }>(
      "select status, state from crm.workflow_runs where id = $1",
      [mine],
    );
    assert.equal(run.rows[0].status, "cancelled");
    assert.deepEqual(run.rows[0].state.decisions?.approval_1, { approved: false, note: "Not yet", by: mark.userId });
    assert.deepEqual((await waitingFor(mark, [mark])).approvals, []);
  });

  it("lists only your own imported meetings to file", async () => {
    const admin = getAdminPool();
    const add = async (actor: UserActor, title: string) =>
      admin.query(
        `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, occurred_at, status)
         values ($1, $2, 'granola', $3, 'meeting', $4, now() - interval '1 hour', 'unfiled')`,
        [actor.workspaceId, actor.userId, `import-${title}`, title],
      );
    await add(mark, "Coffee with Ben");
    await add(james, "James's call");
    assert.deepEqual(
      (await listToFile(mark)).unfiled.map((item) => item.title),
      ["Coffee with Ben"],
    );
    assert.deepEqual(
      (await listToFile(james)).unfiled.map((item) => item.title),
      ["James's call"],
    );
    assert.equal((await captureStatus(mark)).sections.toFile, 1);
  });

  it("counts every section and shows the dot only for what arrived since you last looked", async () => {
    const status = await captureStatus(mark);
    assert.deepEqual(status.sections, { approvals: 0, followUps: 0, replies: 0, tasks: 0, toFile: 1 });
    assert.equal(status.waiting, 1);

    await markCaptureSeen(mark, new Date(Date.now() + 1000));
    assert.equal((await captureStatus(mark)).fresh, 0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await waitingRun(mark, "Move Halden to Negotiation");
    const fresh = await captureStatus(mark);
    assert.equal(fresh.sections.approvals, 1);
    assert.equal(fresh.fresh, 1, "a new approval lights the dot");
    assert.ok(fresh.newestAt && fresh.newestAt > (fresh.seenAt ?? ""));
  });

  it("keeps tasks, approvals and No reply yet alerts out of the bell", async () => {
    const admin = getAdminPool();
    const insert = (title: string, source: string | null, href: string | null) =>
      admin.query("insert into crm.notifications (workspace_id, user_id, title, href, source) values ($1, $2, $3, $4, $5)", [
        mark.workspaceId,
        mark.userId,
        title,
        href,
        source,
      ]);
    await insert("Approve: Send intro", "workflow_approval", `/workflows?approve=x`);
    await insert("No reply yet: Pilot pricing", "mail", "/mail?thread=a");
    await insert("Demo with Acme ended with no next step", "mail", "/capture");
    await insert("Follow-up sent to Grace", "mail", "/mail?thread=b");
    await insert("Workflow failed: Granola to ClickUp", "workflow", "/workflows");
    assert.deepEqual((await listNotifications(mark)).map((item) => item.title).sort(), ["Follow-up sent to Grace", "Workflow failed: Granola to ClickUp"]);
  });

  it("refuses changes it doesn't understand", () => {
    assert.throws(() => readCaptureAction({ kind: "delete-everything" }), /didn't understand/);
    assert.throws(() => readCaptureAction({ kind: "task-done", id: "not-an-id" }), /didn't understand/);
    assert.deepEqual(readCaptureAction({ kind: "reply-snooze", thread: " a|b ", until: "2026-11-09T08:00:00Z" }), {
      kind: "reply-snooze",
      thread: "a|b",
      until: "2026-11-09T08:00:00Z",
    });
  });
});
