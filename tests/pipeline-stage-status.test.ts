import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createCompany, getCompany } from "@/lib/crm/companies";
import {
  archiveOpportunity,
  createOpportunity,
  getOpportunity,
  listPipeline,
  STAGE_STATUS_CHANGE_LIMIT,
} from "@/lib/crm/opportunities";
import { savePipelineStages } from "@/lib/crm/pipeline";
import { createUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("changing which stage is won or lost", () => {
  it("records each deal whose status changes and makes its company a customer", async () => {
    const owner = await createUser("stage-flags@example.com", "Flags");
    const company = await createCompany(owner, { name: "Flag Co", domain: "flag-co.example", lifecycle: "prospect" });
    const parkedCompany = await createCompany(owner, { name: "Parked Co", domain: "parked-co.example", lifecycle: "prospect" });
    const current = await listPipeline(owner);
    const proposal = current.stages.find((stage) => stage.name === "Proposal")!;
    const oldWon = current.stages.find((stage) => stage.isWon)!;
    const live = await createOpportunity(owner, { companyId: company.body.company.id, name: "Live", stageId: proposal.id });
    const parked = await createOpportunity(owner, { companyId: parkedCompany.body.company.id, name: "Parked", stageId: proposal.id });
    await archiveOpportunity(owner, parked.body.opportunity.id);
    const closedCompany = await createCompany(owner, { name: "Closed Co", domain: "closed-co.example" });
    const closed = await createOpportunity(owner, { companyId: closedCompany.body.company.id, name: "Closed", stageId: oldWon.id });
    const admin = getAdminPool();
    const since = (await admin.query<{ now: Date }>("select now()")).rows[0].now;

    await savePipelineStages(
      owner,
      current.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        probability: stage.probability,
        isWon: stage.id === proposal.id,
        isLost: stage.isLost,
      })),
    );

    assert.equal((await getOpportunity(owner, live.body.opportunity.id)).status, "won");
    assert.equal((await getOpportunity(owner, parked.body.opportunity.id)).status, "won");
    assert.equal((await getOpportunity(owner, closed.body.opportunity.id)).status, "open");
    assert.equal((await getCompany(owner, company.body.company.id)).lifecycle, "customer");
    assert.equal((await getCompany(owner, parkedCompany.body.company.id)).lifecycle, "prospect");
    assert.equal((await getCompany(owner, company.body.company.id)).lifecycle, "customer");

    const events = await admin.query<{ entity_id: string; operation: string; before: string; after: string }>(
      `select entity_id, operation, changes->'before'->>'status' as before, changes->'after'->>'status' as after
       from crm.audit_events
       where workspace_id = $1 and event_type = 'opportunity.stage_changed' and created_at >= $2`,
      [owner.workspaceId, since],
    );
    const byDeal = new Map(events.rows.map((row) => [row.entity_id, row]));
    assert.deepEqual(
      { before: byDeal.get(live.body.opportunity.id)?.before, after: byDeal.get(live.body.opportunity.id)?.after },
      { before: "open", after: "won" },
    );
    assert.equal(byDeal.get(closed.body.opportunity.id)?.after, "open");
    assert.equal(byDeal.get(parked.body.opportunity.id)?.after, "won");
    assert.equal(events.rows[0].operation, "save_pipeline_stages");

    const triggers = await admin.query<{ entity_id: string }>(
      `select entity_id from crm.workflow_events
       where workspace_id = $1 and event_type = 'opportunity.stage_changed' and created_at >= $2`,
      [owner.workspaceId, since],
    );
    assert.ok(triggers.rows.some((row) => row.entity_id === live.body.opportunity.id));

    const lifecycle = await admin.query(
      `select 1 from crm.audit_events
       where workspace_id = $1 and event_type = 'company.updated' and entity_id = $2 and created_at >= $3`,
      [owner.workspaceId, company.body.company.id, since],
    );
    assert.equal(lifecycle.rowCount, 1);
  });

  it("queues a webhook delivery for each deal whose status changes", async () => {
    const owner = await createUser("stage-flags-hooks@example.com", "Hooks");
    const company = await createCompany(owner, { name: "Hook Co", domain: "hook-co.example" });
    const current = await listPipeline(owner);
    const proposal = current.stages.find((stage) => stage.name === "Proposal")!;
    const deal = await createOpportunity(owner, { companyId: company.body.company.id, name: "Hooked", stageId: proposal.id });
    const admin = getAdminPool();
    const endpoint = await admin.query<{ id: string }>(
      `insert into crm.webhook_endpoints (workspace_id, url, events, secret)
       values ($1, 'https://hooks.example/orbit', array['opportunity.stage_changed'], 'sealed')
       returning id`,
      [owner.workspaceId],
    );
    await savePipelineStages(
      owner,
      current.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        probability: stage.probability,
        isWon: stage.id === proposal.id,
        isLost: stage.isLost,
      })),
    );
    const deliveries = await admin.query<{ entity: string }>(
      `select payload->'entity'->>'id' as entity from crm.webhook_deliveries where endpoint_id = $1`,
      [endpoint.rows[0].id],
    );
    assert.ok(deliveries.rows.some((row) => row.entity === deal.body.opportunity.id));
  });

  it("refuses a change that would move more than 250 deals and leaves everything as it was", async () => {
    const owner = await createUser("stage-flags-many@example.com", "Many");
    const company = await createCompany(owner, { name: "Many Co", domain: "many-co.example" });
    const current = await listPipeline(owner);
    const proposal = current.stages.find((stage) => stage.name === "Proposal")!;
    const admin = getAdminPool();
    await admin.query(
      `insert into crm.opportunities (workspace_id, company_id, pipeline_id, stage_id, name, status, currency)
       select $1, $2, $3, $4, 'Deal ' || n, 'open', 'GBP' from generate_series(1, ${STAGE_STATUS_CHANGE_LIMIT + 1}) as n`,
      [owner.workspaceId, company.body.company.id, current.id, proposal.id],
    );
    const since = (await admin.query<{ now: Date }>("select now()")).rows[0].now;
    await assert.rejects(
      savePipelineStages(
        owner,
        current.stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          probability: stage.probability,
          isWon: stage.id === proposal.id,
          isLost: stage.isLost,
        })),
      ),
      /More than 250 opportunities would change status/,
    );
    const statuses = await admin.query<{ status: string; total: number }>(
      "select status, count(*)::int as total from crm.opportunities where stage_id = $1 group by status",
      [proposal.id],
    );
    assert.deepEqual(statuses.rows, [{ status: "open", total: STAGE_STATUS_CHANGE_LIMIT + 1 }]);
    const after = await listPipeline(owner);
    assert.equal(after.stages.find((stage) => stage.id === proposal.id)?.isWon, false);
    const events = await admin.query("select 1 from crm.audit_events where workspace_id = $1 and created_at >= $2", [owner.workspaceId, since]);
    assert.equal(events.rowCount, 0);
  });
});
