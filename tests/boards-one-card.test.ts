import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { archiveBoard, createBoard } from "@/lib/crm/boards";
import { createCompany } from "@/lib/crm/companies";
import { mergeCompanies } from "@/lib/crm/merge";
import { archiveOpportunity, createOpportunity, unarchiveOpportunityInDb, updateOpportunity } from "@/lib/crm/opportunities";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { withActor } from "@/lib/crm/context";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

const PROVENANCE = { operation: "board_test", source: "test" };

let owner: UserActor;

async function company(name: string) {
  return (await createCompany(owner, { name, domain: `${name.toLowerCase().replace(/\W+/g, "-")}.board-test` })).body.company.id;
}

async function card(companyId: string, pipelineId: string) {
  return (await createOpportunity(owner, { companyId, pipelineId })).body.opportunity.id;
}

before(async () => {
  await resetDatabase();
  owner = await createUser("cards@board-test.test", "Cara Cards");
});

after(async () => {
  await getPool().end();
});

describe("one card per company on a board", () => {
  it("refuses to change a card's company to one already on the board", async () => {
    const board = await createBoard(owner, { name: "Delivery" });
    const acme = await company("Acme");
    const tandem = await company("Tandem");
    await card(acme, board.id);
    const tandemCard = await card(tandem, board.id);
    await assert.rejects(updateOpportunity(owner, tandemCard, { companyId: acme }), /Acme is already on Delivery/);
    await assert.rejects(
      getAdminPool().query("update crm.opportunities set company_id = $1 where id = $2", [acme, tandemCard]),
      /Acme is already on Delivery/,
    );
    await archiveOpportunity(owner, tandemCard);
    await updateOpportunity(owner, tandemCard, { companyId: acme });
    await assert.rejects(
      withActor(owner, (db) => unarchiveOpportunityInDb(db, owner, tandemCard, PROVENANCE)),
      /Acme is already on Delivery/,
    );
  });

  it("combines the two companies' cards on a board when they are merged", async () => {
    const board = await createBoard(owner, { name: "Onboarding" });
    const other = await createBoard(owner, { name: "Renewals" });
    const keep = await company("Keeper");
    const dupe = await company("Keeper Duplicate");
    const keptCard = await card(keep, board.id);
    const dupeCard = await card(dupe, board.id);
    const soloCard = await card(dupe, other.id);
    await getAdminPool().query(
      "insert into crm.activities (workspace_id, type, title, body, occurred_at, company_id, opportunity_id, actor_user_id) values ($1, 'note', '', 'Kick-off booked', now(), $2, $3, $4)",
      [owner.workspaceId, dupe, dupeCard, owner.userId],
    );
    const task = (await createTask(owner, { title: "Send welcome pack", companyId: dupe, opportunityId: dupeCard })).body.task;

    await mergeCompanies(owner, keep, dupe, PROVENANCE);

    const admin = getAdminPool();
    const cards = await admin.query<{ id: string; company_id: string; archived_at: Date | null }>(
      "select id, company_id, archived_at from crm.opportunities where id = any($1::uuid[]) order by created_at",
      [[keptCard, dupeCard, soloCard]],
    );
    const byId = new Map(cards.rows.map((row) => [row.id, row]));
    assert.equal(byId.get(keptCard)?.archived_at, null);
    assert.notEqual(byId.get(dupeCard)?.archived_at, null);
    assert.equal(byId.get(soloCard)?.archived_at, null);
    assert.equal(byId.get(soloCard)?.company_id, keep);
    const live = await admin.query(
      "select 1 from crm.opportunities where pipeline_id = $1 and company_id = $2 and archived_at is null",
      [board.id, keep],
    );
    assert.equal(live.rowCount, 1);
    const moved = await admin.query<{ opportunity_id: string }>(
      "select opportunity_id from crm.activities where workspace_id = $1 and body = 'Kick-off booked'",
      [owner.workspaceId],
    );
    assert.equal(moved.rows[0].opportunity_id, keptCard);
    const movedTask = await admin.query<{ opportunity_id: string }>("select opportunity_id from crm.tasks where id = $1", [task.id]);
    assert.equal(movedTask.rows[0].opportunity_id, keptCard);
    const audit = await admin.query<{ combined: string }>(
      "select changes->>'combinedInto' as combined from crm.audit_events where entity_id = $1 and event_type = 'opportunity.archived'",
      [dupeCard],
    );
    assert.deepEqual(audit.rows, [{ combined: keptCard }]);
  });

  it("records an archive event for every card when a board is deleted", async () => {
    const board = await createBoard(owner, { name: "Pilot" });
    const ids = [await card(await company("Pilot One"), board.id), await card(await company("Pilot Two"), board.id)];
    await getAdminPool().query(
      `insert into crm.webhook_endpoints (workspace_id, url, secret, events) values ($1, 'https://hooks.example/cards', 'sealed', array['opportunity.archived'])`,
      [owner.workspaceId],
    );
    const result = await archiveBoard(owner, board.id);
    assert.equal(result.archived, 2);
    const admin = getAdminPool();
    const events = await admin.query<{ entity_id: string; board: string }>(
      "select entity_id, changes->>'boardArchived' as board from crm.audit_events where event_type = 'opportunity.archived' and entity_id = any($1::uuid[])",
      [ids],
    );
    assert.deepEqual(events.rows.map((row) => row.entity_id).sort(), [...ids].sort());
    assert.ok(events.rows.every((row) => row.board === board.id));
    const deliveries = await admin.query(
      "select 1 from crm.webhook_deliveries where event_type = 'opportunity.archived' and payload->'entity'->>'id' = any($1::text[])",
      [ids],
    );
    assert.equal(deliveries.rowCount, 2);
  });
});
