import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import { backfillCallHealth } from "@/lib/crm/call-health";
import { getInsightsForActivities, summariseCall } from "@/lib/crm/call-insights";
import { createCompany, getCompany, listCompanies, updateCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity } from "@/lib/crm/opportunities";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

const TRANSCRIPT = "Mark: How is it going?\nJane: Honestly we are thinking about not renewing.";

function gateway(replies: Record<string, unknown>[]) {
  const prompts: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
    prompts.push(body.messages[0].content);
    const reply = replies[Math.min(prompts.length - 1, replies.length - 1)];
    return Response.json({
      model: "claude-haiku-5-5",
      choices: [{ message: { role: "assistant", content: JSON.stringify(reply) }, finish_reason: "stop" }],
    });
  };
  return { fetchImpl, prompts };
}

function summary(health: string | null, healthReason: string | null) {
  return { summary: "Jane talked about the renewal.", keyPoints: [], actionItems: [], health, healthReason };
}

describe("account health", () => {
  let owner: UserActor;
  let acme: string;
  let jane: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("health@orbit.test", "Mark Ridgeon");
    acme = (await createCompany(owner, { name: "Acme Health", domain: "acme-health.test" })).body.company.id;
    jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", companyId: acme })).body.contact.id;
  });

  beforeEach(() => {
    process.env.LLM_API_KEY = "test-llm-key";
  });

  after(async () => {
    await getPool().end();
  });

  async function call(daysAgo: number, link: { companyId?: string; contactId?: string }) {
    const occurredAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    return (await createActivity(owner, { type: "call", title: `Call ${daysAgo}`, occurredAt, ...link })).body.activity.id;
  }

  it("sets the company's health from each call summary, and an older call never overrides a newer one", async () => {
    const recent = await call(1, { contactId: jane });
    const risky = gateway([summary("at_risk", "Jane said they are thinking about not renewing.")]);
    const insight = await summariseCall(owner, recent, TRANSCRIPT, { fetchImpl: risky.fetchImpl, autoAccept: false });
    assert.equal(insight.sentiment, "at_risk");
    assert.equal(insight.sentimentReason, "Jane said they are thinking about not renewing.");
    assert.match(risky.prompts[0], /"health": "healthy" \| "watch" \| "at_risk" \| null/);

    let company = await getCompany(owner, acme);
    assert.equal(company.health, "at_risk");
    assert.equal(company.healthReason, "Jane said they are thinking about not renewing.");
    assert.equal(company.healthActivityId, recent);

    const older = await call(5, { companyId: acme });
    await summariseCall(owner, older, TRANSCRIPT, { fetchImpl: gateway([summary("healthy", "All fine.")]).fetchImpl, autoAccept: false });
    company = await getCompany(owner, acme);
    assert.equal(company.health, "at_risk");
    assert.equal((await getInsightsForActivities(owner, [older]))[older].sentiment, "healthy");

    const audit = await getAdminPool().query<{ changes: { fields: string[]; after: { health: string } }; operation: string }>(
      "select changes, operation from crm.audit_events where entity_id = $1 and event_type = 'company.updated' order by created_at",
      [acme],
    );
    assert.deepEqual(audit.rows.map((row) => [row.operation, row.changes.after.health]), [["call_health", "at_risk"]]);
  });

  it("lets a person set health by hand, filters by it and shows it on cards", async () => {
    const updated = await updateCompany(owner, acme, { health: "watch", healthReason: "Spoke to finance, renewal still open." });
    assert.equal(updated.body.company.health, "watch");
    assert.equal(updated.body.company.healthActivityId, null);
    assert.ok(updated.body.company.healthAt);

    const other = (await createCompany(owner, { name: "Quiet Co", domain: "quiet-health.test" })).body.company.id;
    assert.deepEqual((await listCompanies(owner, { health: "watch" })).data.map((item) => item.id), [acme]);
    assert.deepEqual((await listCompanies(owner, { health: "none" })).data.map((item) => item.id), [other]);
    await assert.rejects(updateCompany(owner, acme, { health: "great" as "watch" }), /Health is healthy, watch or at_risk/);

    const deal = await createOpportunity(owner, { companyId: acme, name: "Renewal" });
    assert.equal(deal.body.opportunity.companyHealth, "watch");

    const before = await call(2, { companyId: acme });
    await summariseCall(owner, before, TRANSCRIPT, { fetchImpl: gateway([summary("healthy", "Happy.")]).fetchImpl, autoAccept: false });
    assert.equal((await getCompany(owner, acme)).health, "watch");
  });

  it("checks calls summarised before health existed, once each", async () => {
    const quiet = (await createCompany(owner, { name: "Backfill Co", domain: "backfill-health.test" })).body.company.id;
    const activity = await call(0, { companyId: quiet });
    await summariseCall(owner, activity, TRANSCRIPT, { fetchImpl: gateway([summary(null, null)]).fetchImpl, autoAccept: false });
    await getAdminPool().query("update crm.call_insights set sentiment_checked_at = null where activity_id = $1", [activity]);

    const judge = gateway([{ health: "watch", healthReason: "Renewal is uncertain." }]);
    assert.deepEqual(await backfillCallHealth({ limit: 5, fetchImpl: judge.fetchImpl }), { judged: 1, failed: 0 });
    assert.match(judge.prompts[0], /You judge how a client relationship stands/);
    const company = await getCompany(owner, quiet);
    assert.equal(company.health, "watch");
    assert.equal(company.healthActivityId, activity);
    assert.deepEqual(await backfillCallHealth({ limit: 5, fetchImpl: judge.fetchImpl }), { judged: 0, failed: 0 });
  });
});
