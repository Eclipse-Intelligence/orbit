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
import { GET as restGetTask } from "@/app/api/v1/tasks/[id]/route";
import { randomUUID } from "node:crypto";
import { addTaskParticipants, createTask, getTask, listTasks, reopenTask, restoreTaskInDb } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";
import { withActor } from "@/lib/crm/context";

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let ava: UserActor;
let northwind: string;
let ashby: string;
let jane: string;
let martin: string;
let renewal: string;
let markBox: Box;
let samBox: Box;
let counter = 0;

type Box = { sourceId: string; inbox: string; sent: string; trash: string };

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
  return { sourceId, inbox: await folder("inbox"), sent: await folder("sent"), trash: await folder("trash") };
}

async function message(actor: UserActor, box: Box, values: { thread: string; from: string; to: string[]; cc?: string[]; subject: string; at: string; sent?: boolean; trash?: boolean }) {
  counter += 1;
  await sql(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
       from_email, to_recipients, cc_recipients, sent_at, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'Hello', $9, $10::jsonb, $12::jsonb, $11, $11)`,
    [
      actor.workspaceId,
      actor.userId,
      box.sourceId,
      values.trash ? box.trash : values.sent ? box.sent : box.inbox,
      `act-${counter}`,
      `<act-${counter}@mail.test>`,
      values.thread,
      values.subject,
      values.from,
      JSON.stringify(values.to.map((address) => ({ name: "", address }))),
      values.at,
      JSON.stringify((values.cc ?? []).map((address) => ({ name: "", address }))),
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
  ava = await join(await createUser("ava@act.test", "Ava Admin"), "admin");
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
    assert.equal(taskKind("Cold-call the Leeds list"), "call");
    assert.equal(taskKind("Call-back for Raj"), "call");
    assert.equal(taskKind("Telephone Martin"), "call");
    assert.equal(taskKind("Re-send the contract to Jane"), "email");
    assert.equal(taskKind("Send invoice to Ashby"), "email");
    assert.equal(taskKind("Book flights to Leeds"), "todo");
    assert.equal(taskKind("Book Lucy for Tuesday"), "meeting");
    assert.equal(taskKind("Sort demo data for the pilot"), "todo");
    assert.equal(taskKind("Phone bill query"), "todo");
    assert.equal(taskKind("Find Jane's phone number"), "todo");
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

  it("returns the contact's latest phone and email lookups", async () => {
    const person = (await createContact(mark, { companyId: northwind, firstName: "Lena", lastName: "Hart" })).body.contact.id;
    const task = (await createTask(mark, { title: "Call Lena", contactId: person })).body.task;
    assert.deepEqual((await taskContext(mark, task.id)).lookups, {});
    const lookup = (field: string, status: string, at: string) =>
      sql(
        `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, created_by_user_id, created_at)
         values ($1, 'contact', $2, $3, $4, 'enrow', $5, $6)`,
        [mark.workspaceId, person, field, status, mark.userId, at],
      );
    await lookup("phone", "failed", "2026-11-01T09:00:00Z");
    await lookup("phone", "not_found", "2026-11-02T09:00:00Z");
    await lookup("linkedin", "not_found", "2026-11-02T09:00:00Z");
    const context = await taskContext(mark, task.id);
    assert.equal(context.lookups.phone?.status, "not_found");
    assert.equal(context.lookups.email, undefined);
    assert.deepEqual(Object.keys(context.lookups), ["phone"]);
  });

  it("counts cc and leaves out deleted and junk mail", async () => {
    const person = (await createContact(mark, { companyId: northwind, firstName: "Tom", lastName: "Reed", email: "tom@northwind-act.test" })).body.contact.id;
    const task = (await createTask(mark, { title: "Call Tom", contactId: person })).body.task;
    await message(mark, markBox, { thread: "cc", from: "mark@act.test", to: ["someone@else.test"], cc: ["tom@northwind-act.test"], subject: "Copied Tom", at: "2026-11-08T09:00:00Z", sent: true });
    await message(mark, markBox, { thread: "binned", from: "tom@northwind-act.test", to: ["mark@act.test"], subject: "Binned", at: "2026-11-09T09:00:00Z", trash: true });
    const context = await taskContext(mark, task.id);
    assert.equal(context.lastEmail?.subject, "Copied Tom");
  });

  it("shows an admin opening someone else's task only their own mail", async () => {
    const task = (await createTask(mark, { title: "Reply to Jane", contactId: jane, description: mailThreadLine(markBox.sourceId, "renewal", "Renewal terms, v2") })).body.task;
    const context = await taskContext(ava, task.id);
    assert.equal(context.thread, null);
    assert.equal(context.lastEmail, null);
    assert.equal(context.opportunity?.id, renewal);
  });

  it("gives agents the contact's details on the task", async () => {
    const { token } = await createAgent(mark.workspaceId, scopesForRole("owner"), "Act agent");
    const task = (await createTask(mark, { title: "Call Jane", contactId: jane })).body.task;
    const response = await restGetTask(new Request(`http://crm.test/api/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${token}` } }), {
      params: Promise.resolve({ id: task.id }),
    });
    const body = (await response.json()) as { task: Record<string, unknown> };
    assert.equal(body.task.contactJobTitle, "Head of Operations");
    assert.equal(body.task.contactPhone, "07700 900412");
    assert.equal(body.task.contactEmail, "jane@northwind-act.test");
    assert.equal(body.task.companyPhone, null);
  });

  it("finds an older email beyond the 2,000 most recent messages", async () => {
    const person = (await createContact(mark, { companyId: northwind, firstName: "Olive", lastName: "Older", email: "olive@northwind-act.test" })).body.contact.id;
    const task = (await createTask(mark, { title: "Call Olive", contactId: person })).body.task;
    await message(mark, markBox, { thread: "olive", from: "mark@act.test", to: ["olive@northwind-act.test"], subject: "Long ago", at: "2025-01-10T09:00:00Z", sent: true });
    await sql(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, from_email, to_recipients, received_at, sent_at)
       select $1, $2, $3, $4, 'bulk-act-' || g, 'bulk-act', 'Bulk', 'bulk@else.test', '[]'::jsonb, now() - make_interval(mins => g), now() - make_interval(mins => g)
       from generate_series(1, 2100) g`,
      [mark.workspaceId, mark.userId, markBox.sourceId, markBox.inbox],
    );
    try {
      const context = await taskContext(mark, task.id);
      assert.equal(context.lastEmail?.subject, "Long ago");
    } finally {
      await sql("delete from crm.mail_messages where provider_message_id like 'bulk-act-%'");
    }
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
    const linked = await relinkTask(mark, task.id, { contactId: martin }, { operation: "link_task", source: "web" });
    assert.equal(linked.contactId, martin);
    assert.equal(linked.companyId, ashby);
    const events = await audits(task.id, "task.updated");
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "web");
    assert.equal(events[0].operation, "link_task");
    assert.ok(events[0].changes.fields?.includes("contactId"));
  });

  it("raises a link that doesn't fit instead of dropping the others", async () => {
    const task = (await createTask(mark, { title: "Check in", contactId: jane, opportunityId: renewal })).body.task;
    await assert.rejects(() => relinkTask(mark, task.id, { contactId: martin, companyId: ashby }, { operation: "link_task", source: "web" }), /opportunity belongs to a different company/);
    await assert.rejects(() => relinkTask(mark, task.id, { companyId: ashby }, { operation: "link_task", source: "web" }), /different company/);
    const kept = await getTask(mark, task.id);
    assert.deepEqual([kept.contactId, kept.companyId, kept.opportunityId], [jane, northwind, renewal]);
    const unlinked = await relinkTask(mark, task.id, { opportunityId: null }, { operation: "link_task", source: "web" });
    assert.deepEqual([unlinked.contactId, unlinked.companyId, unlinked.opportunityId], [jane, northwind, null]);
    const moved = await relinkTask(mark, task.id, { contactId: martin, companyId: ashby }, { operation: "link_task", source: "web" });
    assert.deepEqual([moved.contactId, moved.companyId], [martin, ashby]);
  });

  it("keeps the person and opportunity when only the company is unlinked", async () => {
    const task = (await createTask(mark, { title: "Check the renewal", contactId: jane, opportunityId: renewal })).body.task;
    const cleared = await relinkTask(mark, task.id, { companyId: null }, { operation: "link_task", source: "web" });
    assert.deepEqual([cleared.contactId, cleared.companyId, cleared.opportunityId], [jane, null, renewal]);
  });

  it("records nothing when the links don't change", async () => {
    const task = (await createTask(mark, { title: "Ring Martin", contactId: martin })).body.task;
    const same = await relinkTask(mark, task.id, { contactId: martin.toUpperCase(), companyId: ashby.toUpperCase() }, { operation: "link_task", source: "web" });
    assert.equal(same.contactId, martin);
    assert.equal((await audits(task.id, "task.updated")).length, 0);
  });

  it("only lets people who can change the task relink it", async () => {
    const task = (await createTask(mark, { title: "Check in with Martin", contactId: martin })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    await assert.rejects(() => relinkTask(priya, task.id, { contactId: jane }, { operation: "link_task", source: "web" }), /Only the assignee/);
    assert.equal((await getTask(mark, task.id)).contactId, martin);
  });
});

function outcome(values: { note?: string; kind?: "call" | "email" | "meeting" | null; next?: { title: string; dueAt: string | null } | null; outcomeId?: string } = {}) {
  return { outcomeId: values.outcomeId ?? randomUUID(), note: values.note ?? "", kind: values.kind ?? null, next: values.next ?? null };
}

async function activitiesFor(taskId: string) {
  return sql<{ id: string; type: string; title: string; contact_id: string | null; opportunity_id: string | null }>(
    "select id, type, title, contact_id, opportunity_id from crm.activities where metadata ->> 'taskId' = $1 order by created_at",
    [taskId],
  );
}

async function tasksTitled(title: string) {
  return (await sql<{ count: number }>("select count(*)::int as count from crm.tasks where title = $1", [title]))[0].count;
}

describe("done with an outcome", () => {
  it("logs the note on the timeline, adds the next task with the same links and completes the task", async () => {
    const task = (await createTask(mark, { title: "Call Jane about the renewal", contactId: jane, opportunityId: renewal })).body.task;
    const result = await completeTaskWithOutcome(
      mark,
      task.id,
      outcome({ note: "Spoke to Jane. Happy with three years if the break is at 12 months.", kind: "call", next: { title: "Send Jane the three-year price", dueAt: "2027-06-01T09:00" } }),
    );
    assert.ok(result.task.completedAt);
    const [activity] = await activitiesFor(task.id);
    assert.equal(result.activityId, activity.id);
    assert.equal(activity.type, "call");
    assert.equal(activity.title, "Spoke to Jane");
    assert.equal(activity.contact_id, jane);
    assert.equal(activity.opportunity_id, renewal);
    assert.equal(result.next?.title, "Send Jane the three-year price");
    assert.deepEqual([result.next?.contactId, result.next?.companyId, result.next?.opportunityId], [jane, northwind, renewal]);
    assert.equal(result.next?.ownerId, mark.userId);
    assert.equal(result.next?.dueAt, "2027-06-01T08:00:00.000Z");
    assert.equal((await audits(task.id, "task.completed")).length, 1);
    const created = await audits(result.next!.id, "task.created");
    assert.equal(created[0].source, "task_outcome");
  });

  it("returns the earlier result for the same outcome, even sent twice at once", async () => {
    const task = (await createTask(mark, { title: "Call Jane back", contactId: jane })).body.task;
    const value = outcome({ note: "Spoke to Jane about dates", kind: "call", next: { title: "Send Jane the dates", dueAt: null } });
    const [first, second] = await Promise.all([completeTaskWithOutcome(mark, task.id, value), completeTaskWithOutcome(mark, task.id, value)]);
    assert.equal(first.activityId, second.activityId);
    assert.equal(first.next?.id, second.next?.id);
    assert.ok(first.replayed !== second.replayed);
    const retry = await completeTaskWithOutcome(mark, task.id, value);
    assert.equal(retry.activityId, first.activityId);
    assert.equal(retry.replayed, true);
    assert.equal((await activitiesFor(task.id)).length, 1);
    assert.equal(await tasksTitled("Send Jane the dates"), 1);
  });

  it("refuses a second outcome for the same completion, from anyone, with or without a note, whatever the links now are", async () => {
    const task = (await createTask(mark, { title: "Call Martin about the pilot", contactId: martin })).body.task;
    await completeTaskWithOutcome(mark, task.id, outcome({ next: { title: "Chase Martin for the PO", dueAt: null } }));
    await assert.rejects(() => completeTaskWithOutcome(ava, task.id, outcome({ next: { title: "Chase Martin for the PO", dueAt: null } })), /already saved/);
    assert.equal(await tasksTitled("Chase Martin for the PO"), 1);
    await relinkTask(mark, task.id, { contactId: jane, companyId: northwind }, { operation: "link_task", source: "web" });
    await assert.rejects(() => completeTaskWithOutcome(ava, task.id, outcome({ note: "Martin said yes", kind: "call" })), /already saved/);
    await assert.rejects(() => completeTaskWithOutcome(mark, task.id, outcome({ note: "Different words" })), /already saved/);
    assert.equal((await activitiesFor(task.id)).length, 0);
  });

  it("lets a reopened task take a new outcome when it is done again, and never replays an old one as done", async () => {
    const task = (await createTask(mark, { title: "Call Jane about the board pack", contactId: jane })).body.task;
    const first = outcome({ note: "Sent the board pack", kind: "call" });
    await completeTaskWithOutcome(mark, task.id, first);
    await reopenTask(mark, task.id);
    const stale = await completeTaskWithOutcome(mark, task.id, first);
    assert.equal(stale.replayed, true);
    assert.equal(stale.task.completedAt, null);
    assert.equal((await getTask(mark, task.id)).completedAt, null);
    const again = await completeTaskWithOutcome(mark, task.id, outcome({ note: "Sent the board pack", kind: "call" }));
    assert.equal(again.replayed, false);
    assert.ok(again.task.completedAt);
    assert.equal((await activitiesFor(task.id)).length, 2);
  });

  it("adds the outcome to a task that is already done without completing it again", async () => {
    const task = (await createTask(mark, { title: "Call Martin about the invoice", contactId: martin, completed: true })).body.task;
    const result = await completeTaskWithOutcome(mark, task.id, outcome({ note: "Paid now", kind: "call" }));
    assert.ok(result.activityId);
    assert.equal(result.task.completedAt, task.completedAt);
    assert.equal((await audits(task.id, "task.completed")).length, 0);
  });

  it("gives the next task to whoever saves it when the assignee has left", async () => {
    const leaver = await join(await createUser("leaver@act.test", "Lee Leaver"), "member");
    const task = (await createTask(mark, { title: "Call Jane about pricing", contactId: jane, ownerId: leaver.userId })).body.task;
    await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, leaver.userId]);
    const result = await completeTaskWithOutcome(mark, task.id, outcome({ next: { title: "Send Jane pricing", dueAt: null } }));
    assert.equal(result.next?.ownerId, mark.userId);
  });

  it("keeps a done task's completion time, so a second outcome window never opens", async () => {
    const task = (await createTask(mark, { title: "Call Jane about the lease", contactId: jane })).body.task;
    const saved = await completeTaskWithOutcome(mark, task.id, outcome({ note: "Lease agreed", kind: "call" }));
    const restored = await withActor(mark, (db) => restoreTaskInDb(db, mark, task.id, {}, "2020-01-01T00:00:00.000Z", { operation: "undo", source: "web" }));
    assert.equal(restored.task.completedAt, saved.task.completedAt);
    await assert.rejects(() => completeTaskWithOutcome(mark, task.id, outcome({ note: "Again" })), /already saved/);
  });

  it("only lets people who can change the task record an outcome directly", async () => {
    const task = (await createTask(mark, { title: "Call Martin about the van", contactId: martin, completed: true })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    await assert.rejects(() =>
      queryAsUser(priya.userId, "insert into crm.task_outcomes (id, task_id, completed_at, created_by) values ($1, $2, now(), $3)", [randomUUID(), task.id, priya.userId]),
    );
    await queryAsUser(ava.userId, "insert into crm.task_outcomes (id, task_id, completed_at, created_by) values ($1, $2, now(), $3)", [randomUUID(), task.id, ava.userId]);
  });

  it("just completes when nothing is entered", async () => {
    const task = (await createTask(mark, { title: "Email Jane", contactId: jane })).body.task;
    const first = await completeTaskWithOutcome(mark, task.id, outcome({ note: "  " }));
    assert.ok(first.task.completedAt);
    assert.equal(first.activityId, null);
    assert.equal(first.next, null);
    assert.equal((await audits(task.id, "task.completed")).length, 1);
  });

  it("refuses people who can't change the task and leaves nothing behind", async () => {
    const task = (await createTask(mark, { title: "Call Martin", contactId: martin })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    await assert.rejects(() => completeTaskWithOutcome(priya, task.id, outcome({ note: "Spoke to Martin", kind: "call", next: { title: "Chase Martin", dueAt: null } })), /Only the assignee/);
    assert.equal((await activitiesFor(task.id)).length, 0);
    assert.equal((await getTask(mark, task.id)).completedAt, null);
    assert.equal(await tasksTitled("Chase Martin"), 0);
  });

  it("lets the assignee who didn't create it complete with an outcome", async () => {
    const task = (await createTask(mark, { title: "Call Martin back", contactId: martin, ownerId: sam.userId })).body.task;
    const result = await completeTaskWithOutcome(sam, task.id, outcome({ note: "Left a voicemail", kind: "call" }));
    assert.ok(result.task.completedAt);
    assert.equal((await activitiesFor(task.id))[0]?.title, "Left a voicemail");
  });

  it("asks for a link before logging a note on an unlinked task, and needs an outcome id", async () => {
    const task = (await createTask(mark, { title: "Tidy the shared drive", companyId: null, contactId: null, opportunityId: null })).body.task;
    await assert.rejects(() => completeTaskWithOutcome(mark, task.id, outcome({ note: "Done it" })), /Link a person or company first/);
    await assert.rejects(() => completeTaskWithOutcome(mark, task.id, { ...outcome(), outcomeId: "nope" }), /Couldn't save/);
    assert.equal((await getTask(mark, task.id)).completedAt, null);
  });
});
