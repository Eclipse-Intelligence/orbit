import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { completeTaskWithOutcome, relinkTask, taskContext } from "@/lib/crm/task-act";
import { mailThreadLine } from "@/lib/crm/task-description";
import { taskKind } from "@/lib/crm/task-kind";
import { addTaskParticipants, createTask, getTask, listTasks } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let northwind: string;
let ashby: string;
let jane: string;
let martin: string;
let renewal: string;
let markBox: Box;
let samBox: Box;
let counter = 0;

type Box = { sourceId: string; inbox: string; sent: string };

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function mailbox(actor: UserActor): Promise<Box> {
  const connection = await sql<{ id: string }>(
    `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
     values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id`,
    [actor.workspaceId, actor.userId, actor.email],
  );
  const sourceId = (
    await sql<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id", [
      actor.workspaceId,
      actor.userId,
      connection[0].id,
      actor.email,
    ])
  )[0].id;
  const folder = async (role: string) =>
    (
      await sql<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $4, $5) returning id",
        [actor.workspaceId, actor.userId, sourceId, `${role}-${sourceId}`, role],
      )
    )[0].id;
  return { sourceId, inbox: await folder("inbox"), sent: await folder("sent") };
}

async function message(actor: UserActor, box: Box, values: { thread: string; from: string; to: string[]; subject: string; at: string; sent?: boolean }) {
  counter += 1;
  await sql(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
       from_email, to_recipients, sent_at, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'Hello', $9, $10::jsonb, $11, $11)`,
    [
      actor.workspaceId,
      actor.userId,
      box.sourceId,
      values.sent ? box.sent : box.inbox,
      `act-${counter}`,
      `<act-${counter}@mail.test>`,
      values.thread,
      values.subject,
      values.from,
      JSON.stringify(values.to.map((address) => ({ name: "", address }))),
      values.at,
    ],
  );
}

async function audits(taskId: string, type: string) {
  return sql<{ changes: { fields?: string[] }; source: string | null; operation: string | null }>(
    "select changes, source, operation from crm.audit_events where entity_id = $1 and event_type = $2 order by created_at",
    [taskId, type],
  );
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@act.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@act.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@act.test", "Priya Shah"), "member");
  northwind = (await createCompany(mark, { name: "Northwind Trading", domain: "northwind-act.test" })).body.company.id;
  ashby = (await createCompany(mark, { name: "Ashby Freight", domain: "ashby-act.test" })).body.company.id;
  await sql("update crm.companies set phone = '+44 20 7946 0000' where id = $1", [ashby]);
  jane = (
    await createContact(mark, { companyId: northwind, firstName: "Jane", lastName: "Cooper", email: "jane@northwind-act.test", phone: "07700 900412", jobTitle: "Head of Operations" })
  ).body.contact.id;
  martin = (await createContact(mark, { companyId: ashby, firstName: "Martin", lastName: "Blake", email: "martin@ashby-act.test", phone: "07700 900731", jobTitle: "Finance Director" }))
    .body.contact.id;
  await createContact(mark, { companyId: ashby, firstName: "Samantha", lastName: "Reid", email: "sam.reid@ashby-act.test" });
  renewal = (await createOpportunity(mark, { companyId: northwind, name: "Northwind renewal 2027", value: 48000, currency: "GBP", primaryContactId: jane })).body.opportunity.id;
  await createActivity(mark, { type: "call", title: "Call with Jane", contactId: jane, occurredAt: "2026-11-04T10:00:00Z" });
  markBox = await mailbox(mark);
  samBox = await mailbox(sam);
  await message(mark, markBox, { thread: "renewal", from: "mark@act.test", to: ["jane@northwind-act.test"], subject: "Renewal terms, v2", at: "2026-11-06T09:00:00Z", sent: true });
  await message(sam, samBox, { thread: "secret", from: "jane@northwind-act.test", to: ["sam@act.test"], subject: "Sam's private pricing", at: "2026-11-10T09:00:00Z" });
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("taskKind", () => {
  it("works out the kind from the first action word in the title", () => {
    assert.equal(taskKind("Call Jane about the renewal terms"), "call");
    assert.equal(taskKind("Ring Ashby Freight about the pilot invoice"), "call");
    assert.equal(taskKind("phone the switchboard"), "call");
    assert.equal(taskKind("Email Raj the case study"), "email");
    assert.equal(taskKind("Reply to Lucy"), "email");
    assert.equal(taskKind("Send Jane the three-year price"), "email");
    assert.equal(taskKind("E-mail the board pack"), "email");
    assert.equal(taskKind("Book a demo with Lucy Hart"), "meeting");
    assert.equal(taskKind("Meet Oliver in Leeds"), "meeting");
    assert.equal(taskKind("Schedule a call with Emma"), "meeting");
    assert.equal(taskKind("Demo for Brightwell"), "meeting");
    assert.equal(taskKind("Call Jane to book a demo"), "call");
    assert.equal(taskKind("Follow up with Oliver about the order form"), "todo");
    assert.equal(taskKind("Bring the recall notes"), "todo");
    assert.equal(taskKind(""), "todo");
    assert.equal(taskKind(null), "todo");
  });
});

describe("contact details on the task", () => {
  it("carries the contact's job title, phone and email and the company's own phone", async () => {
    const task = (await createTask(mark, { title: "Call Jane", contactId: jane })).body.task;
    assert.equal(task.contactJobTitle, "Head of Operations");
    assert.equal(task.contactPhone, "07700 900412");
    assert.equal(task.contactEmail, "jane@northwind-act.test");
    assert.equal(task.companyPhone, null);
    const listed = (await listTasks(mark, { contactId: jane })).data.find((item) => item.id === task.id);
    assert.equal(listed?.contactPhone, "07700 900412");
    const company = (await createTask(mark, { title: "Ring them", companyId: ashby })).body.task;
    assert.equal(company.companyPhone, "+44 20 7946 0000");
  });
});

describe("task context", () => {
  it("shows the opportunity, the last activity and the viewer's own last email", async () => {
    const task = (await createTask(mark, { title: "Call Jane", contactId: jane })).body.task;
    const context = await taskContext(mark, task.id);
    assert.equal(context.opportunity?.id, renewal);
    assert.equal(context.opportunity?.value, "48000.00");
    assert.equal(context.opportunity?.currency, "GBP");
    assert.equal(context.lastActivity?.type, "call");
    assert.equal(context.lastActivity?.title, "Call with Jane");
    assert.equal(context.lastEmail?.subject, "Renewal terms, v2");
    assert.equal(context.thread, null);
    assert.deepEqual(context.people, []);
  });

  it("never shows another person's mail, and a tagged teammate sees no subject from the owner's thread", async () => {
    const description = mailThreadLine(markBox.sourceId, "renewal", "Renewal terms, v2");
    const task = (await createTask(mark, { title: "Reply to Jane", contactId: jane, description })).body.task;
    const own = await taskContext(mark, task.id);
    assert.equal(own.thread?.key, `${markBox.sourceId}|renewal`);
    assert.equal(own.thread?.subject, "Renewal terms, v2");
    assert.equal(own.lastEmail?.subject, "Renewal terms, v2");

    await addTaskParticipants(mark, task.id, [priya.userId]);
    const tagged = await taskContext(priya, task.id);
    assert.equal(tagged.thread, null);
    assert.equal(tagged.lastEmail, null);
    assert.equal(tagged.opportunity?.id, renewal);

    await addTaskParticipants(mark, task.id, [sam.userId]);
    const other = await taskContext(sam, task.id);
    assert.equal(other.thread, null);
    assert.equal(other.lastEmail?.subject, "Sam's private pricing");
    const again = await taskContext(mark, task.id);
    assert.notEqual(again.lastEmail?.subject, "Sam's private pricing");
  });

  it("refuses a task the viewer can't see", async () => {
    const task = (await createTask(mark, { title: "Private follow-up", contactId: jane, ownerId: mark.userId })).body.task;
    await assert.rejects(() => taskContext(priya, task.id), /not found/i);
  });

  it("offers the company's people on a company-only task", async () => {
    const task = (await createTask(mark, { title: "Ring Ashby about the invoice", companyId: ashby })).body.task;
    const context = await taskContext(mark, task.id);
    assert.equal(context.opportunity, null);
    assert.deepEqual(
      context.people.map((person) => person.name),
      ["Martin Blake", "Samantha Reid"],
    );
    assert.equal(context.people[0].phone, "07700 900731");
    assert.equal(context.people[1].phone, null);
  });
});

describe("relinking from the task", () => {
  it("links a picked company contact with an audited update", async () => {
    const task = (await createTask(mark, { title: "Ring Ashby about the invoice", companyId: ashby })).body.task;
    const linked = await relinkTask(mark, task.id, { kind: "contact", id: martin }, { operation: "link_task", source: "web" });
    assert.equal(linked.contactId, martin);
    assert.equal(linked.companyId, ashby);
    const events = await audits(task.id, "task.updated");
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "web");
    assert.equal(events[0].operation, "link_task");
    assert.ok(events[0].changes.fields?.includes("contactId"));
  });

  it("changes the contact, company and opportunity and keeps them consistent", async () => {
    const task = (await createTask(mark, { title: "Check in", contactId: jane, opportunityId: renewal })).body.task;
    assert.equal(task.companyId, northwind);
    const moved = await relinkTask(mark, task.id, { kind: "contact", id: martin }, { operation: "link_task", source: "web" });
    assert.deepEqual([moved.contactId, moved.companyId, moved.opportunityId], [martin, ashby, null]);
    const opportunity = await relinkTask(mark, task.id, { kind: "opportunity", id: renewal }, { operation: "link_task", source: "web" });
    assert.deepEqual([opportunity.contactId, opportunity.companyId, opportunity.opportunityId], [null, northwind, renewal]);
    const cleared = await relinkTask(mark, task.id, { kind: "company", id: null }, { operation: "link_task", source: "web" });
    assert.deepEqual([cleared.contactId, cleared.companyId, cleared.opportunityId], [null, null, null]);
    assert.equal((await audits(task.id, "task.updated")).length, 3);
  });

  it("only lets people who can change the task relink it", async () => {
    const task = (await createTask(mark, { title: "Check in with Martin", contactId: martin })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    await assert.rejects(() => relinkTask(priya, task.id, { kind: "contact", id: jane }, { operation: "link_task", source: "web" }), /Only the assignee/);
    assert.equal((await getTask(mark, task.id)).contactId, martin);
  });
});

describe("done with an outcome", () => {
  it("logs the note on the timeline, adds the next task with the same links and completes the task", async () => {
    const task = (await createTask(mark, { title: "Call Jane about the renewal", contactId: jane, opportunityId: renewal })).body.task;
    const result = await completeTaskWithOutcome(mark, task.id, {
      note: "Spoke to Jane. Happy with three years if the break is at 12 months.",
      kind: "call",
      next: { title: "Send Jane the three-year price", dueAt: "2026-11-13T09:00" },
    });
    assert.ok(result.task.completedAt);
    assert.equal(result.activity?.type, "call");
    assert.equal(result.activity?.title, "Spoke to Jane");
    assert.equal(result.activity?.contactId, jane);
    assert.equal(result.activity?.opportunityId, renewal);
    assert.equal(result.next?.title, "Send Jane the three-year price");
    assert.deepEqual([result.next?.contactId, result.next?.companyId, result.next?.opportunityId], [jane, northwind, renewal]);
    assert.equal(result.next?.ownerId, mark.userId);
    assert.ok(result.next?.dueAt);
    assert.equal((await audits(task.id, "task.completed")).length, 1);
    const created = await audits(result.next!.id, "task.created");
    assert.equal(created[0].source, "task_outcome");
  });

  it("just completes when nothing is entered, and never twice", async () => {
    const task = (await createTask(mark, { title: "Email Jane", contactId: jane })).body.task;
    const first = await completeTaskWithOutcome(mark, task.id, { note: "  ", kind: null, next: null });
    assert.ok(first.task.completedAt);
    assert.equal(first.activity, null);
    assert.equal(first.next, null);
    await completeTaskWithOutcome(mark, task.id, { note: "", kind: null, next: null });
    assert.equal((await audits(task.id, "task.completed")).length, 1);
  });

  it("refuses people who can't change the task and leaves nothing behind", async () => {
    const task = (await createTask(mark, { title: "Call Martin", contactId: martin })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    const before = await sql<{ count: number }>("select count(*)::int as count from crm.activities where contact_id = $1", [martin]);
    await assert.rejects(() => completeTaskWithOutcome(priya, task.id, { note: "Spoke to Martin", kind: "call", next: { title: "Chase Martin", dueAt: null } }), /Only the assignee/);
    const after = await sql<{ count: number }>("select count(*)::int as count from crm.activities where contact_id = $1", [martin]);
    assert.equal(after[0].count, before[0].count);
    assert.equal((await getTask(mark, task.id)).completedAt, null);
    const chase = await sql("select 1 from crm.tasks where title = 'Chase Martin'");
    assert.equal(chase.length, 0);
  });

  it("lets the assignee who didn't create it complete with an outcome", async () => {
    const task = (await createTask(mark, { title: "Call Martin back", contactId: martin, ownerId: sam.userId })).body.task;
    const result = await completeTaskWithOutcome(sam, task.id, { note: "Left a voicemail", kind: "call", next: null });
    assert.ok(result.task.completedAt);
    assert.equal(result.activity?.title, "Left a voicemail");
  });

  it("asks for a link before logging a note on an unlinked task", async () => {
    const task = (await createTask(mark, { title: "Tidy the shared drive", companyId: null, contactId: null, opportunityId: null })).body.task;
    await assert.rejects(() => completeTaskWithOutcome(mark, task.id, { note: "Done it", kind: null, next: null }), /Link a person or company first/);
    assert.equal((await getTask(mark, task.id)).completedAt, null);
  });
});
