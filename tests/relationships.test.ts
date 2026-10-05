import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { POST as leadRoute } from "@/app/api/v1/leads/route";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { getPool } from "@/lib/db/pool";
import { createCompany } from "@/lib/crm/companies";
import { createContact, getContact, updateContact, upsertContact } from "@/lib/crm/contacts";
import { createActivity, listActivities } from "@/lib/crm/activities";
import { CrmError } from "@/lib/crm/errors";
import { ingestLead } from "@/lib/crm/leads";
import { createOpportunity, updateOpportunity } from "@/lib/crm/opportunities";
import { findStaleRelationships, getCompanyContext, getDueActions } from "@/lib/crm/relationships";
import { completeTask, createTask } from "@/lib/crm/tasks";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("contacts, opportunities, and next actions", () => {
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

  it("defaults an opportunity stage and completes a next action", async () => {
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
