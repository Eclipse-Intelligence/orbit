import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { POST as leadRoute } from "@/app/api/v1/leads/route";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { getPool } from "@/lib/db/pool";
import { connectionStrength } from "@/lib/companies";
import { createCompany, listCompanies } from "@/lib/crm/companies";
import {
  createContact,
  findContactsToLink,
  getContact,
  listContacts,
  updateContact,
  upsertContact,
} from "@/lib/crm/contacts";
import {
  createActivity,
  listActivities,
  listCompanyTimeline,
  logActivity,
} from "@/lib/crm/activities";
import { CrmError } from "@/lib/crm/errors";
import { ingestLead } from "@/lib/crm/leads";
import { createOpportunity, updateOpportunity } from "@/lib/crm/opportunities";
import { findStaleRelationships, getCompanyContext, getDueActions } from "@/lib/crm/relationships";
import { archiveTask, completeTask, createTask, getTask } from "@/lib/crm/tasks";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("contacts, opportunities, and tasks", () => {
  it("dedupes contacts, keeps omitted fields, and rejects another workspace", async () => {
    const owner = await createUser("people@example.com", "People Owner");
    const other = await createUser("people-other@example.com", "Other");
    const company = await createCompany(owner, { name: "People Co", domain: "people.example" });
    const created = await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "Ada@People.example",
      phone: "+1 555 0100",
    });
    assert.equal(created.body.contact.email, "ada@people.example");
    assert.equal(created.body.contact.companyName, "People Co");

    const patched = await updateContact(owner, created.body.contact.id, { jobTitle: "Founder" });
    assert.equal(patched.body.contact.jobTitle, "Founder");
    assert.equal(patched.body.contact.phone, "+1 555 0100");
    assert.equal(patched.body.contact.lastName, "Lovelace");

    const again = await upsertContact(owner, {
      email: "ada@people.example",
      source: "conference",
    });
    assert.equal(again.body.created, false);
    assert.equal(again.body.matchedOn, "email");
    assert.equal(again.body.contact.id, created.body.contact.id);
    assert.equal(again.body.contact.jobTitle, "Founder");
    assert.equal(again.body.contact.source, "conference");

    const named = await upsertContact(owner, {
      companyId: company.body.company.id,
      firstName: "Grace",
      lastName: "Hopper",
    });
    const namedAgain = await upsertContact(owner, {
      companyId: company.body.company.id,
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@people.example",
    });
    assert.equal(namedAgain.body.created, false);
    assert.equal(namedAgain.body.matchedOn, "name");
    assert.equal(namedAgain.body.contact.id, named.body.contact.id);

    await assert.rejects(
      () => getContact(other, created.body.contact.id),
      (error: unknown) => error instanceof CrmError && error.code === "not_found",
    );

    const foreign = await createCompany(other, { name: "Other Co", domain: "other-people.example" });
    await assert.rejects(
      () =>
        queryAsUser(
          owner.userId,
          "insert into crm.contacts (workspace_id, company_id, first_name) values ($1, $2, $3)",
          [owner.workspaceId, foreign.body.company.id, "Pat"],
        ),
      (error: unknown) => error instanceof Error && /another workspace/i.test(error.message),
    );
  });

  it("defaults an opportunity stage and completes a task", async () => {
    const owner = await createUser("deals@example.com", "Deals");
    const company = await createCompany(owner, { name: "Deal Co", domain: "deal.example" });
    const created = await createOpportunity(owner, {
      companyId: company.body.company.id,
      name: "First deal",
      value: 1200,
    });
    assert.equal(created.body.opportunity.stageName, "New");
    assert.equal(created.body.opportunity.status, "open");
    assert.equal(created.body.opportunity.value, "1200.00");
    assert.equal(created.body.opportunity.currency, "USD");

    const won = await updateOpportunity(owner, created.body.opportunity.id, { status: "won" });
    assert.equal(won.body.opportunity.status, "won");
    assert.equal(won.body.opportunity.stageName, "Won");
    assert.equal(won.body.opportunity.value, "1200.00");

    const kept = await updateOpportunity(owner, created.body.opportunity.id, { source: "inbound" });
    assert.equal(kept.body.opportunity.source, "inbound");
    assert.equal(kept.body.opportunity.stageName, "Won");

    const task = await createTask(owner, {
      title: "Send contract",
      companyId: company.body.company.id,
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(task.body.task.completedAt, null);
    const done = await completeTask(owner, task.body.task.id);
    assert.ok(done.body.task.completedAt);
    const again = await completeTask(owner, task.body.task.id);
    assert.equal(again.body.task.completedAt, done.body.task.completedAt);

    const overdue = await getDueActions(owner, "overdue");
    assert.equal(overdue.tasks.length, 0);
    const completed = await getDueActions(owner, "completed");
    assert.equal(completed.tasks.some((item) => item.id === task.body.task.id), true);
  });

  it("keeps existing tasks and opportunities editable after a contact changes company", async () => {
    const owner = await createUser("moves@example.com", "Moves");
    const first = await createCompany(owner, { name: "First Move", domain: "first-move.example" });
    const second = await createCompany(owner, { name: "Second Move", domain: "second-move.example" });
    const contact = await createContact(owner, {
      companyId: first.body.company.id,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@first-move.example",
    });
    const deal = await createOpportunity(owner, {
      companyId: first.body.company.id,
      primaryContactId: contact.body.contact.id,
      name: "Move deal",
    });
    const call = await createTask(owner, {
      title: "Call Jane",
      companyId: first.body.company.id,
      contactId: contact.body.contact.id,
    });
    const email = await createTask(owner, {
      title: "Email Jane",
      companyId: first.body.company.id,
      contactId: contact.body.contact.id,
    });

    await updateContact(owner, contact.body.contact.id, { companyId: second.body.company.id });

    const done = await completeTask(owner, call.body.task.id);
    assert.ok(done.body.task.completedAt);
    const archived = await archiveTask(owner, email.body.task.id);
    assert.ok(archived.body.task.archivedAt);
    const moved = await updateOpportunity(owner, deal.body.opportunity.id, { status: "won" });
    assert.equal(moved.body.opportunity.stageName, "Won");

    await assert.rejects(
      () => createTask(owner, {
        title: "Wrong company",
        companyId: first.body.company.id,
        contactId: contact.body.contact.id,
      }),
      (error: unknown) => error instanceof CrmError && error.code === "invalid_input",
    );

    const found = await listContacts(owner, { query: "Jane Doe" });
    assert.equal(found.data.some((item) => item.id === contact.body.contact.id), true);

    const unchanged = await upsertContact(owner, {
      email: "jane@first-move.example",
      firstName: "Jane",
      lastName: "Doe",
    });
    assert.equal(unchanged.body.changed, false);

    const lead = await ingestLead(owner, {
      contact: { email: "jane@first-move.example", jobTitle: "CTO" },
    });
    assert.equal(lead.body.contact?.id, contact.body.contact.id);
    assert.equal(lead.body.contact?.jobTitle, "CTO");
    assert.equal(lead.body.contact?.companyId, second.body.company.id);
  });

  it("links, moves, and unlinks contacts from a company without deleting them", async () => {
    const owner = await createUser("link-people@example.com", "Linker");
    const other = await createUser("link-other@example.com", "Other");
    const home = await createCompany(owner, { name: "Link Home", domain: "link-home.example" });
    const away = await createCompany(owner, { name: "Link Away", domain: "link-away.example" });
    const homeId = home.body.company.id;
    const resident = await createContact(owner, {
      companyId: homeId,
      firstName: "Rita",
      lastName: "Resident",
      email: "rita@link-home.example",
    });
    const visitor = await createContact(owner, {
      companyId: away.body.company.id,
      firstName: "Vic",
      lastName: "Visitor",
      email: "vic@link-away.example",
      phone: "07700 900123",
    });
    const loose = await createContact(owner, { firstName: "Lou", lastName: "Loose" });
    await createContact(other, { firstName: "Vic", lastName: "Stranger" });

    const all = await findContactsToLink(owner, homeId);
    const ids = all.map((item) => item.id);
    assert.equal(ids.includes(resident.body.contact.id), false);
    assert.equal(ids.includes(visitor.body.contact.id), true);
    assert.equal(ids.includes(loose.body.contact.id), true);
    assert.equal(all.length, 2);

    const byName = await findContactsToLink(owner, homeId, "vic vis");
    assert.deepEqual(byName.map((item) => item.id), [visitor.body.contact.id]);
    assert.equal(byName[0].companyName, "Link Away");
    const byEmail = await findContactsToLink(owner, homeId, "VIC@link-away");
    assert.deepEqual(byEmail.map((item) => item.id), [visitor.body.contact.id]);
    assert.deepEqual(await findContactsToLink(owner, homeId, "rita"), []);

    const task = await createTask(owner, {
      title: "Call Vic",
      companyId: away.body.company.id,
      contactId: visitor.body.contact.id,
    });
    const deal = await createOpportunity(owner, {
      companyId: away.body.company.id,
      primaryContactId: visitor.body.contact.id,
      name: "Vic deal",
    });

    const moved = await updateContact(owner, visitor.body.contact.id, { companyId: homeId });
    assert.equal(moved.body.contact.companyName, "Link Home");
    const context = await getCompanyContext(owner, homeId);
    assert.deepEqual(
      context.contacts.map((item) => item.id).sort(),
      [resident.body.contact.id, visitor.body.contact.id].sort(),
    );
    assert.equal(
      (await findContactsToLink(owner, homeId)).some((item) => item.id === visitor.body.contact.id),
      false,
    );

    const unlinked = await updateContact(owner, visitor.body.contact.id, { companyId: null });
    assert.equal(unlinked.body.contact.companyId, null);
    assert.equal(unlinked.body.contact.phone, "07700 900123");
    const kept = await getContact(owner, visitor.body.contact.id);
    assert.equal(kept.archivedAt, null);
    assert.equal((await getCompanyContext(owner, homeId)).contacts.length, 1);
    const keptTask = await getTask(owner, task.body.task.id);
    assert.equal(keptTask.contactId, visitor.body.contact.id);
    assert.equal(keptTask.companyId, away.body.company.id);
    const won = await updateOpportunity(owner, deal.body.opportunity.id, { status: "won" });
    assert.equal(won.body.opportunity.primaryContactId, visitor.body.contact.id);

    const created = await createContact(owner, {
      companyId: homeId,
      firstName: "Nia",
      lastName: "New",
      phone: "+44 20 7946 0000",
      jobTitle: "Buyer",
    });
    assert.equal(created.body.contact.companyName, "Link Home");

    await assert.rejects(
      () => updateContact(other, resident.body.contact.id, { companyId: null }),
      (error: unknown) => error instanceof CrmError && error.code === "not_found",
    );
    const theirs = await createCompany(other, { name: "Theirs", domain: "theirs-link.example" });
    await assert.rejects(
      () => updateContact(owner, loose.body.contact.id, { companyId: theirs.body.company.id }),
      (error: unknown) => error instanceof CrmError,
    );
    const foreign = await findContactsToLink(other, homeId, "vic");
    assert.deepEqual(foreign.map((item) => item.lastName), ["Stranger"]);
  });

  it("merges company and contact activity into one company timeline", async () => {
    const owner = await createUser("timeline@example.com", "Timeline");
    const other = await createUser("timeline-other@example.com", "Other");
    const home = await createCompany(owner, { name: "Time Home", domain: "time-home.example" });
    const away = await createCompany(owner, { name: "Time Away", domain: "time-away.example" });
    const homeId = home.body.company.id;
    const awayId = away.body.company.id;
    const resident = await createContact(owner, {
      companyId: homeId,
      firstName: "Rae",
      lastName: "Resident",
      email: "rae@time-home.example",
    });
    const mover = await createContact(owner, {
      companyId: awayId,
      firstName: "Mo",
      lastName: "Mover",
    });
    const before = await createActivity(owner, {
      type: "call",
      title: "Call before joining",
      contactId: mover.body.contact.id,
      occurredAt: "2026-01-01T09:00:00.000Z",
    });
    assert.equal(before.body.activity.companyId, awayId);
    const elsewhere = await createActivity(owner, {
      type: "note",
      body: "Only about Away",
      companyId: awayId,
    });
    await updateContact(owner, mover.body.contact.id, { companyId: homeId });

    const companyCall = await logActivity(owner, { companyId: homeId }, "call", "Quarterly check-in", "");
    assert.equal(companyCall.type, "call");
    assert.equal(companyCall.companyId, homeId);
    assert.equal(companyCall.contactId, null);
    assert.equal(companyCall.metadata.source, "web");
    const companyNote = await logActivity(owner, { companyId: homeId, contactId: null }, "note", "", "Board approved");
    assert.equal(companyNote.contactId, null);
    assert.equal(companyNote.companyId, homeId);
    const residentNote = await logActivity(
      owner,
      { companyId: homeId, contactId: resident.body.contact.id },
      "note",
      "",
      "Rae is the buyer",
    );
    assert.equal(residentNote.contactId, resident.body.contact.id);
    assert.equal(residentNote.companyId, homeId);

    await assert.rejects(
      () => logActivity(owner, { companyId: homeId }, "note", "", "  "),
      (error: unknown) => error instanceof CrmError && error.code === "invalid_input",
    );
    await assert.rejects(
      () => logActivity(owner, {}, "call", "No target", ""),
      (error: unknown) => error instanceof CrmError && error.code === "invalid_input",
    );
    const stranger = await createContact(owner, { companyId: awayId, firstName: "Sam" });
    await assert.rejects(
      () => logActivity(owner, { companyId: homeId, contactId: stranger.body.contact.id }, "note", "", "Wrong"),
      (error: unknown) => error instanceof CrmError && error.code === "invalid_input",
    );
    await assert.rejects(
      () => logActivity(other, { companyId: homeId }, "note", "", "Not mine"),
      (error: unknown) => error instanceof CrmError && error.code === "not_found",
    );

    const theirs = await createCompany(other, { name: "Time Theirs", domain: "time-theirs.example" });
    const theirNote = await logActivity(other, { companyId: theirs.body.company.id }, "note", "", "Theirs");

    const context = await getCompanyContext(owner, homeId);
    const ids = context.timeline.map((item) => item.id);
    assert.deepEqual(new Set(ids), new Set([
      companyCall.id,
      companyNote.id,
      residentNote.id,
      before.body.activity.id,
    ]));
    assert.equal(ids.includes(elsewhere.body.activity.id), false);
    assert.equal(ids.includes(theirNote.id), false);
    assert.equal(ids.at(-1), before.body.activity.id);
    const times = context.timeline.map((item) => Date.parse(item.occurredAt));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    const old = context.timeline.find((item) => item.id === before.body.activity.id);
    assert.equal(old?.contactName, "Mo Mover");
    assert.equal(old?.companyId, awayId);
    assert.equal(context.activities.some((item) => item.id === before.body.activity.id), false);

    assert.deepEqual(await listCompanyTimeline(other, homeId), []);
    assert.deepEqual(await listCompanyTimeline(owner, "not-a-uuid"), []);
    assert.deepEqual(
      (await listCompanyTimeline(other, theirs.body.company.id)).map((item) => item.id),
      [theirNote.id],
    );
    await assert.rejects(
      () => getCompanyContext(other, homeId),
      (error: unknown) => error instanceof CrmError && error.code === "not_found",
    );

    await updateContact(owner, mover.body.contact.id, { companyId: null });
    const after = await listCompanyTimeline(owner, homeId);
    assert.equal(after.some((item) => item.id === before.body.activity.id), false);
    assert.equal(after.some((item) => item.id === companyCall.id), true);
  });

  it("ingests a lead once per company and contact, including context and stale relationships", async () => {
    const owner = await createUser("leads@example.com", "Leads");
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const leadInput = {
      company: { name: "Lead Co", domain: "lead.example", industry: "Research" },
      contact: { firstName: "Lin", lastName: "Ada", email: "lin@lead.example", jobTitle: "CEO" },
      note: "Met at a conference",
      opportunity: { name: "Pilot", value: "5000" },
      task: { title: "Book a follow-up", dueAt },
    };
    const leadOptions = {
      idempotencyKey: "lead-1",
      provenance: { operation: "ingest_lead", source: "test" },
    };
    const first = await ingestLead(owner, leadInput, leadOptions);
    assert.equal(first.body.companyCreated, true);
    assert.equal(first.body.contactCreated, true);
    assert.equal(first.body.company?.domain, "lead.example");
    assert.equal(first.body.opportunity?.stageName, "New");
    assert.equal(first.body.activity?.type, "research");
    assert.equal(first.body.task?.companyId, first.body.company?.id);

    const replay = await ingestLead(owner, leadInput, leadOptions);
    assert.equal(replay.replayed, true);
    assert.equal(replay.body.company?.id, first.body.company?.id);

    const second = await ingestLead(owner, {
      company: { domain: "lead.example", description: "Keeps the name" },
      contact: { email: "lin@lead.example", phone: "+44 20 7946 0000" },
      note: "Sent the deck",
    });
    assert.equal(second.body.companyCreated, false);
    assert.equal(second.body.contactCreated, false);
    assert.equal(second.body.company?.id, first.body.company?.id);
    assert.equal(second.body.company?.name, "Lead Co");
    assert.equal(second.body.company?.industry, "Research");
    assert.equal(second.body.company?.description, "Keeps the name");
    assert.equal(second.body.contact?.id, first.body.contact?.id);
    assert.equal(second.body.contact?.jobTitle, "CEO");
    assert.equal(second.body.contact?.phone, "+44 20 7946 0000");

    const activities = await listActivities(owner, { companyId: first.body.company?.id });
    assert.equal(activities.total, 2);

    const context = await getCompanyContext(owner, first.body.company!.id);
    assert.equal(context.contacts.length, 1);
    assert.equal(context.opportunities.length, 1);
    assert.equal(context.activities[0]?.body, "Sent the deck");
    assert.equal(context.openTaskCount, 1);
    assert.equal(context.lastInteraction?.body, "Sent the deck");

    const quiet = await createCompany(owner, { name: "Quiet Co", domain: "quiet.example" });
    await createActivity(owner, {
      type: "note",
      body: "Old note",
      companyId: quiet.body.company.id,
      occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    });
    const listed = await listCompanies(owner, { query: "Quiet" });
    assert.equal(listed.data[0]?.openTaskCount, 0);
    assert.equal(connectionStrength(listed.data[0]?.lastInteractionAt), "weak");

    const stale = await findStaleRelationships(owner, 21);
    assert.equal(stale.some((item) => item.company.id === quiet.body.company.id), true);
    assert.equal(stale.some((item) => item.company.id === first.body.company?.id), false);

    const missing = await getDueActions(owner, "none");
    assert.equal(missing.companies.some((company) => company.id === quiet.body.company.id), true);
    assert.equal(missing.companies.some((company) => company.id === first.body.company?.id), false);
  });
});

describe("lead API and MCP", () => {
  it("requires lead scope and ingests through HTTP and MCP", async () => {
    const owner = await createUser("lead-api@example.com");
    const limited = await createAgent(owner.workspaceId, ["crm:read", "companies:write"]);
    const denied = await leadRoute(
      new Request("http://crm.test/api/v1/leads", {
        method: "POST",
        headers: {
          authorization: `Bearer ${limited.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ company: { name: "Nope", domain: "nope.example" } }),
      }),
    );
    assert.equal(denied.status, 403);

    const writer = await createAgent(owner.workspaceId, [
      "crm:read",
      "companies:write",
      "contacts:write",
      "leads:write",
      "activities:write",
      "opportunities:write",
      "tasks:write",
    ]);
    const created = await leadRoute(
      new Request("http://crm.test/api/v1/leads", {
        method: "POST",
        headers: {
          authorization: `Bearer ${writer.token}`,
          "content-type": "application/json",
          "idempotency-key": "http-lead-1",
        },
        body: JSON.stringify({
          company: { name: "Http Lead", domain: "http-lead.example" },
          contact: { email: "a@http-lead.example", firstName: "Avery" },
          note: "Inbound",
        }),
      }),
    );
    assert.equal(created.status, 200);
    const body = (await created.json()) as { company: { id: string }; contact: { email: string } };
    assert.equal(body.contact.email, "a@http-lead.example");

    const response = await mcpRoute(
      new Request("http://crm.test/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${writer.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "add_lead",
            arguments: {
              domain: "http-lead.example",
              contactEmail: "a@http-lead.example",
              note: "MCP note",
            },
          },
        }),
      }),
    );
    const payload = (await response.json()) as {
      result?: { content?: { text: string }[]; isError?: boolean };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.result?.isError, undefined);
    assert.match(payload.result?.content?.[0]?.text ?? "", /http-lead.example/);
    assert.match(payload.result?.content?.[0]?.text ?? "", /"companyCreated": false/);
  });
});
