import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { logActivity } from "@/lib/crm/activities";
import { archiveCompany, createCompany } from "@/lib/crm/companies";
import { archiveContact, createContact, updateContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { mergeCompanies, mergeContacts } from "@/lib/crm/merge";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { createUser, resetDatabase } from "./helpers";

const PROVENANCE = { operation: "merge_test", source: "test" };

let owner: UserActor;
let member: UserActor;
let outsider: UserActor;

async function admin<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const result = await getAdminPool().query<T>(text, values);
  return result.rows;
}

async function company(name: string, extra: Record<string, unknown> = {}) {
  return (await createCompany(owner, { name, ...extra }, { provenance: PROVENANCE })).body.company;
}

async function contact(input: Record<string, unknown>) {
  return (await createContact(owner, input, { provenance: PROVENANCE })).body.contact;
}

function isCrmError(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

before(async () => {
  await resetDatabase();
  owner = await createUser("owner@merge.test", "Olivia Owner");
  const second = await createUser("member@merge.test", "Max Member");
  await admin("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [
    owner.workspaceId,
    second.userId,
  ]);
  member = { ...second, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
  outsider = await createUser("outsider@merge.test", "Oscar Outsider");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("merging companies", () => {
  it("moves every reference to the kept company, fills gaps, unions tags and archives the duplicate", async () => {
    const keep = await company("Acme", { tags: ["client", "uk"] });
    const dupe = await company("Acme Ltd", {
      domain: "acme-merge.test",
      website: "https://acme-merge.test",
      industry: "Manufacturing",
      tags: ["uk", "priority"],
    });
    const other = await company("Elsewhere");
    const jane = await contact({ firstName: "Jane", lastName: "Doe", companyId: dupe.id });
    const sam = await contact({ firstName: "Sam", lastName: "Hill", companyId: dupe.id });
    const task = (await createTask(owner, { title: "Send pricing", companyId: dupe.id, contactId: jane.id }, { provenance: PROVENANCE })).body.task;
    const note = await logActivity(owner, { companyId: dupe.id, contactId: jane.id }, "note", "", "Intro call went well");
    const samNote = await logActivity(owner, { companyId: dupe.id, contactId: sam.id }, "note", "", "Sam asked for a deck");
    await updateContact(owner, sam.id, { companyId: other.id }, { provenance: PROVENANCE });
    const deal = (await createOpportunity(owner, { companyId: dupe.id, name: "Acme rollout", primaryContactId: jane.id }, { provenance: PROVENANCE })).body.opportunity;
    const [knowledge] = await admin<{ id: string }>(
      `insert into crm.knowledge_items (workspace_id, scope, company_id, kind, title)
       values ($1, 'company', $2, 'link', 'Acme deck') returning id`,
      [owner.workspaceId, dupe.id],
    );
    await admin("insert into crm.company_web_state (company_id, workspace_id, icp_score) values ($1, $2, 3)", [dupe.id, owner.workspaceId]);

    const result = await mergeCompanies(member, keep.id, dupe.id, PROVENANCE);

    assert.equal(result.kept.id, keep.id);
    assert.equal(result.kept.name, "Acme");
    assert.equal(result.kept.domain, "acme-merge.test");
    assert.equal(result.kept.website, "https://acme-merge.test/");
    assert.equal(result.kept.industry, "Manufacturing");
    assert.deepEqual(result.kept.tags, ["client", "uk", "priority"]);
    assert.ok(result.merged.archivedAt);
    assert.ok(result.filled.includes("domain"));
    assert.ok(result.filled.includes("industry"));
    assert.equal(result.moved.contacts, 1);
    assert.equal(result.moved.tasks, 1);
    assert.equal(result.moved.activities, 2);
    assert.equal(result.moved.opportunities, 1);
    assert.equal(result.moved.knowledge_items, 1);

    const [moved] = await admin<{ contact: string; task: string; note: string; sam_note: string; deal: string; knowledge: string; web: number }>(
      `select
         (select company_id::text from crm.contacts where id = $1) as contact,
         (select company_id::text from crm.tasks where id = $2) as task,
         (select company_id::text from crm.activities where id = $3) as note,
         (select company_id::text from crm.activities where id = $4) as sam_note,
         (select company_id::text from crm.opportunities where id = $5) as deal,
         (select company_id::text from crm.knowledge_items where id = $6) as knowledge,
         (select count(*)::int from crm.company_web_state where company_id = $7) as web`,
      [jane.id, task.id, note.id, samNote.id, deal.id, knowledge.id, keep.id],
    );
    assert.deepEqual(moved, {
      contact: keep.id,
      task: keep.id,
      note: keep.id,
      sam_note: keep.id,
      deal: keep.id,
      knowledge: keep.id,
      web: 1,
    });
    const [sam2] = await admin<{ company_id: string }>("select company_id from crm.contacts where id = $1", [sam.id]);
    assert.equal(sam2.company_id, other.id);

    const [stillThere] = await admin<{ archived_at: Date | null }>("select archived_at from crm.companies where id = $1", [dupe.id]);
    assert.ok(stillThere.archived_at);

    const [audit] = await admin<{ changes: Record<string, unknown>; actor_user_id: string }>(
      "select changes, actor_user_id from crm.audit_events where event_type = 'company.merged' and entity_id = $1",
      [keep.id],
    );
    assert.equal(audit.actor_user_id, member.userId);
    assert.equal(audit.changes.mergedId, dupe.id);
    assert.equal(audit.changes.keptId, keep.id);
    assert.equal(audit.changes.webState, "moved");
    assert.deepEqual((audit.changes.moved as Record<string, string[]>).tasks, [task.id]);
    assert.deepEqual((audit.changes.counts as Record<string, number>).activities, 2);
    assert.deepEqual(((audit.changes.before as Record<string, Record<string, unknown>>).kept).tags, ["client", "uk"]);
    assert.equal(((audit.changes.before as Record<string, Record<string, unknown>>).kept).domain, null);
    assert.ok((audit.changes.filled as string[]).includes("website"));
  });

  it("keeps the kept company's web state when both have one", async () => {
    const keep = await company("Globex");
    const dupe = await company("Globex Systems");
    await admin("insert into crm.company_web_state (company_id, workspace_id, icp_score) values ($1, $3, 4), ($2, $3, 1)", [
      keep.id,
      dupe.id,
      owner.workspaceId,
    ]);
    await mergeCompanies(owner, keep.id, dupe.id, PROVENANCE);
    const rows = await admin<{ company_id: string; icp_score: number }>(
      "select company_id, icp_score from crm.company_web_state where company_id = any($1::uuid[]) order by icp_score",
      [[keep.id, dupe.id]],
    );
    assert.deepEqual(rows, [
      { company_id: dupe.id, icp_score: 1 },
      { company_id: keep.id, icp_score: 4 },
    ]);
  });

  it("refuses a merge with itself, another workspace or an archived company", async () => {
    const keep = await company("Initech");
    const dupe = await company("Initech UK");
    const person = await contact({ firstName: "Pat", companyId: dupe.id });
    const foreign = (await createCompany(outsider, { name: "Initech" }, { provenance: PROVENANCE })).body.company;
    const archived = await company("Initech Old");
    await archiveCompany(owner, archived.id, { provenance: PROVENANCE });

    await assert.rejects(mergeCompanies(owner, keep.id, keep.id, PROVENANCE), isCrmError("invalid_input", /different company/));
    await assert.rejects(mergeCompanies(owner, keep.id, foreign.id, PROVENANCE), isCrmError("not_found", /isn't in this workspace/));
    await assert.rejects(mergeCompanies(owner, foreign.id, dupe.id, PROVENANCE), isCrmError("not_found"));
    await assert.rejects(mergeCompanies(owner, keep.id, archived.id, PROVENANCE), isCrmError("invalid_input", /Initech Old is already archived/));
    await assert.rejects(mergeCompanies(owner, archived.id, dupe.id, PROVENANCE), isCrmError("invalid_input", /Initech Old is archived/));

    const [unchanged] = await admin<{ company_id: string; archived_at: Date | null }>(
      "select p.company_id, c.archived_at from crm.contacts p join crm.companies c on c.id = $2 where p.id = $1",
      [person.id, dupe.id],
    );
    assert.equal(unchanged.company_id, dupe.id);
    assert.equal(unchanged.archived_at, null);
  });

  it("only relaxes the company link check inside a merge", async () => {
    const here = await company("Umbrella");
    const there = await company("Umbrella Health");
    const person = await contact({ firstName: "Lee", companyId: there.id });
    const task = (await createTask(owner, { title: "Call Lee", companyId: there.id, contactId: person.id }, { provenance: PROVENANCE })).body.task;
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.userId, role: "authenticated" })]);
      await client.query("set local role authenticated");
      await client.query("select set_config('orbit.merging', 'on', true)");
      await assert.rejects(
        client.query("update crm.tasks set company_id = $1 where id = $2", [here.id, task.id]),
        /contact belongs to a different company/,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("merging contacts", () => {
  it("moves activity, tasks and deals to the kept person and keeps their email", async () => {
    const oldCo = await company("Old Co");
    const newCo = await company("New Co");
    const keep = await contact({ firstName: "Ann", email: "ann@newco-merge.test", companyId: newCo.id, tags: ["vip"] });
    const dupe = await contact({
      firstName: "Ann",
      lastName: "Lee",
      email: "ann@oldco-merge.test",
      phone: "+44 20 7946 0000",
      jobTitle: "CTO",
      companyId: oldCo.id,
      notes: "Met at the Leeds conference",
      tags: ["vip", "tech"],
    });
    const call = await logActivity(owner, { companyId: oldCo.id, contactId: dupe.id }, "call", "Discovery", "Talked through the roadmap");
    const task = (await createTask(owner, { title: "Follow up with Ann", contactId: dupe.id }, { provenance: PROVENANCE })).body.task;
    const deal = (await createOpportunity(owner, { companyId: oldCo.id, name: "Old Co pilot", primaryContactId: dupe.id }, { provenance: PROVENANCE })).body.opportunity;

    const result = await mergeContacts(member, keep.id, dupe.id, PROVENANCE);

    assert.equal(result.kept.email, "ann@newco-merge.test");
    assert.equal(result.kept.lastName, "Lee");
    assert.equal(result.kept.phone, "+44 20 7946 0000");
    assert.equal(result.kept.jobTitle, "CTO");
    assert.equal(result.kept.companyId, newCo.id);
    assert.deepEqual(result.kept.tags, ["vip", "tech"]);
    assert.match(result.kept.notes ?? "", /Met at the Leeds conference/);
    assert.match(result.kept.notes ?? "", /Other email: ann@oldco-merge\.test/);
    assert.ok(result.merged.archivedAt);
    assert.equal(result.moved.activities, 1);
    assert.equal(result.moved.tasks, 1);
    assert.equal(result.moved.opportunities, 1);

    const [moved] = await admin<{ call_contact: string; call_company: string; task: string; deal: string }>(
      `select
         (select contact_id::text from crm.activities where id = $1) as call_contact,
         (select company_id::text from crm.activities where id = $1) as call_company,
         (select contact_id::text from crm.tasks where id = $2) as task,
         (select primary_contact_id::text from crm.opportunities where id = $3) as deal`,
      [call.id, task.id, deal.id],
    );
    assert.deepEqual(moved, { call_contact: keep.id, call_company: oldCo.id, task: keep.id, deal: keep.id });

    const [audit] = await admin<{ changes: Record<string, unknown> }>(
      "select changes from crm.audit_events where event_type = 'contact.merged' and entity_id = $1",
      [keep.id],
    );
    assert.equal(audit.changes.mergedId, dupe.id);
    assert.deepEqual((audit.changes.moved as Record<string, string[]>).activities, [call.id]);
    assert.ok((audit.changes.filled as string[]).includes("notes"));
    assert.equal(((audit.changes.before as Record<string, Record<string, unknown>>).kept).notes, null);
  });

  it("takes the duplicate's email when the kept person has none", async () => {
    const keep = await contact({ firstName: "Bob", lastName: "Stone" });
    const dupe = await contact({ firstName: "Bob", email: "bob@merge.test" });
    const result = await mergeContacts(owner, keep.id, dupe.id, PROVENANCE);
    assert.equal(result.kept.email, "bob@merge.test");
    assert.equal(result.kept.notes, null);
    assert.ok(result.filled.includes("email"));
  });

  it("refuses a merge with itself, another workspace or an archived person", async () => {
    const keep = await contact({ firstName: "Cara" });
    const dupe = await contact({ firstName: "Cara", lastName: "Jones" });
    const foreign = (await createContact(outsider, { firstName: "Cara" }, { provenance: PROVENANCE })).body.contact;
    const archived = await contact({ firstName: "Old", lastName: "Cara" });
    await archiveContact(owner, archived.id, { provenance: PROVENANCE });

    await assert.rejects(mergeContacts(owner, keep.id, keep.id, PROVENANCE), isCrmError("invalid_input", /different person/));
    await assert.rejects(mergeContacts(owner, keep.id, foreign.id, PROVENANCE), isCrmError("not_found", /isn't in this workspace/));
    await assert.rejects(mergeContacts(owner, keep.id, archived.id, PROVENANCE), isCrmError("invalid_input", /Old Cara is already archived/));
    await assert.rejects(mergeContacts(owner, archived.id, dupe.id, PROVENANCE), isCrmError("invalid_input", /Old Cara is archived/));
    await assert.rejects(mergeContacts({ ...owner, scopes: ["crm:read"] }, keep.id, dupe.id, PROVENANCE), isCrmError("forbidden"));
  });
});
