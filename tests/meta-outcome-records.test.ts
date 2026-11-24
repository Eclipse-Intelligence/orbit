import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { mergeCompanies, mergeContacts } from "@/lib/crm/merge";
import { moveRecordsToWorkspace } from "@/lib/crm/move-workspace";
import { createOpportunity, listPipeline, moveToProposalStageInDb, updateOpportunity } from "@/lib/crm/opportunities";
import { withActor } from "@/lib/crm/context";
import { undoAuditEvent } from "@/lib/crm/undo";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, queryAsUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const PROVENANCE = { operation: "outcome_test", source: "test" };
const MIGRATION = "20270307100000_meta_outcomes.sql";

let eclipse: UserActor;
let ridgeon: UserActor;
let outsider: UserActor;
let member: UserActor;
let stage: Record<string, string>;
let counter = 0;

async function withoutAuditGuard(work: (run: (text: string, values?: unknown[]) => Promise<unknown>) => Promise<void>) {
  const client = await getAdminPool().connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await work((text, values) => client.query(text, values));
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return getAdminPool()
    .query<T>(text, values)
    .then((result) => result.rows);
}

async function entries(opportunityId: string) {
  return sql<{ stage_id: string; pipeline_id: string; workspace_id: string }>(
    "select stage_id, pipeline_id, workspace_id from crm.opportunity_stage_entries where opportunity_id = $1 order by entered_at, id",
    [opportunityId],
  );
}

async function stagesEntered(opportunityId: string) {
  const names = Object.fromEntries(Object.entries(stage).map(([name, id]) => [id, name]));
  return (await entries(opportunityId)).map((row) => names[row.stage_id]);
}

async function company(actor: UserActor, name?: string) {
  counter += 1;
  return (await createCompany(actor, { name: name ?? `Records Co ${counter}`, domain: `records-co-${counter}.test` }, { provenance: PROVENANCE })).body.company;
}

async function deal(companyId: string, stageName: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  return (await createOpportunity(eclipse, { companyId, name: `Deal ${counter}`, stageId: stage[stageName], ...extra }, { provenance: PROVENANCE })).body.opportunity;
}

async function lead(contactId: string | null, companyId: string | null) {
  counter += 1;
  const rows = await sql<{ id: string }>(
    "insert into crm.meta_leads (leadgen_id, page_id, workspace_id, contact_id, company_id, fetched_at, filed_at) values ($1, '1111111111', $2, $3, $4, now(), now()) returning id",
    [String(700000000 + counter), eclipse.workspaceId, contactId, companyId],
  );
  return rows[0].id;
}

async function leadRow(id: string) {
  return (await sql<{ contact_id: string | null; company_id: string | null; workspace_id: string }>("select contact_id, company_id, workspace_id from crm.meta_leads where id = $1", [id]))[0];
}

describe("opportunity stage entries and Meta lead records", () => {
  useServerlessPool();

  before(async () => {
    await resetDatabase();
    const mark = await createUser("mark@records.test", "Mark Ridgeon");
    await sql("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    eclipse = { ...mark, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    const second = await createUser("sam@records.test", "Sam Member");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [eclipse.workspaceId, second.userId]);
    member = { ...second, workspaceId: eclipse.workspaceId, workspaceName: "Eclipse", role: "member", scopes: scopesForRole("member") };
    outsider = await createUser("olly@elsewhere-records.test", "Olly Outside");
    const pipeline = await listPipeline(eclipse);
    stage = Object.fromEntries(pipeline.stages.map((item) => [item.name, item.id]));
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  describe("stage entries", () => {
    it("writes an entry when an opportunity is created, in whichever stage it starts", async () => {
      const early = await deal((await company(eclipse)).id, "New");
      const late = await deal((await company(eclipse)).id, "Proposal");
      assert.deepEqual(await stagesEntered(early.id), ["New"]);
      assert.deepEqual(await stagesEntered(late.id), ["Proposal"]);
      const [row] = await entries(late.id);
      assert.equal(row.workspace_id, eclipse.workspaceId);
    });

    it("writes an entry for a board move, and not for a change that leaves the stage alone", async () => {
      const item = await deal((await company(eclipse)).id, "New");
      await updateOpportunity(eclipse, item.id, { stageId: stage.Working }, { provenance: PROVENANCE });
      await updateOpportunity(eclipse, item.id, { name: "Renamed" }, { provenance: PROVENANCE });
      await updateOpportunity(eclipse, item.id, { stageId: stage.Working }, { provenance: PROVENANCE });
      assert.deepEqual(await stagesEntered(item.id), ["New", "Working"]);
    });

    it("writes an entry when a workflow's board step moves a card", async () => {
      const item = await deal((await company(eclipse)).id, "New");
      await updateOpportunity(eclipse, item.id, { stageId: stage.Working }, { provenance: { operation: "workflow_step", source: "workflow", automatic: true } });
      assert.deepEqual(await stagesEntered(item.id), ["New", "Working"]);
    });

    it("writes an entry when sending a proposal moves or creates the opportunity", async () => {
      const acme = await company(eclipse);
      const item = await deal(acme.id, "New");
      const moved = await withActor(eclipse, (db) =>
        moveToProposalStageInDb(db, eclipse, { companyId: acme.id, contactId: null, companyName: acme.name, opportunityId: item.id, value: 5000, currency: "GBP", ownerId: null }, PROVENANCE),
      );
      assert.equal(moved.moved, true);
      assert.deepEqual(await stagesEntered(item.id), ["New", "Proposal"]);
      const fresh = await company(eclipse);
      const created = await withActor(eclipse, (db) =>
        moveToProposalStageInDb(db, eclipse, { companyId: fresh.id, contactId: null, companyName: fresh.name, opportunityId: null, value: 5000, currency: "GBP", ownerId: null }, PROVENANCE),
      );
      assert.equal(created.created, true);
      const found = await sql<{ id: string }>("select id from crm.opportunities where company_id = $1", [fresh.id]);
      assert.deepEqual(await stagesEntered(found[0].id), ["Proposal"]);
    });

    it("writes an entry for every opportunity in a bulk change", async () => {
      const ids = [];
      for (let index = 0; index < 3; index += 1) ids.push((await deal((await company(eclipse)).id, "New")).id);
      await sql("update crm.opportunities set stage_id = $2 where id = any($1)", [ids, stage.Working]);
      for (const id of ids) assert.deepEqual(await stagesEntered(id), ["New", "Working"]);
    });

    it("writes an entry when an undo puts an opportunity back in a stage", async () => {
      const item = await deal((await company(eclipse)).id, "New");
      await updateOpportunity(eclipse, item.id, { stageId: stage.Proposal }, { provenance: PROVENANCE });
      const event = (await sql<{ id: string }>("select id from crm.audit_events where entity_id = $1 and event_type = 'opportunity.stage_changed' order by created_at desc limit 1", [item.id]))[0];
      await undoAuditEvent(eclipse, event.id, PROVENANCE);
      assert.deepEqual(await stagesEntered(item.id), ["New", "Proposal", "New"]);
    });

    it("writes an entry in the target workspace when an opportunity moves there", async () => {
      const acme = await company(eclipse);
      const item = await deal(acme.id, "Working");
      const target = await listPipeline(ridgeon);
      await moveRecordsToWorkspace(eclipse, { companyIds: [acme.id], workspaceId: ridgeon.workspaceId, pipelineId: target.id, stageId: target.stages[1].id }, PROVENANCE);
      const rows = await entries(item.id);
      assert.equal(rows.at(-1)?.workspace_id, ridgeon.workspaceId);
      assert.equal(rows.at(-1)?.pipeline_id, target.id);
      assert.equal(rows.at(-1)?.stage_id, target.stages[1].id);
    });

    it("can be read by the workspace's members and by nobody else, and written by nobody directly", async () => {
      const item = await deal((await company(eclipse)).id, "New");
      await updateOpportunity(eclipse, item.id, { stageId: stage.Working }, { provenance: PROVENANCE });
      const seen = await queryAsUser<{ stage_id: string }>(member.userId, "select stage_id from crm.opportunity_stage_entries where opportunity_id = $1", [item.id]);
      assert.equal(seen.length, 2);
      assert.deepEqual(await queryAsUser(outsider.userId, "select 1 from crm.opportunity_stage_entries where opportunity_id = $1", [item.id]), []);
      await assert.rejects(
        queryAsUser(member.userId, "insert into crm.opportunity_stage_entries (workspace_id, opportunity_id, pipeline_id, stage_id) select workspace_id, id, pipeline_id, stage_id from crm.opportunities where id = $1", [item.id]),
        /permission denied/,
      );
      await assert.rejects(queryAsUser(member.userId, "update crm.opportunity_stage_entries set entered_at = now()"), /permission denied/);
      await assert.rejects(queryAsUser(member.userId, "delete from crm.opportunity_stage_entries"), /permission denied/);
    });

    it("is backfilled from audit events, once", async () => {
      const acme = await company(eclipse);
      const item = await deal(acme.id, "New");
      await updateOpportunity(eclipse, item.id, { stageId: stage.Working }, { provenance: PROVENANCE });
      await updateOpportunity(eclipse, item.id, { stageId: stage.Proposal }, { provenance: PROVENANCE });
      await updateOpportunity(eclipse, item.id, { stageId: stage.Won }, { provenance: PROVENANCE });
      const events = await sql<{ id: string }>("select id from crm.audit_events where entity_id = $1 order by created_at, id", [item.id]);
      assert.equal(events.length >= 4, true);
      const days = [20, 15, 10, 5];
      const plain = await deal((await company(eclipse)).id, "Proposal");
      await withoutAuditGuard(async (run) => {
        for (const [index, event] of events.slice(0, 4).entries()) await run("update crm.audit_events set created_at = now() - make_interval(days => $2) where id = $1", [event.id, days[index]]);
        await run("delete from crm.audit_events where entity_id = $1", [plain.id]);
      });
      await sql("update crm.opportunities set created_at = now() - interval '30 days', updated_at = now() - interval '30 days' where id = $1", [plain.id]);
      await sql("delete from crm.opportunity_stage_entries where opportunity_id = any($1)", [[item.id, plain.id]]);
      await reapplyMigrationsFrom(MIGRATION);
      assert.deepEqual(await stagesEntered(item.id), ["New", "Working", "Proposal", "Won"]);
      const times = await sql<{ days: number }>("select round(extract(epoch from (now() - entered_at)) / 86400)::int as days from crm.opportunity_stage_entries where opportunity_id = $1 order by entered_at", [item.id]);
      assert.deepEqual(times.map((row) => row.days), days);
      assert.deepEqual(await stagesEntered(plain.id), ["Proposal"]);
      assert.equal((await sql<{ days: number }>("select round(extract(epoch from (now() - entered_at)) / 86400)::int as days from crm.opportunity_stage_entries where opportunity_id = $1", [plain.id]))[0].days, 30);
      const before = (await sql<{ count: number }>("select count(*)::int as count from crm.opportunity_stage_entries"))[0].count;
      await reapplyMigrationsFrom(MIGRATION);
      assert.equal((await sql<{ count: number }>("select count(*)::int as count from crm.opportunity_stage_entries"))[0].count, before);
    });

    it("ignores audit events that only change the status when it backfills", async () => {
      const item = await deal((await company(eclipse)).id, "New");
      await updateOpportunity(eclipse, item.id, { stageId: stage.Proposal }, { provenance: PROVENANCE });
      await sql(
        `insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, operation, changes)
         values ($1, 'opportunity.stage_changed', 'opportunity', $2, 'system', 'status', $3::jsonb)`,
        [eclipse.workspaceId, item.id, JSON.stringify({ before: { stageId: stage.Proposal, status: "open" }, after: { stageId: stage.Proposal, status: "won" } })],
      );
      await sql("delete from crm.opportunity_stage_entries where opportunity_id = $1", [item.id]);
      await reapplyMigrationsFrom(MIGRATION);
      assert.deepEqual(await stagesEntered(item.id), ["New", "Proposal"]);
    });
  });

  describe("merges and moves", () => {
    it("points a lead at the contact it was merged into", async () => {
      const acme = await company(eclipse);
      const keep = (await createContact(eclipse, { firstName: "Keep", lastName: "Me", email: `keep-${counter}@records.test`, companyId: acme.id }, { provenance: PROVENANCE })).body.contact;
      const gone = (await createContact(eclipse, { firstName: "Gone", lastName: "Soon", email: `gone-${counter}@records.test`, companyId: acme.id }, { provenance: PROVENANCE })).body.contact;
      const id = await lead(gone.id, acme.id);
      await mergeContacts(eclipse, keep.id, gone.id, PROVENANCE);
      assert.deepEqual(await leadRow(id), { contact_id: keep.id, company_id: acme.id, workspace_id: eclipse.workspaceId });
    });

    it("points a lead at the company it was merged into", async () => {
      const keep = await company(eclipse);
      const gone = await company(eclipse);
      const person = (await createContact(eclipse, { firstName: "Lee", lastName: "Lead", companyId: gone.id }, { provenance: PROVENANCE })).body.contact;
      const id = await lead(person.id, gone.id);
      await mergeCompanies(eclipse, keep.id, gone.id, PROVENANCE);
      assert.deepEqual(await leadRow(id), { contact_id: person.id, company_id: keep.id, workspace_id: eclipse.workspaceId });
    });

    it("keeps a lead's ids when its records move to another workspace", async () => {
      const acme = await company(eclipse);
      const person = (await createContact(eclipse, { firstName: "Mo", lastName: "Mover", companyId: acme.id }, { provenance: PROVENANCE })).body.contact;
      const id = await lead(person.id, acme.id);
      await moveRecordsToWorkspace(eclipse, { companyIds: [acme.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
      assert.deepEqual(await leadRow(id), { contact_id: person.id, company_id: acme.id, workspace_id: eclipse.workspaceId });
    });

    it("changes nothing on a lead when its records are copied", async () => {
      const acme = await company(eclipse);
      const person = (await createContact(eclipse, { firstName: "Cy", lastName: "Copy", companyId: acme.id }, { provenance: PROVENANCE })).body.contact;
      const id = await lead(person.id, acme.id);
      await moveRecordsToWorkspace(eclipse, { companyIds: [acme.id], workspaceId: ridgeon.workspaceId, copy: true }, PROVENANCE);
      assert.deepEqual(await leadRow(id), { contact_id: person.id, company_id: acme.id, workspace_id: eclipse.workspaceId });
    });

    it("follows the records a move merged into ones the other workspace already had", async () => {
      counter += 1;
      const domain = `merged-${counter}.test`;
      const source = (await createCompany(eclipse, { name: `Merged Co ${counter}`, domain }, { provenance: PROVENANCE })).body.company;
      const there = (await createCompany(ridgeon, { name: `Merged Co ${counter}`, domain }, { provenance: PROVENANCE })).body.company;
      const person = (await createContact(eclipse, { firstName: "Dee", lastName: "Dupe", email: `dee-${counter}@${domain}`, companyId: source.id }, { provenance: PROVENANCE })).body.contact;
      const existing = (await createContact(ridgeon, { firstName: "Dee", lastName: "Dupe", email: `dee-${counter}@${domain}`, companyId: there.id }, { provenance: PROVENANCE })).body.contact;
      const id = await lead(person.id, source.id);
      await moveRecordsToWorkspace(eclipse, { companyIds: [source.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
      assert.deepEqual(await leadRow(id), { contact_id: existing.id, company_id: there.id, workspace_id: eclipse.workspaceId });
    });

    it("lets a lead follow a record merged in the other workspace after it moved there", async () => {
      const acme = await company(eclipse);
      const person = (await createContact(eclipse, { firstName: "Moe", lastName: "Merge", companyId: acme.id }, { provenance: PROVENANCE })).body.contact;
      const id = await lead(person.id, acme.id);
      await moveRecordsToWorkspace(eclipse, { companyIds: [acme.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
      const keep = (await createContact(ridgeon, { firstName: "Moe", lastName: "Keeper", companyId: acme.id }, { provenance: PROVENANCE })).body.contact;
      await mergeContacts(ridgeon, keep.id, person.id, PROVENANCE);
      assert.deepEqual(await leadRow(id), { contact_id: keep.id, company_id: acme.id, workspace_id: eclipse.workspaceId });
      const other = await company(ridgeon);
      await mergeCompanies(ridgeon, other.id, acme.id, PROVENANCE);
      assert.equal((await leadRow(id)).company_id, other.id);
    });

    it("still refuses to point a lead at another workspace's record by hand", async () => {
      const acme = await company(eclipse);
      const id = await lead(null, acme.id);
      const elsewhere = await company(ridgeon);
      await assert.rejects(sql("update crm.meta_leads set company_id = $2 where id = $1", [id, elsewhere.id]), /company belongs to another workspace/);
      const person = (await createContact(ridgeon, { firstName: "Else", lastName: "Where" }, { provenance: PROVENANCE })).body.contact;
      await assert.rejects(sql("update crm.meta_leads set contact_id = $2 where id = $1", [id, person.id]), /contact belongs to another workspace/);
    });

    it("keeps working for a lead whose opportunity moved: it stays in its own workspace's pipeline", async () => {
      process.env.META_DATASET_TOKEN = "records-token";
      try {
        await sql("insert into crm.meta_outcome_settings (workspace_id, dataset_id, enabled) values ($1, '1608701054328072', true) on conflict (workspace_id) do update set enabled = true", [eclipse.workspaceId]);
        const acme = await company(eclipse);
        const person = (await createContact(eclipse, { firstName: "Pat", lastName: "Pipeline", companyId: acme.id }, { provenance: PROVENANCE })).body.contact;
        const id = await lead(person.id, acme.id);
        const item = await deal(acme.id, "New", { primaryContactId: person.id });
        await moveRecordsToWorkspace(eclipse, { companyIds: [acme.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
        await sql("update crm.opportunity_stage_entries set entered_at = now() - interval '1 hour' where opportunity_id = $1", [item.id]);
        const due = await sql<{ stage_name: string }>("select stage_name from private.meta_lead_outcomes_due(10, $1, $2)", [person.id, acme.id]);
        assert.deepEqual(due.map((row) => row.stage_name), ["Lead"]);
        assert.equal((await leadRow(id)).workspace_id, eclipse.workspaceId);
      } finally {
        delete process.env.META_DATASET_TOKEN;
        await sql("delete from crm.meta_outcome_settings where workspace_id = $1", [eclipse.workspaceId]);
      }
    });

    it("refuses a merge across workspaces as before", async () => {
      const left = await company(eclipse);
      const right = await company(ridgeon);
      await assert.rejects(mergeCompanies(eclipse, left.id, right.id, PROVENANCE), (error: unknown) => error instanceof CrmError);
    });
  });
});
