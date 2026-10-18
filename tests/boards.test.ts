import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { archiveBoard, createBoard, getBoard, listBoards, updateBoard } from "@/lib/crm/boards";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity, listOpportunities, listPipeline, updateOpportunity } from "@/lib/crm/opportunities";
import { savePipelineStages } from "@/lib/crm/pipeline";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

describe("boards", () => {
  let owner: UserActor;
  let acme: string;
  let globex: string;
  let jane: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("boards@orbit.test", "Mark Ridgeon");
    acme = (await createCompany(owner, { name: "Acme Boards", domain: "acme-boards.test", lifecycle: "prospect" })).body.company.id;
    globex = (await createCompany(owner, { name: "Globex Boards", domain: "globex-boards.test" })).body.company.id;
    jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", companyId: acme })).body.contact.id;
  });

  after(async () => {
    await getPool().end();
  });

  it("creates, lists and renames boards with their own stages", async () => {
    const board = await createBoard(owner, { name: "Onboarding" });
    assert.equal(board.kind, "board");
    const full = await getBoard(owner, board.id);
    assert.deepEqual(
      full.stages.map((stage) => stage.name),
      ["To start", "In progress", "Done"],
    );
    await assert.rejects(createBoard(owner, { name: "onboarding" }), /already a board called/);
    await assert.rejects(createBoard(owner, { name: "  " }), /Give the board a name/);

    const renamed = await updateBoard(owner, board.id, { name: "Client onboarding" });
    assert.equal(renamed.name, "Client onboarding");
    const stages = await savePipelineStages(owner, [{ id: full.stages[0].id, name: "Kick-off" }, { name: "Live" }], board.id);
    assert.deepEqual(
      stages.map((stage) => [stage.name, stage.isWon, stage.isLost, stage.probability]),
      [
        ["Kick-off", false, false, 0],
        ["Live", false, false, 0],
      ],
    );

    const sales = await listPipeline(owner);
    assert.deepEqual(
      sales.stages.map((stage) => stage.name),
      ["New", "Working", "Proposal", "Won", "Lost"],
    );
    assert.deepEqual(
      (await listBoards(owner)).map((item) => item.name),
      ["Client onboarding"],
    );
  });

  it("holds each company once, named after it, apart from the sales pipeline", async () => {
    const board = (await listBoards(owner))[0];
    const full = await getBoard(owner, board.id);
    const card = (await createOpportunity(owner, { companyId: acme, pipelineId: board.id, primaryContactId: jane })).body.opportunity;
    assert.equal(card.name, "Acme Boards");
    assert.equal(card.pipelineId, board.id);
    assert.equal(card.pipelineKind, "board");
    assert.equal(card.pipelineName, "Client onboarding");
    assert.equal(card.stageId, full.stages[0].id);
    assert.equal(card.status, "open");
    await assert.rejects(createOpportunity(owner, { companyId: acme, pipelineId: board.id }), /Acme Boards is already on Client onboarding/);
    await assert.rejects(createOpportunity(owner, { companyId: globex }), /Enter an opportunity name/);

    const deal = (await createOpportunity(owner, { companyId: globex, name: "Globex retainer" })).body.opportunity;
    const sales = await listPipeline(owner);
    assert.deepEqual(
      (await listOpportunities(owner, { pipelineId: board.id })).data.map((item) => item.id),
      [card.id],
    );
    assert.deepEqual(
      (await listOpportunities(owner, { pipelineId: sales.id })).data.map((item) => item.id),
      [deal.id],
    );

    const moved = (await updateOpportunity(owner, card.id, { stageId: full.stages[1].id })).body.opportunity;
    assert.equal(moved.stageName, "Live");
    await assert.rejects(updateOpportunity(owner, card.id, { stageId: sales.stages[0].id }), /Stage not found/);
    await assert.rejects(updateOpportunity(owner, card.id, { status: "won" }), /no won stage/);
    await assert.rejects(savePipelineStages(owner, [{ id: full.stages[0].id, name: "Kick-off" }], board.id), /Move cards off a stage/);
  });

  it("makes the company a customer and adds it to boards that ask when a deal is won", async () => {
    const welcome = await createBoard(owner, { name: "Welcome pack" });
    await updateBoard(owner, welcome.id, { addOnWon: true });
    const deal = (await createOpportunity(owner, { companyId: globex, name: "Globex expansion", primaryContactId: null })).body.opportunity;
    await updateOpportunity(owner, deal.id, { status: "won" });

    assert.equal((await getCompany(owner, globex)).lifecycle, "customer");
    const cards = await listOpportunities(owner, { pipelineId: welcome.id });
    assert.deepEqual(
      cards.data.map((card) => [card.companyName, card.stageName]),
      [["Globex Boards", "To start"]],
    );
    const onboarding = (await listBoards(owner)).find((board) => board.name === "Client onboarding");
    assert.ok(onboarding);
    assert.equal((await listOpportunities(owner, { pipelineId: onboarding.id, companyId: globex })).total, 0);

    const again = (await createOpportunity(owner, { companyId: globex, name: "Globex renewal", status: "won" })).body.opportunity;
    assert.equal(again.status, "won");
    assert.equal((await listOpportunities(owner, { pipelineId: welcome.id })).total, 1);
  });

  it("lets the assistant read a board and add to it", async () => {
    const onboarding = (await listBoards(owner)).find((board) => board.name === "Client onboarding");
    assert.ok(onboarding);
    const listed = (await runTool(owner, "list_boards", {})) as { boards: { name: string }[] };
    assert.deepEqual(
      listed.boards.map((board) => board.name),
      ["Client onboarding", "Welcome pack"],
    );
    const added = (await runTool(owner, "add_to_board", { boardId: onboarding.id, companyId: globex })) as { card: { name: string } };
    assert.equal(added.card.name, "Globex Boards");
    const board = (await runTool(owner, "get_board", { boardId: onboarding.id })) as {
      stages: { name: string; cards: { companyName: string; primaryContactName: string | null }[] }[];
    };
    assert.deepEqual(
      board.stages.map((stage) => [stage.name, stage.cards.map((card) => card.companyName)]),
      [
        ["Kick-off", ["Globex Boards"]],
        ["Live", ["Acme Boards"]],
      ],
    );
    const pipeline = (await runTool(owner, "get_pipeline", {})) as { totals: { count: number } };
    assert.equal(pipeline.totals.count, 3);
  });

  it("takes a deleted board and its cards out of view", async () => {
    const welcome = (await listBoards(owner)).find((board) => board.name === "Welcome pack");
    assert.ok(welcome);
    const result = await archiveBoard(owner, welcome.id);
    assert.equal(result.archived, 1);
    assert.deepEqual(
      (await listBoards(owner)).map((board) => board.name),
      ["Client onboarding"],
    );
    await assert.rejects(getBoard(owner, welcome.id), /Board not found/);
    await assert.rejects(createOpportunity(owner, { companyId: acme, pipelineId: welcome.id }), /Board not found/);
  });
});
