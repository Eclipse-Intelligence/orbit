import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { crossWorkspaceRefusal, describeAction, recordNames, runTool, toolDefinitions } from "@/lib/assistant/tools";
import { logActivity } from "@/lib/crm/activities";
import { createBoard } from "@/lib/crm/boards";
import { createCompany, getCompany, listCompanies } from "@/lib/crm/companies";
import { createContact, listContacts } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { moveFailure, moveRecordsToWorkspace, moveTargets, previewMoveToWorkspace } from "@/lib/crm/move-workspace";
import { createOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { listTags } from "@/lib/crm/tags";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { createWebhook } from "@/lib/crm/webhooks";
import { describeUndo } from "@/lib/crm/undo";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const PROVENANCE = { operation: "move_test", source: "test" };

let eclipse: UserActor;
let ridgeon: UserActor;
let priya: UserActor;
let outsider: UserActor;

async function admin<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const result = await getAdminPool().query<T>(text, values);
  return result.rows;
}

async function company(actor: UserActor, name: string, extra: Record<string, unknown> = {}) {
  return (await createCompany(actor, { name, ...extra }, { provenance: PROVENANCE })).body.company;
}

async function contact(actor: UserActor, input: Record<string, unknown>) {
  return (await createContact(actor, input, { provenance: PROVENANCE })).body.contact;
}

async function proposal(actor: UserActor, companyId: string, contactId: string, title: string) {
  const rows = await admin<{ id: string }>(
    "insert into crm.documents (workspace_id, kind, title, company_id, contact_id, owner_id) values ($1, 'proposal', $2, $3, $4, $5) returning id",
    [actor.workspaceId, title, companyId, contactId, actor.userId],
  );
  return rows[0].id;
}

async function stageId(actor: UserActor, name: string, pipelineId: string | null = null) {
  const pipeline = await listPipeline(actor, pipelineId);
  const stage = pipeline.stages.find((item) => item.name === name);
  assert.ok(stage, `No stage called ${name}`);
  return { pipelineId: pipeline.id, stageId: stage.id };
}

function refused(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

async function crossWorkspaceLinks() {
  return admin<{ link: string; id: string }>(
    `select 'contact.company' as link, x.id from crm.contacts x join crm.companies r on r.id = x.company_id where r.workspace_id <> x.workspace_id
     union all select 'deal.company', x.id from crm.opportunities x join crm.companies r on r.id = x.company_id where r.workspace_id <> x.workspace_id
     union all select 'deal.primary_contact', x.id from crm.opportunities x join crm.contacts r on r.id = x.primary_contact_id where r.workspace_id <> x.workspace_id
     union all select 'activity.company', x.id from crm.activities x join crm.companies r on r.id = x.company_id where r.workspace_id <> x.workspace_id
     union all select 'activity.contact', x.id from crm.activities x join crm.contacts r on r.id = x.contact_id where r.workspace_id <> x.workspace_id
     union all select 'activity.deal', x.id from crm.activities x join crm.opportunities r on r.id = x.opportunity_id where r.workspace_id <> x.workspace_id
     union all select 'task.company', x.id from crm.tasks x join crm.companies r on r.id = x.company_id where r.workspace_id <> x.workspace_id
     union all select 'task.contact', x.id from crm.tasks x join crm.contacts r on r.id = x.contact_id where r.workspace_id <> x.workspace_id
     union all select 'task.deal', x.id from crm.tasks x join crm.opportunities r on r.id = x.opportunity_id where r.workspace_id <> x.workspace_id
     union all select 'document.company', x.id from crm.documents x join crm.companies r on r.id = x.company_id where r.workspace_id <> x.workspace_id
     union all select 'document.contact', x.id from crm.documents x join crm.contacts r on r.id = x.contact_id where r.workspace_id <> x.workspace_id
     union all select 'document.deal', x.id from crm.documents x join crm.opportunities r on r.id = x.opportunity_id where r.workspace_id <> x.workspace_id
     union all select 'company.health_activity', x.id from crm.companies x join crm.activities r on r.id = x.health_activity_id where r.workspace_id <> x.workspace_id
     union all select 'call_insight.company', x.id from crm.call_insights x join crm.companies r on r.id = x.company_id where r.workspace_id <> x.workspace_id
     union all select 'call_insight.contact', x.id from crm.call_insights x join crm.contacts r on r.id = x.contact_id where r.workspace_id <> x.workspace_id
     union all select 'follow_up.company', x.id from crm.follow_up_suggestions x join crm.companies r on r.id = x.company_id where r.workspace_id <> x.workspace_id
     union all select 'follow_up.contact', x.id from crm.follow_up_suggestions x join crm.contacts r on r.id = x.contact_id where r.workspace_id <> x.workspace_id`,
  );
}

before(async () => {
  await resetDatabase();
  const mark = await createUser("mark@eclipse-move.test", "Mark Ridgeon");
  await admin("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
  eclipse = { ...mark, workspaceName: "Eclipse" };
  const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
  ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
  const second = await createUser("priya@eclipse-move.test", "Priya Shah");
  await admin("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [eclipse.workspaceId, second.userId]);
  await admin("delete from crm.workspace_members where user_id = $1 and workspace_id <> $2", [second.userId, eclipse.workspaceId]);
  priya = { ...second, workspaceId: eclipse.workspaceId, workspaceName: "Eclipse", role: "member", scopes: scopesForRole("member") };
  outsider = await createUser("oscar@elsewhere-move.test", "Oscar Outsider");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("moving records to another workspace", () => {
  it("moves a company with its contacts, deals, activities and tasks, and leaves its boards", async () => {
    const acme = await company(eclipse, "Acme", { domain: "acme-move.test", tags: ["client"] });
    const jane = await contact(eclipse, { firstName: "Jane", lastName: "Doe", email: "jane@acme-move.test", companyId: acme.id });
    const sam = await contact(eclipse, { firstName: "Sam", lastName: "Hill", companyId: acme.id });
    const working = await stageId(eclipse, "Working");
    const deal = (await createOpportunity(eclipse, { companyId: acme.id, name: "Acme rollout", primaryContactId: jane.id, stageId: working.stageId }, { provenance: PROVENANCE })).body.opportunity;
    const board = await createBoard(eclipse, { name: "Onboarding" });
    const card = (await createOpportunity(eclipse, { companyId: acme.id, name: "Acme", pipelineId: board.id }, { provenance: PROVENANCE })).body.opportunity;
    const task = (await createTask(eclipse, { title: "Send pricing", companyId: acme.id, contactId: jane.id }, { provenance: PROVENANCE })).body.task;
    await logActivity(eclipse, { companyId: acme.id, contactId: jane.id }, "note", "", "Intro call went well");
    await logActivity(eclipse, { contactId: sam.id }, "note", "", "Sam asked for a deck");

    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [acme.id], workspaceId: ridgeon.workspaceId });
    assert.deepEqual(preview.names, ["Acme"]);
    assert.equal(preview.contacts, 2);
    assert.equal(preview.deals, 1);
    assert.equal(preview.activities, 2);
    assert.equal(preview.tasks, 1);
    assert.deepEqual(preview.boards, ["Onboarding"]);
    assert.ok(preview.pipelines.length >= 1);

    const result = await moveRecordsToWorkspace(eclipse, { companyIds: [acme.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    assert.equal(result.message, "Moved Acme to Mark Ridgeon.");
    assert.equal(result.companies[0].targetId, acme.id);

    const rows = await admin<{ kind: string; workspace_id: string }>(
      `select 'company' as kind, workspace_id from crm.companies where id = $1
       union all select 'contact', workspace_id from crm.contacts where id = any($2::uuid[])
       union all select 'deal', workspace_id from crm.opportunities where id = $3
       union all select 'task', workspace_id from crm.tasks where id = $4
       union all select 'activity', workspace_id from crm.activities where company_id = $1 or contact_id = any($2::uuid[])`,
      [acme.id, [jane.id, sam.id], deal.id, task.id],
    );
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.workspace_id === ridgeon.workspaceId), JSON.stringify(rows));

    const target = await stageId(ridgeon, "Working");
    const placed = await admin<{ pipeline_id: string; stage_id: string; primary_contact_id: string }>(
      "select pipeline_id, stage_id, primary_contact_id from crm.opportunities where id = $1",
      [deal.id],
    );
    assert.deepEqual(placed[0], { pipeline_id: target.pipelineId, stage_id: target.stageId, primary_contact_id: jane.id });
    const cards = await admin("select 1 from crm.opportunities where id = $1", [card.id]);
    assert.equal(cards.length, 0);
  });

  it("hides moved rows from the source workspace", async () => {
    const listed = await listCompanies(eclipse, { query: "Acme" });
    assert.equal(listed.data.length, 0);
    await assert.rejects(getCompany(eclipse, (await listCompanies(ridgeon, { query: "Acme" })).data[0].id), refused("not_found"));
    const people = await listContacts(eclipse, { query: "Jane" });
    assert.equal(people.data.length, 0);
    const seen = await queryAsUser<{ name: string }>(priya.userId, "select name from crm.companies where name = 'Acme'");
    assert.equal(seen.length, 0);
    const there = await listCompanies(ridgeon, { query: "Acme" });
    assert.deepEqual(there.data.map((item) => item.name), ["Acme"]);
  });

  it("records moved events in both workspaces and never a created event", async () => {
    const acme = (await listCompanies(ridgeon, { query: "Acme" })).data[0];
    const events = await admin<{ workspace_id: string; event_type: string }>(
      "select workspace_id, event_type from crm.audit_events where entity_id = $1 and event_type <> 'company.created' and created_at > now() - interval '1 hour' order by event_type",
      [acme.id],
    );
    assert.deepEqual(
      events.filter((event) => event.event_type.includes("moved")).map((event) => [event.event_type, event.workspace_id]),
      [
        ["company.moved_in", ridgeon.workspaceId],
        ["company.moved_out", eclipse.workspaceId],
      ],
    );
    const created = await admin(
      "select 1 from crm.audit_events where workspace_id = $1 and event_type in ('company.created', 'contact.created', 'lead.created', 'opportunity.created')",
      [ridgeon.workspaceId],
    );
    assert.equal(created.length, 0);
    const triggers = await admin("select 1 from crm.workflow_events where workspace_id = $1 and 'record_created' = any(trigger_types)", [ridgeon.workspaceId]);
    assert.equal(triggers.length, 0);
    const contacts = await admin<{ event_type: string }>(
      "select event_type from crm.audit_events where workspace_id = $1 and event_type = 'contact.moved_in'",
      [ridgeon.workspaceId],
    );
    assert.equal(contacts.length, 2);
  });

  it("sends moved webhooks, not created ones", async () => {
    await createWebhook(ridgeon, { url: "https://hooks.example.com/orbit", events: ["*"] }, { lookup: async () => ["93.184.215.14"] });
    const beta = await company(eclipse, "Beta Works", { domain: "beta-move.test" });
    await moveRecordsToWorkspace(eclipse, { companyIds: [beta.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    const deliveries = await admin<{ event_type: string }>(
      "select event_type from crm.webhook_deliveries where workspace_id = $1 order by event_type",
      [ridgeon.workspaceId],
    );
    assert.deepEqual(deliveries.map((row) => row.event_type), ["company.moved_in"]);
  });

  it("links a contact to the company the target already has, and leaves the source company", async () => {
    const source = await company(eclipse, "Northwind", { domain: "northwind-move.test" });
    const ann = await contact(eclipse, { firstName: "Ann", lastName: "Lee", email: "ann@northwind-move.test", companyId: source.id });
    const bob = await contact(eclipse, { firstName: "Bob", lastName: "Ray", companyId: source.id });
    await logActivity(eclipse, { companyId: source.id, contactId: ann.id }, "note", "", "Ann wants a demo");
    const there = await company(ridgeon, "Northwind Trading", { domain: "northwind-move.test" });

    const preview = await previewMoveToWorkspace(eclipse, { contactIds: [ann.id], workspaceId: ridgeon.workspaceId, includeCompany: false });
    assert.deepEqual(preview.links, [{ name: "Northwind", into: "Northwind Trading", matched: true }]);

    await moveRecordsToWorkspace(eclipse, { contactIds: [ann.id], workspaceId: ridgeon.workspaceId, includeCompany: false }, PROVENANCE);
    const moved = await admin<{ workspace_id: string; company_id: string }>("select workspace_id, company_id from crm.contacts where id = $1", [ann.id]);
    assert.deepEqual(moved[0], { workspace_id: ridgeon.workspaceId, company_id: there.id });
    const stayed = await admin<{ workspace_id: string }>(
      "select workspace_id from crm.companies where id = $1 union all select workspace_id from crm.contacts where id = $2",
      [source.id, bob.id],
    );
    assert.ok(stayed.every((row) => row.workspace_id === eclipse.workspaceId));
    const note = await admin<{ workspace_id: string; company_id: string }>(
      "select workspace_id, company_id from crm.activities where contact_id = $1",
      [ann.id],
    );
    assert.deepEqual(note[0], { workspace_id: ridgeon.workspaceId, company_id: there.id });
  });

  it("brings a contact's company along when nobody else works there", async () => {
    const solo = await company(eclipse, "Solo Studio", { domain: "solo-move.test" });
    const zoe = await contact(eclipse, { firstName: "Zoe", lastName: "King", companyId: solo.id });
    const preview = await previewMoveToWorkspace(eclipse, { contactIds: [zoe.id], workspaceId: ridgeon.workspaceId, includeCompany: false });
    assert.deepEqual(preview.companiesAlong, ["Solo Studio"]);
    await moveRecordsToWorkspace(eclipse, { contactIds: [zoe.id], workspaceId: ridgeon.workspaceId, includeCompany: false }, PROVENANCE);
    const rows = await admin<{ workspace_id: string }>(
      "select workspace_id from crm.companies where id = $1 union all select workspace_id from crm.contacts where id = $2",
      [solo.id, zoe.id],
    );
    assert.ok(rows.every((row) => row.workspace_id === ridgeon.workspaceId));
  });

  it("copies a contact's company when colleagues stay behind, and takes the proposal named to them", async () => {
    const shared = await company(eclipse, "Shared Ltd", { domain: "shared-move.test", industry: "Retail" });
    const ian = await contact(eclipse, { firstName: "Ian", lastName: "Ward", companyId: shared.id });
    const kim = await contact(eclipse, { firstName: "Kim", lastName: "Ward", companyId: shared.id });
    const ianProposal = await proposal(eclipse, shared.id, ian.id, "Proposal for Ian");
    const kimProposal = await proposal(eclipse, shared.id, kim.id, "Proposal for Kim");
    await moveRecordsToWorkspace(eclipse, { contactIds: [ian.id], workspaceId: ridgeon.workspaceId, includeCompany: false }, PROVENANCE);
    const copy = await admin<{ id: string; industry: string }>(
      "select id, industry from crm.companies where workspace_id = $1 and domain = 'shared-move.test'",
      [ridgeon.workspaceId],
    );
    assert.equal(copy.length, 1);
    assert.notEqual(copy[0].id, shared.id);
    assert.equal(copy[0].industry, "Retail");
    const ianRow = await admin<{ company_id: string }>("select company_id from crm.contacts where id = $1", [ian.id]);
    assert.equal(ianRow[0].company_id, copy[0].id);
    const original = await admin<{ workspace_id: string }>("select workspace_id from crm.companies where id = $1", [shared.id]);
    assert.equal(original[0].workspace_id, eclipse.workspaceId);
    const documents = await admin<{ id: string; workspace_id: string; company_id: string; contact_id: string }>(
      "select id, workspace_id, company_id, contact_id from crm.documents where id = any($1::uuid[]) order by title",
      [[ianProposal, kimProposal]],
    );
    assert.deepEqual(documents, [
      { id: ianProposal, workspace_id: ridgeon.workspaceId, company_id: copy[0].id, contact_id: ian.id },
      { id: kimProposal, workspace_id: eclipse.workspaceId, company_id: shared.id, contact_id: kim.id },
    ]);
    const events = await admin<{ event_type: string; workspace_id: string }>(
      "select event_type, workspace_id from crm.audit_events where entity_id = any($1::uuid[]) and event_type <> 'company.created' or (entity_id = $2 and event_type = 'company.created') order by event_type",
      [[shared.id], copy[0].id],
    );
    assert.deepEqual(events.map((row) => [row.event_type, row.workspace_id]), [
      ["company.copied", eclipse.workspaceId],
      ["company.created", ridgeon.workspaceId],
    ]);
  });

  it("moves a proposal with a contact whose company the target already has", async () => {
    const source = await company(eclipse, "Linked Co", { domain: "linked-move.test", industry: "Media" });
    const lena = await contact(eclipse, { firstName: "Lena", lastName: "Park", companyId: source.id });
    await contact(eclipse, { firstName: "Leo", lastName: "Park", companyId: source.id });
    const document = await proposal(eclipse, source.id, lena.id, "Proposal for Lena");
    const there = await company(ridgeon, "Linked Company", { domain: "linked-move.test" });
    await moveRecordsToWorkspace(eclipse, { contactIds: [lena.id], workspaceId: ridgeon.workspaceId, includeCompany: false }, PROVENANCE);
    const row = await admin<{ workspace_id: string; company_id: string; contact_id: string }>(
      "select workspace_id, company_id, contact_id from crm.documents where id = $1",
      [document],
    );
    assert.deepEqual(row[0], { workspace_id: ridgeon.workspaceId, company_id: there.id, contact_id: lena.id });
    const filled = await admin<{ industry: string }>("select industry from crm.companies where id = $1", [there.id]);
    assert.equal(filled[0].industry, "Media");
    const updated = await admin("select 1 from crm.audit_events where entity_id = $1 and event_type = 'company.updated'", [there.id]);
    assert.equal(updated.length, 1);
  });

  it("copies an archived company as archived when a contact there moves", async () => {
    const gone = await company(eclipse, "Gone Ltd", { domain: "gone-move.test" });
    const gail = await contact(eclipse, { firstName: "Gail", lastName: "Gone", companyId: gone.id });
    await contact(eclipse, { firstName: "Gus", lastName: "Gone", companyId: gone.id });
    await admin("update crm.companies set archived_at = now() where id = $1", [gone.id]);
    await moveRecordsToWorkspace(eclipse, { contactIds: [gail.id], workspaceId: ridgeon.workspaceId, includeCompany: false }, PROVENANCE);
    const copy = await admin<{ archived: boolean }>(
      "select archived_at is not null as archived from crm.companies where workspace_id = $1 and domain = 'gone-move.test'",
      [ridgeon.workspaceId],
    );
    assert.deepEqual(copy, [{ archived: true }]);
  });

  it("merges into a duplicate in the target, filling gaps without overwriting", async () => {
    const source = await company(eclipse, "Globex", {
      domain: "globex-move.test",
      industry: "Energy",
      description: "From Eclipse",
      tags: ["energy"],
    });
    const carl = await contact(eclipse, { firstName: "Carl", lastName: "Fox", email: "carl@globex-move.test", phone: "+44 20 7946 0000", companyId: source.id });
    await logActivity(eclipse, { companyId: source.id, contactId: carl.id }, "note", "", "Carl signed the NDA");
    const keep = await company(ridgeon, "Globex Corporation", { domain: "globex-move.test", description: "Already here", tags: ["vip"] });
    const keepCarl = await contact(ridgeon, { firstName: "Carl", email: "carl@globex-move.test", companyId: keep.id });

    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [source.id], workspaceId: ridgeon.workspaceId });
    assert.deepEqual(preview.merges, [
      { name: "Globex", into: "Globex Corporation" },
      { name: "Carl Fox", into: "Carl" },
    ]);

    const result = await moveRecordsToWorkspace(eclipse, { companyIds: [source.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    assert.deepEqual(result.companies, [{ id: source.id, name: "Globex", targetId: keep.id, merged: true }]);

    const kept = await admin<{ name: string; industry: string; description: string; tags: string[] }>(
      "select name, industry, description, tags from crm.companies where id = $1",
      [keep.id],
    );
    assert.deepEqual(kept[0], { name: "Globex Corporation", industry: "Energy", description: "Already here", tags: ["vip", "energy"] });
    const keptCarl = await admin<{ last_name: string; phone: string }>("select last_name, phone from crm.contacts where id = $1", [keepCarl.id]);
    assert.deepEqual(keptCarl[0], { last_name: "Fox", phone: "+44 20 7946 0000" });
    const merged = await admin<{ workspace_id: string; archived: boolean }>(
      "select workspace_id, archived_at is not null as archived from crm.companies where id = $1",
      [source.id],
    );
    assert.deepEqual(merged[0], { workspace_id: ridgeon.workspaceId, archived: true });
    const note = await admin<{ company_id: string; contact_id: string }>(
      "select company_id, contact_id from crm.activities where body = 'Carl signed the NDA'",
    );
    assert.deepEqual(note[0], { company_id: keep.id, contact_id: keepCarl.id });
    const event = await admin<{ changes: { merged: boolean; filled: string[] } }>(
      "select changes from crm.audit_events where event_type = 'company.moved_in' and entity_id = $1",
      [keep.id],
    );
    assert.equal(event[0].changes.merged, true);
    assert.ok(event[0].changes.filled.includes("industry"));
    const active = await listCompanies(ridgeon, { query: "Globex" });
    assert.deepEqual(active.data.map((item) => item.name), ["Globex Corporation"]);
  });

  it("copies a company and leaves the source as it was", async () => {
    const initech = await company(eclipse, "Initech", { domain: "initech-move.test", tags: ["software"] });
    const peter = await contact(eclipse, { firstName: "Peter", lastName: "Gibbons", companyId: initech.id });
    await createOpportunity(eclipse, { companyId: initech.id, name: "Initech licences" }, { provenance: PROVENANCE });
    await logActivity(eclipse, { companyId: initech.id, contactId: peter.id }, "note", "", "TPS reports");

    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [initech.id], workspaceId: ridgeon.workspaceId, copy: true });
    assert.equal(preview.deals, 0);
    assert.equal(preview.dealsAvailable, 1);

    const result = await moveRecordsToWorkspace(eclipse, { companyIds: [initech.id], workspaceId: ridgeon.workspaceId, copy: true }, PROVENANCE);
    assert.equal(result.message, "Copied Initech to Mark Ridgeon.");
    const copyId = result.companies[0].targetId;
    assert.notEqual(copyId, initech.id);

    const source = await admin<{ workspace_id: string; contacts: number; activities: number; deals: number }>(
      `select c.workspace_id,
         (select count(*)::int from crm.contacts p where p.company_id = c.id and p.workspace_id = c.workspace_id) as contacts,
         (select count(*)::int from crm.activities a where a.company_id = c.id and a.workspace_id = c.workspace_id) as activities,
         (select count(*)::int from crm.opportunities o where o.company_id = c.id and o.workspace_id = c.workspace_id) as deals
       from crm.companies c where c.id = $1`,
      [initech.id],
    );
    assert.deepEqual(source[0], { workspace_id: eclipse.workspaceId, contacts: 1, activities: 1, deals: 1 });
    const target = await admin<{ workspace_id: string; contacts: number; activities: number; deals: number }>(
      `select c.workspace_id,
         (select count(*)::int from crm.contacts p where p.company_id = c.id) as contacts,
         (select count(*)::int from crm.activities a where a.company_id = c.id) as activities,
         (select count(*)::int from crm.opportunities o where o.company_id = c.id) as deals
       from crm.companies c where c.id = $1`,
      [copyId],
    );
    assert.deepEqual(target[0], { workspace_id: ridgeon.workspaceId, contacts: 1, activities: 1, deals: 0 });
    const events = await admin<{ event_type: string; workspace_id: string; copied_from: string | null }>(
      `select event_type, workspace_id, changes -> 'copiedFrom' ->> 'id' as copied_from from crm.audit_events
       where (entity_id = $1 and event_type = 'company.copied') or (entity_id = $2 and event_type = 'company.created')
       order by event_type`,
      [initech.id, copyId],
    );
    assert.deepEqual(events, [
      { event_type: "company.copied", workspace_id: eclipse.workspaceId, copied_from: null },
      { event_type: "company.created", workspace_id: ridgeon.workspaceId, copied_from: initech.id },
    ]);
  });

  it("copies deals too when asked", async () => {
    const hooli = await company(eclipse, "Hooli", { domain: "hooli-move.test" });
    await createOpportunity(eclipse, { companyId: hooli.id, name: "Hooli pilot" }, { provenance: PROVENANCE });
    const result = await moveRecordsToWorkspace(eclipse, { companyIds: [hooli.id], workspaceId: ridgeon.workspaceId, copy: true, copyDeals: true }, PROVENANCE);
    const deals = await admin<{ name: string; workspace_id: string }>("select name, workspace_id from crm.opportunities where company_id = $1", [result.companies[0].targetId]);
    assert.deepEqual(deals, [{ name: "Hooli pilot", workspace_id: ridgeon.workspaceId }]);
    const original = await admin("select 1 from crm.opportunities where company_id = $1 and workspace_id = $2", [hooli.id, eclipse.workspaceId]);
    assert.equal(original.length, 1);
  });

  it("creates the moved tags in the target", async () => {
    const before = (await listTags(ridgeon)).map((tag) => tag.name);
    assert.ok(!before.includes("fintech"));
    const monzo = await company(eclipse, "Monzo", { domain: "monzo-move.test", tags: ["fintech", "uk"] });
    await moveRecordsToWorkspace(eclipse, { companyIds: [monzo.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    const after = (await listTags(ridgeon)).map((tag) => tag.name);
    assert.ok(after.includes("fintech"));
    assert.ok(after.includes("uk"));
  });

  it("puts deals on the chosen board and stage", async () => {
    const umbrella = await company(eclipse, "Umbrella", { domain: "umbrella-move.test" });
    const first = await createOpportunity(eclipse, { companyId: umbrella.id, name: "Umbrella phase one" }, { provenance: PROVENANCE });
    const second = await createOpportunity(eclipse, { companyId: umbrella.id, name: "Umbrella phase two" }, { provenance: PROVENANCE });
    const proposal = await stageId(ridgeon, "Proposal");
    const board = await createBoard(ridgeon, { name: "Partners" });
    await assert.rejects(
      moveRecordsToWorkspace(eclipse, { companyIds: [umbrella.id], workspaceId: ridgeon.workspaceId, pipelineId: board.id }, PROVENANCE),
      refused("invalid_input", /more than one card on Partners/),
    );
    await moveRecordsToWorkspace(
      eclipse,
      { companyIds: [umbrella.id], workspaceId: ridgeon.workspaceId, pipelineId: proposal.pipelineId, stageId: proposal.stageId },
      PROVENANCE,
    );
    const deals = await admin<{ stage_id: string; status: string; workspace_id: string }>(
      "select stage_id, status, workspace_id from crm.opportunities where id = any($1::uuid[])",
      [[first.body.opportunity.id, second.body.opportunity.id]],
    );
    assert.equal(deals.length, 2);
    assert.ok(deals.every((row) => row.stage_id === proposal.stageId && row.status === "open" && row.workspace_id === ridgeon.workspaceId));
  });

  it("refuses a workspace the person isn't in", async () => {
    const stays = await company(eclipse, "Stays Put", { domain: "stays-move.test" });
    await assert.rejects(
      moveRecordsToWorkspace(eclipse, { companyIds: [stays.id], workspaceId: outsider.workspaceId }, PROVENANCE),
      refused("forbidden", /No workspace called/),
    );
    await assert.rejects(
      previewMoveToWorkspace(eclipse, { companyIds: [stays.id], workspaceId: outsider.workspaceId }),
      refused("forbidden"),
    );
    const forged = { ...eclipse, workspaceId: outsider.workspaceId, workspaceName: "Elsewhere" };
    await assert.rejects(
      moveRecordsToWorkspace(forged, { companyIds: [stays.id], workspaceId: ridgeon.workspaceId }, PROVENANCE),
      (error: unknown) => error instanceof CrmError && error.status === 403,
    );
    const row = await admin<{ workspace_id: string }>("select workspace_id from crm.companies where id = $1", [stays.id]);
    assert.equal(row[0].workspace_id, eclipse.workspaceId);
  });

  it("offers nothing to someone in one workspace and refuses them on the server", async () => {
    assert.deepEqual(await moveTargets(priya), []);
    assert.deepEqual(
      (await moveTargets(eclipse)).map((item) => item.name),
      ["Mark Ridgeon"],
    );
    const theirs = await company(priya, "Priya Prospect", { domain: "priya-move.test" });
    await assert.rejects(
      moveRecordsToWorkspace(priya, { companyIds: [theirs.id], workspaceId: ridgeon.workspaceId }, PROVENANCE),
      refused("forbidden", /only in one workspace/),
    );
    await assert.rejects(
      getAdminPool().query("select private.move_records_to_workspace($1, $2, $3, $4::jsonb)", [
        priya.userId,
        eclipse.workspaceId,
        ridgeon.workspaceId,
        JSON.stringify({ companyIds: [theirs.id] }),
      ]),
      /not in that workspace/,
    );
  });

  it("offers the assistant tool only to someone in more than one workspace", async () => {
    const names = (options: { multiWorkspace?: boolean }) => toolDefinitions(options).map((tool) => tool.function.name);
    assert.ok(names({ multiWorkspace: true }).includes("move_records_to_workspace"));
    assert.ok(!names({ multiWorkspace: false }).includes("move_records_to_workspace"));
    const solo = await runTool(priya, "move_records_to_workspace", { toWorkspace: "Mark Ridgeon", companyIds: [] });
    assert.match(String((solo as { error?: string }).error), /only in one workspace/);
  });

  it("moves through the assistant with a card that shows what goes, what merges and where deals land", async () => {
    const wayne = await company(eclipse, "Wayne Enterprises", { domain: "wayne-move.test" });
    await contact(eclipse, { firstName: "Bruce", lastName: "Wayne", email: "bruce@wayne-move.test", companyId: wayne.id });
    await contact(eclipse, { firstName: "Alfred", lastName: "Pennyworth", companyId: wayne.id });
    await createOpportunity(eclipse, { companyId: wayne.id, name: "Wayne deal" }, { provenance: PROVENANCE });
    await createTask(eclipse, { title: "Call Bruce", companyId: wayne.id }, { provenance: PROVENANCE });
    await logActivity(eclipse, { companyId: wayne.id }, "note", "", "Met at the gala");
    await contact(ridgeon, { firstName: "Bruce", email: "bruce@wayne-move.test" });
    const won = await stageId(ridgeon, "Won");
    const args = { toWorkspace: "ridgeon", companyIds: [wayne.id], pipelineId: won.pipelineId, stageId: won.stageId };
    assert.equal(await crossWorkspaceRefusal(eclipse, "move_records_to_workspace", args), null);
    const names = await recordNames(eclipse, [args], ["move_records_to_workspace"]);
    const card = describeAction("move_records_to_workspace", args, names);
    assert.equal(card.title, "Move to Mark Ridgeon: Wayne Enterprises");
    assert.ok(card.lines.includes("Move: they leave this workspace"), card.lines.join(" / "));
    assert.ok(card.lines.includes("Goes with them: 2 contacts, 1 opportunity, 1 task, 1 activity"), card.lines.join(" / "));
    assert.ok(card.lines.includes("Bruce Wayne merges into existing Bruce"), card.lines.join(" / "));
    assert.ok(card.lines.includes("Opportunities go to the pipeline, Won"), card.lines.join(" / "));
    const copyNames = await recordNames(eclipse, [{ ...args, copy: true }], ["move_records_to_workspace"]);
    const copyCard = describeAction("move_records_to_workspace", { ...args, copy: true }, copyNames);
    assert.equal(copyCard.title, "Copy to Mark Ridgeon: Wayne Enterprises");
    assert.ok(copyCard.lines.includes("Copies: 2 contacts, 1 activity"), copyCard.lines.join(" / "));

    const output = (await runTool(eclipse, "move_records_to_workspace", args)) as { message?: string; error?: string };
    assert.equal(output.error, undefined);
    assert.equal(output.message, "Moved Wayne Enterprises to Mark Ridgeon.");
    const deal = await admin<{ status: string; workspace_id: string }>("select status, workspace_id from crm.opportunities where company_id = $1", [wayne.id]);
    assert.deepEqual(deal, [{ status: "won", workspace_id: ridgeon.workspaceId }]);
    const event = await admin<{ changes: { deals: { name: string; stage: string }[] } }>(
      "select changes from crm.audit_events where entity_id = $1 and event_type = 'company.moved_in'",
      [wayne.id],
    );
    assert.deepEqual(
      event[0].changes.deals.map((item) => [item.name, item.stage]),
      [["Wayne deal", "Won"]],
    );
  });

  it("gives the MCP tool only to a person with another workspace", async () => {
    async function tools(actor: UserActor, workspaces: { id: string; name: string }[]) {
      const server = createCrmMcpServer(actor, { workspaces });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "move-test", version: "1.0.0" });
      await client.connect(clientSide);
      return { client, names: (await client.listTools()).tools.map((tool) => tool.name) };
    }
    const none = await tools(priya, await moveTargets(priya));
    assert.ok(!none.names.includes("move_records_to_workspace"));
    await none.client.close();
    const both = await tools(eclipse, await moveTargets(eclipse));
    assert.ok(both.names.includes("move_records_to_workspace"));
    const stark = await company(eclipse, "Stark Industries", { domain: "stark-move.test" });
    const dry = (await both.client.callTool({
      name: "move_records_to_workspace",
      arguments: { to_workspace: "Mark Ridgeon", company_ids: [stark.id], dry_run: true },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!dry.isError, dry.content[0].text);
    assert.deepEqual(JSON.parse(dry.content[0].text).names, ["Stark Industries"]);
    const still = await admin<{ workspace_id: string }>("select workspace_id from crm.companies where id = $1", [stark.id]);
    assert.equal(still[0].workspace_id, eclipse.workspaceId);
    const result = (await both.client.callTool({
      name: "move_records_to_workspace",
      arguments: { to_workspace: "Mark Ridgeon", company_ids: [stark.id], copy: true },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).message, "Copied Stark Industries to Mark Ridgeon.");
    await both.client.close();
  });

  it("refuses deals on a board with no stages before changing anything", async () => {
    const empty = await company(eclipse, "Empty Board Co", { domain: "empty-board-move.test" });
    await createOpportunity(eclipse, { companyId: empty.id, name: "Empty deal" }, { provenance: PROVENANCE });
    const board = await createBoard(ridgeon, { name: "Stageless" });
    await admin("delete from crm.pipeline_stages where pipeline_id = $1", [board.id]);
    await assert.rejects(
      moveRecordsToWorkspace(eclipse, { companyIds: [empty.id], workspaceId: ridgeon.workspaceId, pipelineId: board.id }, PROVENANCE),
      refused("invalid_input", /Stageless has no stages/),
    );
    const row = await admin<{ workspace_id: string }>("select workspace_id from crm.companies where id = $1", [empty.id]);
    assert.equal(row[0].workspace_id, eclipse.workspaceId);
  });

  it("keeps won and lost deals closed when a stage is chosen, on a move and a copy", async () => {
    const chosen = await stageId(ridgeon, "Proposal");
    for (const copy of [false, true]) {
      const acme = await company(eclipse, `Closed Deals ${copy ? "Copy" : "Move"}`, { domain: `closed-${copy ? "copy" : "move"}-move.test` });
      const won = await stageId(eclipse, "Won");
      const lost = await stageId(eclipse, "Lost");
      await createOpportunity(eclipse, { companyId: acme.id, name: "Open one" }, { provenance: PROVENANCE });
      await createOpportunity(eclipse, { companyId: acme.id, name: "Won one", stageId: won.stageId }, { provenance: PROVENANCE });
      await createOpportunity(eclipse, { companyId: acme.id, name: "Lost one", stageId: lost.stageId }, { provenance: PROVENANCE });
      const result = await moveRecordsToWorkspace(
        eclipse,
        { companyIds: [acme.id], workspaceId: ridgeon.workspaceId, copy, copyDeals: copy, pipelineId: chosen.pipelineId, stageId: chosen.stageId },
        PROVENANCE,
      );
      const deals = await admin<{ name: string; stage: string; status: string }>(
        `select o.name, s.name as stage, o.status from crm.opportunities o join crm.pipeline_stages s on s.id = o.stage_id
         where o.company_id = $1 and o.workspace_id = $2 order by o.name`,
        [result.companies[0].targetId, ridgeon.workspaceId],
      );
      assert.deepEqual(deals, [
        { name: "Lost one", stage: "Lost", status: "lost" },
        { name: "Open one", stage: "Proposal", status: "open" },
        { name: "Won one", stage: "Won", status: "won" },
      ]);
    }
  });

  it("clears the source's AI answers and web signals for a moved company", async () => {
    const signals = await company(eclipse, "Signals Co", { domain: "signals-move.test" });
    const field = await admin<{ id: string }>(
      "insert into crm.ai_fields (workspace_id, label, question, kind) values ($1, 'Sells GEO', 'Do they sell GEO?', 'yes_no') returning id",
      [eclipse.workspaceId],
    );
    await admin("insert into crm.ai_field_answers (field_id, company_id, workspace_id, state, value_bool) values ($1, $2, $3, 'answered', true)", [
      field[0].id,
      signals.id,
      eclipse.workspaceId,
    ]);
    const check = await admin<{ id: string }>(
      "insert into crm.web_checks (workspace_id, kind, label, question) values ($1, 'signal', 'Hiring', 'Are they hiring?') returning id",
      [eclipse.workspaceId],
    );
    await admin("insert into crm.company_signals (workspace_id, company_id, check_id, probability) values ($1, $2, $3, 0.9)", [
      eclipse.workspaceId,
      signals.id,
      check[0].id,
    ]);
    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [signals.id], workspaceId: ridgeon.workspaceId });
    assert.deepEqual(preview.aiFields, ["Sells GEO"]);
    await moveRecordsToWorkspace(eclipse, { companyIds: [signals.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    const left = await admin<{ answers: number; signals: number }>(
      `select (select count(*)::int from crm.ai_field_answers where company_id = $1) as answers,
              (select count(*)::int from crm.company_signals where company_id = $1) as signals`,
      [signals.id],
    );
    assert.deepEqual(left[0], { answers: 0, signals: 0 });
  });

  it("lets only owners and admins of the source move, while members of both can copy", async () => {
    const memberId = (await createUser("mo@eclipse-move.test", "Mo Member")).userId;
    await admin("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($3, $2, 'member')", [
      eclipse.workspaceId,
      memberId,
      ridgeon.workspaceId,
    ]);
    const member: UserActor = { ...priya, userId: memberId, email: "mo@eclipse-move.test", fullName: "Mo Member", workspaceId: eclipse.workspaceId, workspaceName: "Eclipse", role: "member", scopes: scopesForRole("member") };
    const theirs = await company(eclipse, "Member Pick", { domain: "member-pick-move.test" });
    const preview = await previewMoveToWorkspace(member, { companyIds: [theirs.id], workspaceId: ridgeon.workspaceId });
    assert.equal(preview.canMove, false);
    await assert.rejects(
      moveRecordsToWorkspace(member, { companyIds: [theirs.id], workspaceId: ridgeon.workspaceId }, PROVENANCE),
      refused("forbidden", /Only owners and admins can move records out of Eclipse\. Copy them instead\./),
    );
    await assert.rejects(
      getAdminPool().query("select private.move_records_to_workspace($1, $2, $3, $4::jsonb)", [
        memberId,
        eclipse.workspaceId,
        ridgeon.workspaceId,
        JSON.stringify({ companyIds: [theirs.id] }),
      ]),
      /Only an owner or admin/,
    );
    const copied = await moveRecordsToWorkspace(member, { companyIds: [theirs.id], workspaceId: ridgeon.workspaceId, copy: true }, PROVENANCE);
    assert.equal(copied.message, "Copied Member Pick to Mark Ridgeon.");
  });

  it("keeps the company on activities and tasks that were on a removed board card", async () => {
    const carded = await company(eclipse, "Carded Co", { domain: "carded-move.test" });
    const board = await createBoard(eclipse, { name: "Carded board" });
    const card = (await createOpportunity(eclipse, { companyId: carded.id, name: "Carded", pipelineId: board.id }, { provenance: PROVENANCE })).body.opportunity;
    const activity = await admin<{ id: string }>(
      "insert into crm.activities (workspace_id, type, title, body, opportunity_id) values ($1, 'note', '', 'Card note', $2) returning id",
      [eclipse.workspaceId, card.id],
    );
    const task = await admin<{ id: string }>(
      "insert into crm.tasks (workspace_id, title, opportunity_id, owner_id) values ($1, 'Card task', $2, $3) returning id",
      [eclipse.workspaceId, card.id, eclipse.userId],
    );
    await moveRecordsToWorkspace(eclipse, { companyIds: [carded.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    const rows = await admin<{ workspace_id: string; company_id: string; opportunity_id: string | null }>(
      `select workspace_id, company_id, opportunity_id from crm.activities where id = $1
       union all select workspace_id, company_id, opportunity_id from crm.tasks where id = $2`,
      [activity[0].id, task[0].id],
    );
    assert.deepEqual(rows, [
      { workspace_id: ridgeon.workspaceId, company_id: carded.id, opportunity_id: null },
      { workspace_id: ridgeon.workspaceId, company_id: carded.id, opportunity_id: null },
    ]);
    const event = await admin<{ changes: { boardCardsRemoved: number } }>(
      "select changes from crm.audit_events where entity_id = $1 and event_type = 'company.moved_out'",
      [carded.id],
    );
    assert.equal(event[0].changes.boardCardsRemoved, 1);
  });

  it("moves a contact with their company and its other contacts by default", async () => {
    const tandem = await company(eclipse, "Tandem", { domain: "tandem-move.test" });
    const tia = await contact(eclipse, { firstName: "Tia", lastName: "Tandem", companyId: tandem.id });
    const tom = await contact(eclipse, { firstName: "Tom", lastName: "Tandem", companyId: tandem.id });
    const deal = (await createOpportunity(eclipse, { companyId: tandem.id, name: "Tandem deal", primaryContactId: tom.id }, { provenance: PROVENANCE })).body.opportunity;
    await logActivity(eclipse, { companyId: tandem.id, contactId: tom.id }, "note", "", "Tom liked the demo");

    const preview = await previewMoveToWorkspace(eclipse, { contactIds: [tia.id], workspaceId: ridgeon.workspaceId });
    assert.deepEqual(preview.contactCompanies, [{ name: "Tandem", others: 1 }]);
    assert.deepEqual(preview.names, ["Tia Tandem"]);
    assert.deepEqual(preview.companiesAlong, ["Tandem"]);
    assert.equal(preview.contacts, 1);
    assert.equal(preview.deals, 1);
    assert.equal(preview.activities, 1);
    assert.deepEqual(preview.links, []);

    const alone = await previewMoveToWorkspace(eclipse, { contactIds: [tia.id], workspaceId: ridgeon.workspaceId, includeCompany: false });
    assert.deepEqual(alone.contactCompanies, [{ name: "Tandem", others: 1 }]);
    assert.deepEqual(alone.companiesAlong, []);
    assert.deepEqual(alone.links, [{ name: "Tandem", into: "Tandem", matched: false }]);
    assert.equal(alone.contacts, 0);
    assert.equal(alone.deals, 0);

    const result = await moveRecordsToWorkspace(eclipse, { contactIds: [tia.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    assert.equal(result.message, "Moved Tia Tandem, with Tandem and its 1 other contact, to Mark Ridgeon.");
    const rows = await admin<{ workspace_id: string }>(
      `select workspace_id from crm.companies where id = $1
       union all select workspace_id from crm.contacts where id = any($2::uuid[])
       union all select workspace_id from crm.opportunities where id = $3
       union all select workspace_id from crm.activities where contact_id = $4`,
      [tandem.id, [tia.id, tom.id], deal.id, tom.id],
    );
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.workspace_id === ridgeon.workspaceId), JSON.stringify(rows));
    const copies = await admin("select 1 from crm.companies where domain = 'tandem-move.test'");
    assert.equal(copies.length, 1);
    assert.deepEqual(await crossWorkspaceLinks(), []);
  });

  it("merges the company into the one the target has when a contact moves with it", async () => {
    const source = await company(eclipse, "Halcyon", { domain: "halcyon-move.test", industry: "Travel" });
    const hal = await contact(eclipse, { firstName: "Hal", lastName: "Cyon", companyId: source.id });
    const hana = await contact(eclipse, { firstName: "Hana", lastName: "Cyon", companyId: source.id });
    const there = await company(ridgeon, "Halcyon Group", { domain: "halcyon-move.test" });
    const preview = await previewMoveToWorkspace(eclipse, { contactIds: [hal.id], workspaceId: ridgeon.workspaceId });
    assert.deepEqual(preview.merges, [{ name: "Halcyon", into: "Halcyon Group" }]);
    await moveRecordsToWorkspace(eclipse, { contactIds: [hal.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    const people = await admin<{ workspace_id: string; company_id: string }>(
      "select workspace_id, company_id from crm.contacts where id = any($1::uuid[]) order by first_name",
      [[hal.id, hana.id]],
    );
    assert.deepEqual(people, [
      { workspace_id: ridgeon.workspaceId, company_id: there.id },
      { workspace_id: ridgeon.workspaceId, company_id: there.id },
    ]);
    const filled = await admin<{ industry: string }>("select industry from crm.companies where id = $1", [there.id]);
    assert.equal(filled[0].industry, "Travel");
    assert.deepEqual(await crossWorkspaceLinks(), []);
  });

  it("moves a company without its contacts, leaving them unlinked with their own activity and tasks", async () => {
    const keystone = await company(eclipse, "Keystone", { domain: "keystone-move.test" });
    const kay = await contact(eclipse, { firstName: "Kay", lastName: "Stone", email: "kay@keystone-move.test", companyId: keystone.id });
    const ken = await contact(eclipse, { firstName: "Ken", lastName: "Stone", companyId: keystone.id });
    const deal = (await createOpportunity(eclipse, { companyId: keystone.id, name: "Keystone deal", primaryContactId: kay.id }, { provenance: PROVENANCE })).body.opportunity;
    const board = await createBoard(eclipse, { name: "Keystone board" });
    const card = (await createOpportunity(eclipse, { companyId: keystone.id, name: "Keystone", pipelineId: board.id }, { provenance: PROVENANCE })).body.opportunity;
    const kayTask = (await createTask(eclipse, { title: "Call Kay", companyId: keystone.id, contactId: kay.id }, { provenance: PROVENANCE })).body.task;
    const companyTask = (await createTask(eclipse, { title: "Send the contract", companyId: keystone.id }, { provenance: PROVENANCE })).body.task;
    await logActivity(eclipse, { companyId: keystone.id, contactId: kay.id }, "note", "", "Kay wants a call");
    await logActivity(eclipse, { companyId: keystone.id }, "note", "", "Keystone raised a round");
    const onDeal = await admin<{ id: string }>(
      "insert into crm.activities (workspace_id, type, title, body, company_id, contact_id, opportunity_id) values ($1, 'note', '', 'Kay on the deal', $2, $3, $4) returning id",
      [eclipse.workspaceId, keystone.id, kay.id, deal.id],
    );
    const onCard = await admin<{ id: string }>(
      "insert into crm.activities (workspace_id, type, title, body, contact_id, opportunity_id) values ($1, 'note', '', 'Ken on the card', $2, $3) returning id",
      [eclipse.workspaceId, ken.id, card.id],
    );
    await admin("update crm.companies set health_activity_id = $1 where id = $2", [onDeal[0].id, keystone.id]);
    const pat = await contact(eclipse, { firstName: "Pat", lastName: "Stone", companyId: keystone.id });
    const document = await proposal(eclipse, keystone.id, pat.id, "Proposal for Pat");

    const together = await previewMoveToWorkspace(eclipse, { companyIds: [keystone.id], workspaceId: ridgeon.workspaceId });
    assert.equal(together.companyContacts, 3);
    assert.equal(together.contacts, 3);
    assert.deepEqual(together.leftBehind, []);

    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [keystone.id], workspaceId: ridgeon.workspaceId, includeContacts: false });
    assert.equal(preview.companyContacts, 3);
    assert.equal(preview.contacts, 1);
    assert.deepEqual(preview.leftBehind, ["Kay Stone", "Ken Stone"]);
    assert.deepEqual(preview.proposalContacts, ["Pat Stone"]);
    assert.equal(preview.deals, 1);
    assert.equal(preview.dealsLosingContact, 1);
    assert.equal(preview.activities, 1);
    assert.equal(preview.tasks, 1);
    assert.equal(preview.files, 1);

    const result = await moveRecordsToWorkspace(eclipse, { companyIds: [keystone.id], workspaceId: ridgeon.workspaceId, includeContacts: false }, PROVENANCE);
    assert.deepEqual(result.contacts.map((item) => item.name), ["Pat Stone"]);
    assert.deepEqual(result.leftBehind.map((item) => item.name), ["Kay Stone", "Ken Stone"]);

    const moved = await admin<{ workspace_id: string; health_activity_id: string | null }>(
      "select workspace_id, health_activity_id from crm.companies where id = $1",
      [keystone.id],
    );
    assert.deepEqual(moved[0], { workspace_id: ridgeon.workspaceId, health_activity_id: null });
    const people = await admin<{ workspace_id: string; company_id: string | null }>(
      "select workspace_id, company_id from crm.contacts where id = any($1::uuid[])",
      [[kay.id, ken.id]],
    );
    assert.deepEqual(people, [
      { workspace_id: eclipse.workspaceId, company_id: null },
      { workspace_id: eclipse.workspaceId, company_id: null },
    ]);
    const movedDeal = await admin<{ workspace_id: string; primary_contact_id: string | null }>(
      "select workspace_id, primary_contact_id from crm.opportunities where id = $1",
      [deal.id],
    );
    assert.deepEqual(movedDeal[0], { workspace_id: ridgeon.workspaceId, primary_contact_id: null });
    assert.equal((await admin("select 1 from crm.opportunities where id = $1", [card.id])).length, 0);
    const activities = await admin<{ body: string; workspace_id: string; company_id: string | null; contact_id: string | null; opportunity_id: string | null }>(
      "select body, workspace_id, company_id, contact_id, opportunity_id from crm.activities where id = any($1::uuid[]) or body in ('Kay wants a call', 'Keystone raised a round') order by body",
      [[onDeal[0].id, onCard[0].id]],
    );
    assert.deepEqual(activities, [
      { body: "Kay on the deal", workspace_id: eclipse.workspaceId, company_id: null, contact_id: kay.id, opportunity_id: null },
      { body: "Kay wants a call", workspace_id: eclipse.workspaceId, company_id: null, contact_id: kay.id, opportunity_id: null },
      { body: "Ken on the card", workspace_id: eclipse.workspaceId, company_id: null, contact_id: ken.id, opportunity_id: null },
      { body: "Keystone raised a round", workspace_id: ridgeon.workspaceId, company_id: keystone.id, contact_id: null, opportunity_id: null },
    ]);
    const tasks = await admin<{ title: string; workspace_id: string; company_id: string | null; contact_id: string | null }>(
      "select title, workspace_id, company_id, contact_id from crm.tasks where id = any($1::uuid[]) order by title",
      [[kayTask.id, companyTask.id]],
    );
    assert.deepEqual(tasks, [
      { title: "Call Kay", workspace_id: eclipse.workspaceId, company_id: null, contact_id: kay.id },
      { title: "Send the contract", workspace_id: ridgeon.workspaceId, company_id: keystone.id, contact_id: null },
    ]);
    const proposalRow = await admin<{ workspace_id: string; contact_id: string }>("select workspace_id, contact_id from crm.documents where id = $1", [document]);
    assert.deepEqual(proposalRow[0], { workspace_id: ridgeon.workspaceId, contact_id: pat.id });
    const patRow = await admin<{ workspace_id: string; company_id: string }>("select workspace_id, company_id from crm.contacts where id = $1", [pat.id]);
    assert.deepEqual(patRow[0], { workspace_id: ridgeon.workspaceId, company_id: keystone.id });
    assert.deepEqual(await crossWorkspaceLinks(), []);

    const events = await admin<{ id: string; entity_id: string; workspace_id: string; changes: { fields: string[]; before: { companyId: string }; after: { companyId: null } } }>(
      "select id, entity_id, workspace_id, changes from crm.audit_events where event_type = 'contact.updated' and entity_id = any($1::uuid[]) and changes ? 'companyMovedTo'",
      [[kay.id, ken.id]],
    );
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.workspace_id, eclipse.workspaceId);
      assert.deepEqual(event.changes.fields, ["companyId"]);
      assert.equal(event.changes.before.companyId, keystone.id);
      assert.equal(event.changes.after.companyId, null);
    }
    const undo = await describeUndo(eclipse, events[0].id);
    assert.equal(undo.canUndo, false);
    const movedOut = await admin("select 1 from crm.audit_events where event_type = 'contact.moved_out' and entity_id = any($1::uuid[])", [[kay.id, ken.id]]);
    assert.equal(movedOut.length, 0);
  });

  it("applies the same choices to copies", async () => {
    const vertex = await company(eclipse, "Vertex", { domain: "vertex-move.test" });
    const val = await contact(eclipse, { firstName: "Val", lastName: "Vertex", companyId: vertex.id });
    const vic = await contact(eclipse, { firstName: "Vic", lastName: "Vertex", companyId: vertex.id });
    await logActivity(eclipse, { companyId: vertex.id, contactId: val.id }, "note", "", "Val note");
    await logActivity(eclipse, { companyId: vertex.id }, "note", "", "Vertex note");

    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [vertex.id], workspaceId: ridgeon.workspaceId, copy: true, includeContacts: false });
    assert.equal(preview.contacts, 0);
    assert.deepEqual(preview.leftBehind, []);
    assert.deepEqual(preview.notCopied, ["Val Vertex", "Vic Vertex"]);
    assert.equal(preview.activities, 2);
    const alone = await moveRecordsToWorkspace(eclipse, { companyIds: [vertex.id], workspaceId: ridgeon.workspaceId, copy: true, includeContacts: false }, PROVENANCE);
    const copyId = alone.companies[0].targetId;
    const copied = await admin<{ contacts: number; activities: number }>(
      `select (select count(*)::int from crm.contacts where company_id = $1) as contacts,
              (select count(*)::int from crm.activities where company_id = $1) as activities`,
      [copyId],
    );
    assert.deepEqual(copied[0], { contacts: 0, activities: 2 });
    const valNote = await admin<{ contact_id: string | null }>("select contact_id from crm.activities where company_id = $1 and body = 'Val note'", [copyId]);
    assert.deepEqual(valNote, [{ contact_id: null }]);
    const source = await admin<{ workspace_id: string; company_id: string }>("select workspace_id, company_id from crm.contacts where id = any($1::uuid[])", [[val.id, vic.id]]);
    assert.ok(source.every((row) => row.workspace_id === eclipse.workspaceId && row.company_id === vertex.id));
    assert.equal((await admin("select 1 from crm.audit_events where event_type = 'contact.updated' and entity_id = any($1::uuid[])", [[val.id, vic.id]])).length, 0);

    const apex = await company(eclipse, "Apex Copy", { domain: "apex-copy-move.test" });
    const amy = await contact(eclipse, { firstName: "Amy", lastName: "Apex", email: "amy@apex-copy-move.test", companyId: apex.id });
    const art = await contact(eclipse, { firstName: "Art", lastName: "Apex", email: "art@apex-copy-move.test", companyId: apex.id });
    const withCompany = await moveRecordsToWorkspace(eclipse, { contactIds: [amy.id], workspaceId: ridgeon.workspaceId, copy: true }, PROVENANCE);
    assert.equal(withCompany.message, "Copied Amy Apex, with Apex Copy and its 1 other contact, to Mark Ridgeon.");
    const there = await admin<{ email: string; company_domain: string }>(
      `select p.email, c.domain as company_domain from crm.contacts p join crm.companies c on c.id = p.company_id
       where p.workspace_id = $1 and p.email in ('amy@apex-copy-move.test', 'art@apex-copy-move.test') order by p.email`,
      [ridgeon.workspaceId],
    );
    assert.deepEqual(there, [
      { email: "amy@apex-copy-move.test", company_domain: "apex-copy-move.test" },
      { email: "art@apex-copy-move.test", company_domain: "apex-copy-move.test" },
    ]);
    const kept = await admin<{ workspace_id: string }>("select workspace_id from crm.contacts where id = any($1::uuid[])", [[amy.id, art.id]]);
    assert.ok(kept.every((row) => row.workspace_id === eclipse.workspaceId));
    assert.deepEqual(await crossWorkspaceLinks(), []);
  });

  it("applies the choices once to a bulk move, with combined counts", async () => {
    const north = await company(eclipse, "Bulk North", { domain: "bulk-north-move.test" });
    const south = await company(eclipse, "Bulk South", { domain: "bulk-south-move.test" });
    const nia = await contact(eclipse, { firstName: "Nia", lastName: "North", companyId: north.id });
    const ned = await contact(eclipse, { firstName: "Ned", lastName: "North", companyId: north.id });
    const nat = await contact(eclipse, { firstName: "Nat", lastName: "North", companyId: north.id });
    const sue = await contact(eclipse, { firstName: "Sue", lastName: "South", companyId: south.id });
    const sid = await contact(eclipse, { firstName: "Sid", lastName: "South", companyId: south.id });

    const people = await previewMoveToWorkspace(eclipse, { contactIds: [nia.id, sue.id], workspaceId: ridgeon.workspaceId });
    assert.deepEqual(people.contactCompanies, [
      { name: "Bulk North", others: 2 },
      { name: "Bulk South", others: 1 },
    ]);
    assert.deepEqual(people.companiesAlong, ["Bulk North", "Bulk South"]);
    assert.equal(people.contacts, 3);

    const companies = await previewMoveToWorkspace(eclipse, { companyIds: [north.id, south.id], workspaceId: ridgeon.workspaceId, includeContacts: false });
    assert.equal(companies.companyContacts, 5);
    assert.deepEqual(companies.leftBehind, ["Nat North", "Ned North", "Nia North", "Sid South", "Sue South"]);

    const result = await moveRecordsToWorkspace(eclipse, { companyIds: [north.id, south.id], workspaceId: ridgeon.workspaceId, includeContacts: false }, PROVENANCE);
    assert.equal(result.message, "Moved 2 records to Mark Ridgeon.");
    const rows = await admin<{ workspace_id: string; company_id: string | null }>(
      "select workspace_id, company_id from crm.contacts where id = any($1::uuid[])",
      [[nia.id, ned.id, nat.id, sue.id, sid.id]],
    );
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.workspace_id === eclipse.workspaceId && row.company_id === null));
    const moved = await admin<{ workspace_id: string }>("select workspace_id from crm.companies where id = any($1::uuid[])", [[north.id, south.id]]);
    assert.ok(moved.every((row) => row.workspace_id === ridgeon.workspaceId));
    assert.deepEqual(await crossWorkspaceLinks(), []);
  });

  it("keeps today's behaviour for callers that don't send the new options", async () => {
    const legacy = await company(eclipse, "Legacy Co", { domain: "legacy-move.test" });
    const lou = await contact(eclipse, { firstName: "Lou", lastName: "Legacy", companyId: legacy.id });
    const lyn = await contact(eclipse, { firstName: "Lyn", lastName: "Legacy", companyId: legacy.id });
    const person = await getAdminPool().query<{ plan: { links: { id: string }[]; companies: unknown[]; includeCompany: boolean; includeContacts: boolean } }>(
      "select private.move_records_to_workspace($1, $2, $3, $4::jsonb, true) as plan",
      [eclipse.userId, eclipse.workspaceId, ridgeon.workspaceId, JSON.stringify({ contactIds: [lou.id] })],
    );
    const plan = person.rows[0].plan;
    assert.equal(plan.includeCompany, false);
    assert.equal(plan.includeContacts, true);
    assert.deepEqual(plan.links.map((item) => item.id), [legacy.id]);
    assert.deepEqual(plan.companies, []);
    const whole = await getAdminPool().query<{ plan: { contacts: { id: string }[] } }>(
      "select private.move_records_to_workspace($1, $2, $3, $4::jsonb, true) as plan",
      [eclipse.userId, eclipse.workspaceId, ridgeon.workspaceId, JSON.stringify({ companyIds: [legacy.id] })],
    );
    assert.deepEqual(whole.rows[0].plan.contacts.map((item) => item.id).sort(), [lou.id, lyn.id].sort());
  });

  it("shows what moves and what stays on the assistant card and the MCP dry run", async () => {
    const tool = toolDefinitions({ multiWorkspace: true }).find((item) => item.function.name === "move_records_to_workspace");
    const properties = (tool?.function.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok("includeCompany" in properties && "includeContacts" in properties);

    const orion = await company(eclipse, "Orion", { domain: "orion-move.test" });
    const ola = await contact(eclipse, { firstName: "Ola", lastName: "Orion", companyId: orion.id });
    await contact(eclipse, { firstName: "Oli", lastName: "Orion", companyId: orion.id });
    await createOpportunity(eclipse, { companyId: orion.id, name: "Orion deal", primaryContactId: ola.id }, { provenance: PROVENANCE });

    const apart = { toWorkspace: "Mark Ridgeon", companyIds: [orion.id], includeContacts: false };
    const card = describeAction("move_records_to_workspace", apart, await recordNames(eclipse, [apart], ["move_records_to_workspace"]));
    assert.ok(card.lines.includes("Goes with them: 1 opportunity"), card.lines.join(" / "));
    assert.ok(card.lines.includes("Stay here without a company: Ola Orion, Oli Orion"), card.lines.join(" / "));
    assert.ok(card.lines.includes("1 opportunity loses its main contact"), card.lines.join(" / "));
    const copyArgs = { ...apart, copy: true };
    const copyCard = describeAction("move_records_to_workspace", copyArgs, await recordNames(eclipse, [copyArgs], ["move_records_to_workspace"]));
    assert.ok(copyCard.lines.includes("Not copied: Ola Orion, Oli Orion"), copyCard.lines.join(" / "));

    const person = { toWorkspace: "Mark Ridgeon", contactIds: [ola.id] };
    const personCard = describeAction("move_records_to_workspace", person, await recordNames(eclipse, [person], ["move_records_to_workspace"]));
    assert.ok(personCard.lines.includes("Goes with them: 1 contact, 1 opportunity"), personCard.lines.join(" / "));
    assert.ok(personCard.lines.includes("Orion comes too"), personCard.lines.join(" / "));
    const aloneArgs = { ...person, includeCompany: false };
    const aloneCard = describeAction("move_records_to_workspace", aloneArgs, await recordNames(eclipse, [aloneArgs], ["move_records_to_workspace"]));
    assert.ok(aloneCard.lines.includes("Orion stays here, and a copy goes over"), aloneCard.lines.join(" / "));

    const server = createCrmMcpServer(eclipse, { workspaces: await moveTargets(eclipse) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "move-together-test", version: "1.0.0" });
    await client.connect(clientSide);
    const dry = (await client.callTool({
      name: "move_records_to_workspace",
      arguments: { to_workspace: "Mark Ridgeon", company_ids: [orion.id], include_contacts: false, dry_run: true },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!dry.isError, dry.content[0].text);
    const parsed = JSON.parse(dry.content[0].text) as { leftBehind: string[]; contacts: number; companyContacts: number };
    assert.deepEqual(parsed.leftBehind, ["Ola Orion", "Oli Orion"]);
    assert.equal(parsed.contacts, 0);
    assert.equal(parsed.companyContacts, 2);
    await client.close();

    const output = (await runTool(eclipse, "move_records_to_workspace", apart)) as { message?: string; error?: string; leftBehind?: { name: string }[] };
    assert.equal(output.error, undefined);
    assert.deepEqual(output.leftBehind?.map((item) => item.name), ["Ola Orion", "Oli Orion"]);
    const stayed = await admin<{ workspace_id: string; company_id: string | null }>("select workspace_id, company_id from crm.contacts where id = $1", [ola.id]);
    assert.deepEqual(stayed[0], { workspace_id: eclipse.workspaceId, company_id: null });
    assert.deepEqual(await crossWorkspaceLinks(), []);
  });

  it("takes a contact from another company who is named on a moving company's proposal", async () => {
    const lead = await company(eclipse, "Proposal Lead", { domain: "proposal-lead-move.test" });
    await contact(eclipse, { firstName: "Lia", lastName: "Lead", companyId: lead.id });
    const partner = await company(eclipse, "Partner Firm", { domain: "partner-firm-move.test" });
    const quinn = await contact(eclipse, { firstName: "Quinn", lastName: "Partner", companyId: partner.id });
    const colleague = await contact(eclipse, { firstName: "Quill", lastName: "Partner", companyId: partner.id });
    const document = await proposal(eclipse, lead.id, quinn.id, "Proposal signed by a partner");

    for (const includeContacts of [true, false]) {
      const preview = await previewMoveToWorkspace(eclipse, { companyIds: [lead.id], workspaceId: ridgeon.workspaceId, includeContacts });
      assert.deepEqual(preview.proposalContacts, ["Quinn Partner"]);
    }
    await moveRecordsToWorkspace(eclipse, { companyIds: [lead.id], workspaceId: ridgeon.workspaceId, includeContacts: false }, PROVENANCE);
    const moved = await admin<{ workspace_id: string; company_id: string | null }>("select workspace_id, company_id from crm.contacts where id = $1", [quinn.id]);
    assert.equal(moved[0].workspace_id, ridgeon.workspaceId);
    const linked = await admin<{ workspace_id: string; domain: string }>("select workspace_id, domain from crm.companies where id = $1", [moved[0].company_id]);
    assert.deepEqual(linked[0], { workspace_id: ridgeon.workspaceId, domain: "partner-firm-move.test" });
    const stays = await admin<{ workspace_id: string; company_id: string }>(
      "select workspace_id, company_id from crm.contacts where id = $1",
      [colleague.id],
    );
    assert.deepEqual(stays[0], { workspace_id: eclipse.workspaceId, company_id: partner.id });
    const row = await admin<{ workspace_id: string; contact_id: string }>("select workspace_id, contact_id from crm.documents where id = $1", [document]);
    assert.deepEqual(row[0], { workspace_id: ridgeon.workspaceId, contact_id: quinn.id });
    assert.deepEqual(await crossWorkspaceLinks(), []);
  });

  it("refuses to move a contact named on another company's proposal, and moves it when that company goes too", async () => {
    const home = await company(eclipse, "Kay Home", { domain: "kay-home-move.test" });
    await contact(eclipse, { firstName: "Kit", lastName: "Home", companyId: home.id });
    const kay = await contact(eclipse, { firstName: "Kay", lastName: "Lane", companyId: home.id });
    const tandem = await company(eclipse, "Tandem Partners", { domain: "tandem-partners-move.test" });
    const tod = await contact(eclipse, { firstName: "Tod", lastName: "Partner", companyId: tandem.id });
    const document = await proposal(eclipse, tandem.id, kay.id, "Q1 plan");
    const message = /^Kay Lane is named on the Tandem Partners proposal 'Q1 plan'\. Move Tandem Partners too, or change the proposal's contact first\.$/;

    for (const includeCompany of [false, true]) {
      const preview = await previewMoveToWorkspace(eclipse, { contactIds: [kay.id], workspaceId: ridgeon.workspaceId, includeCompany });
      assert.match(preview.proposalConflict ?? "", message);
      await assert.rejects(
        moveRecordsToWorkspace(eclipse, { contactIds: [kay.id], workspaceId: ridgeon.workspaceId, includeCompany }, PROVENANCE),
        refused("invalid_input", message),
      );
    }
    await admin("update crm.documents set archived_at = now() where id = $1", [document]);
    const archived = await previewMoveToWorkspace(eclipse, { contactIds: [kay.id], workspaceId: ridgeon.workspaceId });
    assert.equal(
      archived.proposalConflict,
      "Kay Lane is named on the archived Tandem Partners proposal 'Q1 plan'. Move Tandem Partners too, or change the proposal's contact first.",
    );
    await admin("update crm.documents set archived_at = null where id = $1", [document]);
    const copying = await previewMoveToWorkspace(eclipse, { contactIds: [kay.id], workspaceId: ridgeon.workspaceId, copy: true });
    assert.equal(copying.proposalConflict, null);
    const stayed = await admin<{ workspace_id: string }>("select workspace_id from crm.contacts where id = $1", [kay.id]);
    assert.equal(stayed[0].workspace_id, eclipse.workspaceId);
    assert.deepEqual(await crossWorkspaceLinks(), []);

    const together = await previewMoveToWorkspace(eclipse, { companyIds: [tandem.id], contactIds: [kay.id], workspaceId: ridgeon.workspaceId });
    assert.equal(together.proposalConflict, null);
    await moveRecordsToWorkspace(eclipse, { companyIds: [tandem.id], contactIds: [kay.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    const row = await admin<{ workspace_id: string; company_id: string; contact_id: string }>(
      "select workspace_id, company_id, contact_id from crm.documents where id = $1",
      [document],
    );
    assert.deepEqual(row[0], { workspace_id: ridgeon.workspaceId, company_id: tandem.id, contact_id: kay.id });
    const people = await admin<{ id: string; workspace_id: string }>("select id, workspace_id from crm.contacts where id = any($1::uuid[])", [[kay.id, tod.id]]);
    assert.ok(people.every((person) => person.workspace_id === ridgeon.workspaceId));
    assert.deepEqual(await crossWorkspaceLinks(), []);
  });

  it("moves a selected person with their company when the other contacts stay, counting archived ones", async () => {
    const mixed = await company(eclipse, "Mixed Co", { domain: "mixed-move.test" });
    const pia = await contact(eclipse, { firstName: "Pia", lastName: "Mixed", companyId: mixed.id });
    const quentin = await contact(eclipse, { firstName: "Quentin", lastName: "Mixed", companyId: mixed.id });
    const rae = await contact(eclipse, { firstName: "Rae", lastName: "Mixed", companyId: mixed.id });
    await admin("update crm.contacts set archived_at = now() where id = $1", [rae.id]);
    const account = await admin<{ id: string }>(
      "insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status) values ($1, $2, 'microsoft', 'mark@eclipse-move.test', 'disconnected') returning id",
      [eclipse.workspaceId, eclipse.userId],
    );
    const calendar = await admin<{ id: string }>(
      "insert into crm.calendars (workspace_id, user_id, account_id, provider_calendar_id, name, color) values ($1, $2, $3, 'mixed-cal', 'Work', '#3366ff') returning id",
      [eclipse.workspaceId, eclipse.userId, account[0].id],
    );
    const event = await admin<{ id: string }>(
      `insert into crm.calendar_events (workspace_id, user_id, calendar_id, account_id, provider_event_id, starts_at, ends_at, contact_ids, company_ids)
       values ($1, $2, $3, $4, 'mixed-event', now(), now() + interval '1 hour', $5::uuid[], $6::uuid[]) returning id`,
      [eclipse.workspaceId, eclipse.userId, calendar[0].id, account[0].id, [pia.id, quentin.id], [mixed.id]],
    );

    const request = { companyIds: [mixed.id], contactIds: [pia.id], workspaceId: ridgeon.workspaceId, includeContacts: false };
    const preview = await previewMoveToWorkspace(eclipse, request);
    assert.equal(preview.companyContacts, 2);
    assert.deepEqual(preview.names, ["Mixed Co", "Pia Mixed"]);
    assert.deepEqual(preview.leftBehind, ["Quentin Mixed", "Rae Mixed"]);
    assert.equal(preview.contacts, 0);

    const result = await moveRecordsToWorkspace(eclipse, request, PROVENANCE);
    assert.deepEqual(result.leftBehind.map((item) => item.name), ["Quentin Mixed", "Rae Mixed"]);
    const rows = await admin<{ first_name: string; workspace_id: string; company_id: string | null }>(
      "select first_name, workspace_id, company_id from crm.contacts where id = any($1::uuid[]) order by first_name",
      [[pia.id, quentin.id, rae.id]],
    );
    assert.deepEqual(rows, [
      { first_name: "Pia", workspace_id: ridgeon.workspaceId, company_id: mixed.id },
      { first_name: "Quentin", workspace_id: eclipse.workspaceId, company_id: null },
      { first_name: "Rae", workspace_id: eclipse.workspaceId, company_id: null },
    ]);
    const links = await admin<{ contact_ids: string[]; company_ids: string[] }>("select contact_ids, company_ids from crm.calendar_events where id = $1", [event[0].id]);
    assert.deepEqual(links[0], { contact_ids: [quentin.id], company_ids: [] });
    assert.deepEqual(await crossWorkspaceLinks(), []);
  });

  it("counts archived contacts in what a company takes with it", async () => {
    const archive = await company(eclipse, "Archive Co", { domain: "archive-count-move.test" });
    await contact(eclipse, { firstName: "Ari", lastName: "Archive", companyId: archive.id });
    const old = await contact(eclipse, { firstName: "Old", lastName: "Archive", companyId: archive.id });
    await admin("update crm.contacts set archived_at = now() where id = $1", [old.id]);
    const moving = await previewMoveToWorkspace(eclipse, { companyIds: [archive.id], workspaceId: ridgeon.workspaceId });
    assert.equal(moving.companyContacts, 2);
    assert.equal(moving.contacts, 2);
    const copying = await previewMoveToWorkspace(eclipse, { companyIds: [archive.id], workspaceId: ridgeon.workspaceId, copy: true });
    assert.equal(copying.companyContacts, 1);
    assert.equal(copying.contacts, 1);
  });

  it("turns timeouts, deadlocks and missed matches into messages a person can act on", () => {
    for (const code of ["57014", "40P01"]) {
      assert.throws(() => moveFailure({ code, message: "x" }, "Mark Ridgeon"), refused("timeout", /Move fewer records/));
    }
    assert.throws(() => moveFailure({ code: "23505", message: "x" }, "Mark Ridgeon"), refused("conflict", /Mark Ridgeon already has a matching record/));
  });

  it("passes database text through only when it was written for people", () => {
    assert.throws(() => moveFailure({ code: "42501", message: "forbidden" }, "Mark Ridgeon"), refused("forbidden", /^You don't have permission to do that\.$/));
    assert.throws(() => moveFailure({ code: "22023", message: "user required" }, "Mark Ridgeon"), refused("invalid_input", /^That isn't valid\.$/));
    assert.throws(() => moveFailure({ code: "22023", message: "Pick another workspace." }, "Mark Ridgeon"), refused("invalid_input", /^Pick another workspace\.$/));
  });
});
