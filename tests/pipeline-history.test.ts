import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { createActivity } from "@/lib/crm/activities";
import { createBoard, getBoard } from "@/lib/crm/boards";
import { createCompany } from "@/lib/crm/companies";
import { createOpportunity, listPipeline, updateOpportunity } from "@/lib/crm/opportunities";
import { pipelineReport, stageHistory, stalledDeals } from "@/lib/crm/pipeline-history";
import { completeTask, createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { runUnit } from "@/lib/learning/nightly";
import { createUser, resetDatabase } from "./helpers";

const DAY = 86_400_000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);

async function deal(owner: UserActor, name: string, stages: string[]) {
  const company = (await createCompany(owner, { name, domain: `${name.toLowerCase()}.test` })).body.company.id;
  const created = (await createOpportunity(owner, { companyId: company, name: `${name} deal`, stageId: stages[0] })).body.opportunity;
  for (const stageId of stages.slice(1)) await updateOpportunity(owner, created.id, { stageId });
  return { id: created.id, companyId: company };
}

async function backdate(id: string, createdDaysAgo: number, changeDaysAgo: number[]) {
  const client = await getAdminPool().connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update crm.opportunities set created_at = $2 where id = $1", [id, ago(createdDaysAgo)]);
    const events = await client.query<{ id: string }>(
      "select id from crm.audit_events where entity_id = $1 and event_type = 'opportunity.stage_changed' order by created_at, id",
      [id],
    );
    assert.equal(events.rows.length, changeDaysAgo.length);
    for (const [index, row] of events.rows.entries()) {
      await client.query("update crm.audit_events set created_at = $2 where id = $1", [row.id, ago(changeDaysAgo[index])]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function activityOn(owner: UserActor, companyId: string, type: "note" | "call", daysAgo: number) {
  const activity = (await createActivity(owner, { type, title: `${type} logged`, body: "Spoke about next steps.", companyId })).body.activity;
  await getAdminPool().query("update crm.activities set occurred_at = $2 where id = $1", [activity.id, ago(daysAgo)]);
}

describe("pipeline history", () => {
  let owner: UserActor;
  let stage: Record<string, string>;
  const deals: Record<string, { id: string; companyId: string }> = {};
  let hooliTask: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("history@orbit.test", "Mark Ridgeon");
    const pipeline = await listPipeline(owner);
    stage = Object.fromEntries(pipeline.stages.map((item) => [item.name, item.id]));

    deals.acme = await deal(owner, "Acme", [stage.New, stage.Working, stage.Proposal, stage.Won]);
    await backdate(deals.acme.id, 30, [25, 20, 10]);
    deals.globex = await deal(owner, "Globex", [stage.New, stage.Working, stage.Lost]);
    await backdate(deals.globex.id, 40, [30, 5]);
    deals.initech = await deal(owner, "Initech", [stage.New, stage.Working]);
    await backdate(deals.initech.id, 20, [12]);
    await activityOn(owner, deals.initech.companyId, "note", 15);
    deals.umbrella = await deal(owner, "Umbrella", [stage.New, stage.Proposal]);
    await backdate(deals.umbrella.id, 15, [10]);
    await activityOn(owner, deals.umbrella.companyId, "note", 2);
    deals.hooli = await deal(owner, "Hooli", [stage.New]);
    await backdate(deals.hooli.id, 9, []);
    hooliTask = (await createTask(owner, { title: "Send the pricing", companyId: deals.hooli.companyId, dueAt: new Date(now.getTime() + 2 * DAY).toISOString() })).body.task.id;
    deals.fresh = await deal(owner, "Fresh", [stage.New]);
    await backdate(deals.fresh.id, 3, []);
    deals.hal = await deal(owner, "Hal", [stage.New, stage.Working]);
    await backdate(deals.hal.id, 30, [20]);
    await activityOn(owner, deals.hal.companyId, "call", 10);
  });

  after(async () => {
    await getPool().end();
  });

  it("lists every stage a deal has been in, starting from when it was created", async () => {
    const history = await stageHistory(owner, deals.acme.id, now);
    assert.equal(history.status, "won");
    assert.deepEqual(
      history.stays.map((stay) => [stay.fromStageName, stay.stageName, stay.daysInStage, stay.by.name]),
      [
        [null, "New", 5, "Mark Ridgeon"],
        ["New", "Working", 5, "Mark Ridgeon"],
        ["Working", "Proposal", 10, "Mark Ridgeon"],
        ["Proposal", "Won", 10, "Mark Ridgeon"],
      ],
    );
    assert.equal(history.stays[0].enteredAt, ago(30).toISOString());
    assert.equal(history.stays[3].leftAt, null);
    assert.equal(history.stays[3].status, "won");

    const fresh = await stageHistory(owner, deals.fresh.id, now);
    assert.deepEqual(fresh.stays.map((stay) => [stay.stageName, stay.daysInStage]), [["New", 3]]);
    await assert.rejects(stageHistory(owner, "not-an-id"), /Opportunity not found/);
  });

  it("reports time in stage, outcomes, conversion and the win rate", async () => {
    const report = await pipelineReport(owner, { since: ago(60), now });
    assert.equal(report.pipeline.kind, "sales");
    assert.deepEqual([report.won, report.lost, report.winRate], [1, 1, 0.5]);
    const byName = Object.fromEntries(report.stages.map((item) => [item.name, item]));

    assert.equal(byName.New.inStageNow, 2);
    assert.equal(byName.New.entered, 7);
    assert.deepEqual(byName.New.daysInStage?.past, { count: 5, median: 8, average: 7.6 });
    assert.deepEqual(byName.New.daysInStage?.current, { count: 2, median: 6, average: 6 });
    assert.deepEqual(byName.New.outcomes, { forward: 5, won: 0, lost: 0, back: 0, stalled: 0 });
    assert.equal(byName.New.conversionToWon, 0.14);

    assert.equal(byName.Working.entered, 4);
    assert.deepEqual(byName.Working.daysInStage?.past, { count: 2, median: 15, average: 15 });
    assert.deepEqual(byName.Working.daysInStage?.current, { count: 2, median: 16, average: 16 });
    assert.deepEqual(byName.Working.outcomes, { forward: 1, won: 0, lost: 1, back: 0, stalled: 2 });
    assert.equal(byName.Working.conversionToWon, 0.25);

    assert.deepEqual(byName.Proposal.outcomes, { forward: 0, won: 1, lost: 0, back: 0, stalled: 0 });
    assert.equal(byName.Proposal.conversionToWon, 0.5);
    assert.equal(byName.Won.inStageNow, 1);
    assert.equal(byName.Won.daysInStage, null);
    assert.equal(byName.Won.conversionToWon, null);

    const recent = await pipelineReport(owner, { since: ago(7), now });
    assert.deepEqual([recent.won, recent.lost, recent.winRate], [0, 1, 0]);
    await assert.rejects(pipelineReport(owner, { since: "soon" }), /Use a date like/);
  });

  it("finds open deals that have gone quiet in their stage, and activity or a due task un-stalls them", async () => {
    const stalled = await stalledDeals(owner, { days: 7, now });
    assert.deepEqual(stalled.map((item) => item.name), ["Initech deal", "Hal deal"]);
    const [initech, hal] = stalled;
    assert.equal(initech.stageName, "Working");
    assert.equal(initech.daysInStage, 12);
    assert.equal(initech.lastActivityAt, ago(15).toISOString());
    assert.equal(initech.reason, "No activity or email since moving to Working 12 days ago, and no task due.");
    assert.equal(initech.href, `/opportunities/${deals.initech.id}`);
    assert.equal(hal.daysInStage, 20);
    assert.equal(hal.daysQuiet, 10);
    assert.equal(hal.reason, "Last call 10 days ago, 20 days in Working, and no task due.");

    assert.deepEqual((await stalledDeals(owner, { days: 11, now })).map((item) => item.name), ["Initech deal"]);
    assert.deepEqual((await stalledDeals(owner, { days: 7, stageIds: [stage.Proposal], now })).length, 0);

    await completeTask(owner, hooliTask);
    assert.deepEqual((await stalledDeals(owner, { days: 7, now })).map((item) => item.name), ["Initech deal", "Hal deal", "Hooli deal"]);

    await createActivity(owner, { type: "note", title: "Chased", body: "Chased the decision.", companyId: deals.initech.companyId });
    assert.deepEqual((await stalledDeals(owner, { days: 7, now: new Date(now.getTime() + 60_000) })).map((item) => item.name), ["Hal deal", "Hooli deal"]);

    await createTask(owner, { title: "Call Hal", companyId: deals.hal.companyId, dueAt: new Date(now.getTime() + DAY).toISOString() });
    assert.deepEqual((await stalledDeals(owner, { days: 7, now })).map((item) => item.name), ["Hooli deal"]);
  });

  it("covers boards when asked, and leaves them out by default", async () => {
    const board = await createBoard(owner, { name: "Onboarding" });
    const stages = (await getBoard(owner, board.id)).stages;
    const company = (await createCompany(owner, { name: "Boardco", domain: "boardco.test" })).body.company.id;
    const card = (await createOpportunity(owner, { companyId: company, pipelineId: board.id })).body.opportunity;
    await updateOpportunity(owner, card.id, { stageId: stages[1].id });
    await backdate(card.id, 30, [20]);

    assert.ok(!(await stalledDeals(owner, { days: 7, now })).some((item) => item.opportunityId === card.id));
    const onBoard = await stalledDeals(owner, { days: 7, pipelineId: board.id, now });
    assert.deepEqual(onBoard.map((item) => [item.name, item.stageName, item.daysInStage]), [["Boardco", stages[1].name, 20]]);
    assert.match(onBoard[0].href, /^\/boards\//);

    const report = await pipelineReport(owner, { pipelineId: board.id, since: ago(60), now });
    assert.equal(report.pipeline.kind, "board");
    assert.equal(report.winRate, null);
    assert.equal(report.stages[1].outcomes.stalled, 1);
    assert.deepEqual(report.stages[0].daysInStage?.past, { count: 1, median: 10, average: 10 });
  });

  it("gives the assistant read-only tools and puts stalled deals in the morning brief", async () => {
    const history = (await runTool(owner, "get_deal_history", { opportunityId: deals.globex.id })) as { stays: { stageName: string }[] };
    assert.deepEqual(history.stays.map((stay) => stay.stageName), ["New", "Working", "Lost"]);
    const report = (await runTool(owner, "pipeline_report", { since: ago(60).toISOString().slice(0, 10) })) as { winRate: number; stages: unknown[] };
    assert.equal(report.winRate, 0.5);
    assert.equal(report.stages.length, 5);
    const quiet = (await runTool(owner, "stalled_deals", { days: 7 })) as { deals: { name: string }[] };
    assert.deepEqual(quiet.deals.map((item) => item.name), ["Hooli deal"]);

    process.env.LLM_API_KEY = "llm-test";
    try {
      const seen: { system: string; user: string }[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        seen.push({ system: body.messages[0].content, user: body.messages[1].content });
        return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ brief: "### Deals gone quiet\n- Hooli deal needs a nudge." }) }, finish_reason: "stop" }] });
      };
      const result = await runUnit(owner, "brief", { deadline: Date.now() + 120_000, fetchImpl, trigger: "manual" });
      assert.equal(result.brief, true);
      assert.match(seen[0].system, /Deals gone quiet/);
      assert.match(seen[0].user, /Open deals gone quiet/);
      assert.match(seen[0].user, new RegExp(`- Hooli deal \\(Hooli, New, link /opportunities/${deals.hooli.id}\\): No activity or email since moving to New 9 days ago`));
      assert.doesNotMatch(seen[0].user, /Initech deal/);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });
});
