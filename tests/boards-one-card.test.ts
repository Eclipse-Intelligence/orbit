import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { archiveBoard, BOARD_ARCHIVE_CARD_LIMIT, createBoard, getBoard } from "@/lib/crm/boards";
import { createCompany } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { constraintError } from "@/lib/crm/mutate";
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

  it("turns a card clash during a merge or a race into a message a person can act on", async () => {
    const board = await createBoard(owner, { name: "Clash" });
    const keep = await company("Clash Keep");
    const dupe = await company("Clash Dupe");
    await card(dupe, board.id);
    const admin = getAdminPool();
    await admin.query("alter table crm.opportunities disable trigger opportunities_one_card_per_board");
    try {
      await admin.query(
        "insert into crm.opportunities (workspace_id, company_id, pipeline_id, stage_id, name, status, currency) select workspace_id, company_id, pipeline_id, stage_id, 'Second', status, currency from crm.opportunities where company_id = $1",
        [dupe],
      );
    } finally {
      await admin.query("alter table crm.opportunities enable trigger opportunities_one_card_per_board");
    }
    await assert.rejects(
      mergeCompanies(owner, keep, dupe, PROVENANCE),
      (error: unknown) => error instanceof CrmError && error.status === 409 && /Clash Keep is already on Clash\./.test(error.message),
    );
    assert.throws(
      () => constraintError({ code: "23505", message: "Acme is already on Delivery." }, "duplicate_opportunity", "A matching opportunity already exists."),
      (error: unknown) => error instanceof CrmError && error.message === "Acme is already on Delivery.",
    );
    assert.throws(
      () => constraintError({ code: "23505", constraint: "opportunities_pkey", message: "duplicate key" }, "duplicate_opportunity", "A matching opportunity already exists."),
      (error: unknown) => error instanceof CrmError && error.message === "A matching opportunity already exists.",
    );
  });

  it("refuses to delete a board with more than 500 cards and leaves it as it was", async () => {
    const board = await createBoard(owner, { name: "Crowded" });
    const first = (await getBoard(owner, board.id)).stages[0];
    const admin = getAdminPool();
    await admin.query(
      `with made as (
         insert into crm.companies (workspace_id, name, normalized_name)
         select $1, 'Crowd ' || n, 'crowd ' || n from generate_series(1, ${BOARD_ARCHIVE_CARD_LIMIT + 1}) as n
         returning id, name
       )
       insert into crm.opportunities (workspace_id, company_id, pipeline_id, stage_id, name, status, currency)
       select $1, made.id, $2, $3, made.name, 'open', 'GBP' from made`,
      [owner.workspaceId, board.id, first.id],
    );
    await assert.rejects(archiveBoard(owner, board.id), /Crowded has more than 500 cards\. Archive some of them first/);
    const open = await admin.query("select 1 from crm.opportunities where pipeline_id = $1 and archived_at is null", [board.id]);
    assert.equal(open.rowCount, BOARD_ARCHIVE_CARD_LIMIT + 1);
    assert.equal((await getBoard(owner, board.id)).name, "Crowded");
  });
});
